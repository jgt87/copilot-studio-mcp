/**
 * Running pac as a second account.
 *
 * Tenant administration and agent making are usually different people: the
 * admin account works in the Power Platform admin centre, the maker account in
 * Copilot Studio. pac keeps one *active* auth profile per machine, so using
 * both means switching between them.
 *
 * `withPacProfile` selects a profile, runs the work, and puts the previous
 * active profile back. Calls are serialised, because the active profile is
 * machine-wide state that two concurrent tool calls would otherwise fight over.
 *
 * `CPS_ADMIN_PROFILE` names the profile the admin tools use when a call does
 * not name one; `CPS_PAC_PROFILE` does the same for everything else.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { parseAuthList, runPacRaw, type AuthProfile, type PacResult } from "./pacRun.js";
import { log } from "./log.js";

export interface ProfileSwitch {
  requested: string;
  previous: string | null;
  switched: boolean;
}

let queue: Promise<unknown> = Promise.resolve();
const activeOperation = new AsyncLocalStorage<{ profile: string | undefined; active: boolean }>();

export function hasPacProfileLock(): boolean {
  return activeOperation.getStore()?.active === true;
}

/** Serialise access to the machine-wide active profile. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export async function listProfiles(): Promise<AuthProfile[]> {
  const { result } = await withPacProfile(undefined, async () => {
    const r = await runPacRaw(["auth", "list"], { timeoutMs: 60_000 });
    return r.ok ? parseAuthList(r.stdout) : [];
  });
  return result;
}

export function adminProfileDefault(): string | undefined {
  return process.env.CPS_ADMIN_PROFILE || undefined;
}

export function makerProfileDefault(): string | undefined {
  return process.env.CPS_PAC_PROFILE || undefined;
}

function findProfile(profiles: AuthProfile[], wanted: string): AuthProfile | null {
  const q = wanted.trim().toLowerCase();
  return (
    profiles.find((p) => p.name.toLowerCase() === q) ??
    profiles.find((p) => String(p.index) === q) ??
    profiles.find((p) => (p.user ?? "").toLowerCase() === q) ??
    profiles.find((p) => p.name.toLowerCase().includes(q)) ??
    null
  );
}

async function select(profile: AuthProfile): Promise<void> {
  const r = await runPacRaw(["auth", "select", "--index", String(profile.index)], { timeoutMs: 60_000 });
  if (!r.ok) throw new Error(`could not select pac auth profile '${profile.name}': ${(r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(-2).join(" ")}`);
}

/**
 * Run `fn` with `profile` active, then restore the profile that was active
 * before. Without a profile name the work runs on the active profile and
 * nothing is switched.
 */
export async function withPacProfile<T>(profile: string | undefined, fn: () => Promise<T>): Promise<{ result: T; profile: ProfileSwitch | null }> {
  const enclosing = activeOperation.getStore();
  if (enclosing?.active) {
    if (profile && profile !== enclosing.profile) throw new Error("Cannot switch PAC profiles inside an active PAC operation.");
    return { result: await fn(), profile: null };
  }
  return serialize(async () => {
    const operation = { profile, active: true };
    try { return await activeOperation.run(operation, async () => {
      if (!profile) return { result: await fn(), profile: null };
      const profiles = await listProfiles();
      if (!profiles.length) throw new Error("No pac auth profiles on this machine. Create one in a terminal: pac auth create --environment <id> (and one for the admin account, with --name).");
      const target = findProfile(profiles, profile);
      if (!target) throw new Error(`No pac auth profile matches '${profile}'. Available: ${profiles.map((p) => `${p.name}${p.user ? ` (${p.user})` : ""}`).join(", ")}. cs_init lists them.`);
      const previous = profiles.find((p) => p.active) ?? null;
      const switched = !target.active;
      if (switched) {
        log(`pac auth: switching to profile '${target.name}'${previous ? ` (was '${previous.name}')` : ""}`);
        await select(target);
      }
      try {
        const result = await fn();
        return { result, profile: { requested: profile, previous: previous?.name ?? null, switched } };
      } finally {
        if (switched && previous) {
          try {
            await select(previous);
          } catch (err) {
            throw new Error(`Could not restore pac auth profile '${previous.name}': ${(err as Error).message}. Check the active profile before continuing.`);
          }
        }
      }
    }); } finally { operation.active = false; }
  });
}

/** `withPacProfile` around a single pac call. */
export async function runPacAs(profile: string | undefined, args: string[], options: Parameters<typeof runPacRaw>[1] = {}): Promise<PacResult> {
  const { result } = await withPacProfile(profile, () => runPacRaw(args, options));
  return result;
}
