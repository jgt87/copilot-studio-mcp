/**
 * Tenant configuration backup: everything the Power Platform admin centre
 * shows, written to local files for reference, diffing and source control.
 *
 * Read-only. Every capture is isolated: one failure (a permission the account
 * lacks, a command an older pac does not have) is recorded as a note and the
 * rest of the backup still completes.
 *
 * Layout:
 *   backup.json                     manifest: when, who, what was captured, notes
 *   tenant/tenant-settings.json     pac admin list-tenant-settings (written by pac)
 *   tenant/<capture>.txt|.json      raw pac output, plus parsed rows where a parser exists
 *   environments/<name>/...         per environment: details, solutions, agents, connections, roles, backups
 */
import fs from "node:fs";
import path from "node:path";
import { parseCopilotList, runPac, type PacResult } from "./pac.js";
import { parseConnectionList, parseSolutionList } from "./solutions.js";
import { withPacProfile } from "./pacProfile.js";
import { errorMessage, log } from "./log.js";

export type PacRunner = (args: string[]) => Promise<PacResult>;

export interface EnvironmentTarget {
  id: string;
  name?: string;
  url?: string;
}

/** Optional Dataverse reads per environment, injected so the module stays offline-testable. */
export type DataverseReader = (env: EnvironmentTarget) => Promise<Record<string, unknown> | null>;

export interface BackupOptions {
  dir: string;
  /** pac auth profile to run as (the admin account). */
  profile?: string;
  /** Environments to detail; omit to use `listEnvironments`, or pass [] for tenant level only. */
  environments?: EnvironmentTarget[];
  maxEnvironments?: number;
  includeEnvironments?: boolean;
  includeBackups?: boolean;
  includeRoles?: boolean;
  dataverse?: DataverseReader | null;
  run?: PacRunner;
  now?: Date;
}

export interface CaptureResult {
  name: string;
  file: string | null;
  ok: boolean;
  rows: number | null;
  note?: string;
}

export interface BackupReport {
  dir: string;
  takenAt: string;
  profile: string | null;
  tenant: CaptureResult[];
  environments: { id: string; name: string | null; dir: string; captures: CaptureResult[] }[];
  notes: string[];
  files: number;
}

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function safeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "unnamed";
}

function writeText(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
}

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Run one pac command and store its output. `parse` turns the text into rows
 * that are written next to it as JSON, so the backup is both faithful and
 * usable.
 */
async function capture(
  run: PacRunner,
  dir: string,
  name: string,
  args: string[],
  opts: { parse?: (stdout: string) => unknown[]; expectFile?: string } = {},
): Promise<CaptureResult> {
  try {
    const r = await run(args);
    if (!r.ok) {
      const tail = (r.stderr || r.stdout).split(/\r?\n/).filter(Boolean).slice(-2).join(" ");
      return { name, file: null, ok: false, rows: null, note: `pac ${args.join(" ")} failed: ${tail}` };
    }
    if (opts.expectFile) {
      const exists = fs.existsSync(opts.expectFile);
      return { name, file: exists ? opts.expectFile : null, ok: exists, rows: null, ...(exists ? {} : { note: `pac reported success but did not write ${opts.expectFile}` }) };
    }
    const txt = path.join(dir, `${name}.txt`);
    writeText(txt, r.stdout.trim());
    let rows: number | null = null;
    if (opts.parse) {
      const parsed = opts.parse(r.stdout);
      rows = parsed.length;
      writeJson(path.join(dir, `${name}.json`), parsed);
    }
    return { name, file: txt, ok: true, rows };
  } catch (err) {
    return { name, file: null, ok: false, rows: null, note: errorMessage(err) };
  }
}

/** Tenant-level captures: settings, environments, DLP policies, service principals, groups, templates. */
async function captureTenant(run: PacRunner, dir: string, notes: string[]): Promise<CaptureResult[]> {
  const out: CaptureResult[] = [];
  const settingsFile = path.join(dir, "tenant-settings.json");
  fs.mkdirSync(dir, { recursive: true });
  out.push(await capture(run, dir, "tenant-settings", ["admin", "list-tenant-settings", "--settings-file", settingsFile], { expectFile: settingsFile }));
  out.push(await capture(run, dir, "environments", ["admin", "list"]));
  out.push(await capture(run, dir, "environment-groups", ["admin", "list-groups"]));
  out.push(await capture(run, dir, "service-principals", ["admin", "list-service-principal", "--max", "200"]));
  out.push(await capture(run, dir, "entra-applications", ["admin", "application", "list"]));
  out.push(await capture(run, dir, "app-templates", ["admin", "list-app-templates"]));
  out.push(await capture(run, dir, "operation-status", ["admin", "status"]));

  const policies = await capture(run, dir, "dlp-policies", ["admin", "dlp-policy", "list"]);
  out.push(policies);
  if (policies.ok && policies.file) {
    const ids = [...new Set((fs.readFileSync(policies.file, "utf8").match(GUID) ?? []).map((s) => s.toLowerCase()))];
    for (const id of ids.slice(0, 50)) {
      out.push(await capture(run, path.join(dir, "dlp-policies"), safeName(id), ["admin", "dlp-policy", "show", "--policy-name", id]));
    }
    if (ids.length > 50) notes.push(`${ids.length} DLP policies found; the first 50 were detailed`);
  }
  return out;
}

