/**
 * Write policy: nothing reaches a live Copilot Studio environment without the
 * user's approval.
 *
 * Two layers.
 *  1. **Confirm contract.** Every tool that can change an environment returns a
 *     dry run describing what it would do until the caller passes
 *     `confirm: true`. The caller is expected to show that dry run to the user
 *     and act on their answer.
 *  2. **Read-only mode.** With `CPS_READ_ONLY` set, tools that always write are
 *     not registered at all, and tools that write only for certain inputs
 *     refuse those inputs. Authoring stays available: local YAML is still
 *     written, and the user pushes from a session without the lock.
 *
 * `test/policy.test.js` cross-checks these lists against the tools that
 * actually declare `confirm`, so a new mutating tool cannot slip past either
 * layer unnoticed.
 */
import { PAC_COMMANDS } from "./pacCommands.js";

/** Bespoke handlers (index.ts) that always reach a live environment. */
const BESPOKE_ALWAYS_WRITES = [
  "cs_push", // pac copilot push
  "cs_publish", // pac copilot publish / PvaPublish
  "cs_import_solution", // pac solution import
  "cs_deploy_solution", // import + publish in the target
  "cs_run_evaluation", // starts a run against the agent
  "cs_create_solution", // creates the solution
  "cs_delete_agent",
  "cs_delete_solution",
  "cs_set_flow_state", // statecode on the workflow row
  "cs_update_flow", // definition on the workflow row
  "cs_create_flow", // new workflow row
  "cs_run_flow", // the flow's actions run for real
] as const;

// Tenant administration writes (pac admin ...) are classified from PAC_COMMANDS below,
// so a new admin spec is covered without touching this list.

/**
 * Tools that write only for certain inputs. They stay registered in read-only
 * mode and refuse at call time, so their read-only use keeps working:
 * `cs_init_agent` still scaffolds locally without `environment`,
 * `cs_check_solution` still analyses a zip without `saveResults`,
 * `cs_pac` still runs read-only pac commands.
 */
const BESPOKE_CONDITIONAL_WRITES = [
  "cs_init_agent", // creates the agent only when 'environment' is passed
  "cs_pac", // gated inside the handler by the read-only command list
] as const;

/**
 * Local-only tools that still ask for confirmation because they destroy work
 * on disk. Read-only mode leaves them alone: they cannot touch the environment.
 */
export const LOCAL_DESTRUCTIVE_TOOLS: readonly string[] = ["cs_remove_component"];

/** Tools that always change a live environment; hidden entirely in read-only mode. */
export const ENVIRONMENT_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  ...BESPOKE_ALWAYS_WRITES,
  ...PAC_COMMANDS.filter((s) => s.mutating === true).map((s) => s.tool),
]);

/** Tools that change an environment for some inputs only; refused per call in read-only mode. */
export const CONDITIONAL_WRITE_TOOLS: ReadonlySet<string> = new Set<string>([
  ...BESPOKE_CONDITIONAL_WRITES,
  ...PAC_COMMANDS.filter((s) => typeof s.mutating === "function").map((s) => s.tool),
]);

export function readOnlyMode(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.CPS_READ_ONLY ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false" && v !== "no";
}

export function readOnlyRefusal(what: string): string {
  return `Refused: CPS_READ_ONLY is set, so this server cannot change a live Copilot Studio environment (${what}). Local authoring, validation and read-only tools still work; unset CPS_READ_ONLY in the MCP server configuration to allow writes, which then still require confirm: true.`;
}

/** True when this input of a conditionally-writing tool would reach the environment. */
export function conditionalWriteBlocked(tool: string, wouldWrite: boolean, env: Record<string, string | undefined> = process.env): boolean {
  return wouldWrite && CONDITIONAL_WRITE_TOOLS.has(tool) && readOnlyMode(env);
}

/** Tools hidden by read-only mode, for the startup log and cs_init. */
export function hiddenByReadOnly(env: Record<string, string | undefined> = process.env): string[] {
  return readOnlyMode(env) ? [...ENVIRONMENT_WRITE_TOOLS].sort() : [];
}