async function captureEnvironment(run: PacRunner, dir: string, env: EnvironmentTarget, o: BackupOptions): Promise<CaptureResult[]> {
  const ref = env.url ?? env.id;
  const out: CaptureResult[] = [];
  writeJson(path.join(dir, "environment.json"), env);
  out.push(await capture(run, dir, "details", ["env", "who", "--environment", ref]));
  out.push(await capture(run, dir, "solutions", ["solution", "list", "--environment", ref], { parse: (s) => parseSolutionList(s) }));
  out.push(await capture(run, dir, "agents", ["copilot", "list", "--environment", ref], { parse: (s) => parseCopilotList(s) }));
  out.push(await capture(run, dir, "connections", ["connection", "list", "--environment", ref], { parse: (s) => parseConnectionList(s) }));
  if (o.includeRoles !== false) out.push(await capture(run, dir, "security-roles", ["admin", "list-roles", "--environment", ref]));
  if (o.includeBackups !== false) out.push(await capture(run, dir, "backups", ["admin", "list-backups", "--environment", ref]));
  if (o.dataverse) {
    try {
      const reads = await o.dataverse(env);
      if (reads) {
        writeJson(path.join(dir, "dataverse.json"), reads);
        const rows = Object.values(reads).reduce<number>((n, v) => n + (Array.isArray(v) ? v.length : 0), 0);
        out.push({ name: "dataverse", file: path.join(dir, "dataverse.json"), ok: true, rows });
      } else {
        out.push({ name: "dataverse", file: null, ok: false, rows: null, note: "no cached Dataverse sign-in for this environment (run cs_login)" });
      }
    } catch (err) {
      out.push({ name: "dataverse", file: null, ok: false, rows: null, note: errorMessage(err) });
    }
  }
  return out;
}

/** Environment ids and names from `pac admin list` output (bracketed index, GUID, then the name). */
export function parseAdminEnvironments(stdout: string): EnvironmentTarget[] {
  const envs: EnvironmentTarget[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const id = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(line)?.[0];
    if (!id) continue;
    const url = /https?:\/\/\S+/.exec(line)?.[0];
    let name = line.slice(0, line.indexOf(id)).replace(/^\s*\[\d+\]\s*/, "").trim();
    if (!name) name = line.replace(id, "").replace(url ?? "", "").replace(/^\s*\[\d+\]\s*/, "").trim();
    envs.push({ id, name: name || undefined, ...(url ? { url } : {}) });
  }
  return envs;
}

export async function backupTenant(o: BackupOptions): Promise<BackupReport> {
  const dir = path.resolve(o.dir);
  const takenAt = (o.now ?? new Date()).toISOString();
  const notes: string[] = [];
  const baseRun: PacRunner = o.run ?? ((args) => runPac(args, { timeoutMs: 10 * 60_000 }));

  const { result, profile } = await withPacProfile(o.profile, async () => {
    const tenantDir = path.join(dir, "tenant");
    const tenant = await captureTenant(baseRun, tenantDir, notes);

    const environments: BackupReport["environments"] = [];
    if (o.includeEnvironments !== false) {
      let targets = o.environments;
      if (!targets) {
        const listed = tenant.find((c) => c.name === "environments");
        targets = listed?.file ? parseAdminEnvironments(fs.readFileSync(listed.file, "utf8")) : [];
        if (!targets.length) notes.push("no environments could be read from 'pac admin list'; pass them explicitly to detail them");
      }
      const max = o.maxEnvironments ?? 50;
      if (targets.length > max) {
        notes.push(`${targets.length} environments found; the first ${max} were captured (raise maxEnvironments)`);
        targets = targets.slice(0, max);
      }
      for (const env of targets) {
        const envDir = path.join(dir, "environments", safeName(env.name ?? env.id));
        log(`tenant backup: capturing environment ${env.name ?? env.id}`);
        environments.push({ id: env.id, name: env.name ?? null, dir: envDir, captures: await captureEnvironment(baseRun, envDir, env, o) });
      }
    }
    return { tenant, environments };
  });

  const files = countFiles(dir);
  const report: BackupReport = { dir, takenAt, profile: o.profile ?? null, tenant: result.tenant, environments: result.environments, notes, files };
  writeJson(path.join(dir, "backup.json"), { ...report, profileSwitch: profile });
  return report;
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return n;
}

/** One line per capture, for the tool result. */
export function summarizeBackup(r: BackupReport): Record<string, unknown> {
  const failed = [...r.tenant, ...r.environments.flatMap((e) => e.captures)].filter((c) => !c.ok);
  return {
    dir: r.dir,
    takenAt: r.takenAt,
    profile: r.profile,
    files: r.files,
    tenantCaptures: r.tenant.filter((c) => c.ok).map((c) => c.name),
    environments: r.environments.map((e) => ({ name: e.name ?? e.id, captured: e.captures.filter((c) => c.ok).map((c) => c.name), failed: e.captures.filter((c) => !c.ok).length })),
    skipped: failed.map((c) => `${c.name}: ${c.note ?? "failed"}`),
    notes: r.notes,
  };
}
