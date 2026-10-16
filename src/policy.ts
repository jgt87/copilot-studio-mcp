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
  "cs_delete_flow", // removes the workflow row
  "cs_run_flow", // the flow's actions run for real
  "cs_bind_flow_connection", // points a flow at a connection, and can switch it on
  "cs_admin_assign_users", // a roster of security-role grants in one environment
  "cs_block_org_agent", // blocks the agent for every user in the tenant
  "cs_reassign_org_agent", // changes package ownership in the M365 catalogue
  "cs_set_connector_consent_bypass", // admin switch on the agent: users stop being asked to consent to its connectors
] as const;

// Tenant administration writes (pac admin ...) are classified from PAC_COMMANDS below,
// so a new admin spec is covered without touching this list.

/**
 * Tools that write only for certain inputs. They stay registered in read-only
 * mode and refuse at call time, so their read-only use keeps working:
 * `cs_create_agent` still scaffolds locally without `environment`,
 * `cs_check_solution` still analyses a zip without `saveResults`,
 * `cs_pac` still runs read-only pac commands.
 */
const BESPOKE_CONDITIONAL_WRITES = [
  "cs_create_agent", // creates the agent only when 'environment' is passed
  "cs_pac", // gated inside the handler by the read-only command list
] as const;

/**
 * Local-only tools that still ask for confirmation because they destroy work
 * on disk. Read-only mode leaves them alone: they cannot touch the environment.
 */
export const LOCAL_DESTRUCTIVE_TOOLS: readonly string[] = ["cs_remove_component"];

/**
 * Local-only tools that show the change and wait for `confirm: true` because
 * the edit is prose a summary cannot describe: the agent's instructions. They
 * write nothing on the first call. Read-only mode leaves them alone.
 */
export const LOCAL_CONFIRM_TOOLS: readonly string[] = [
  // These two build the preview themselves: the instructions are prose, and the
  // character count against the product's 8000 is half of what the user needs.
  "cs_update_agent",
  "cs_generate_instructions",
  // For the rest the preview is the captured file writes (src/authoring/capture.ts),
  // which the registration wrapper in tools/shared.ts turns into a diff.
  "cs_add_topic",
  "cs_add_knowledge_source",
  "cs_add_tool",
  "cs_add_flow",
  "cs_add_trigger",
  "cs_add_variable",
  "cs_edit_topic",
  "cs_edit_tool",
  "cs_edit_knowledge",
  "cs_update_settings",
  // Already had its own confirm; the no-confirm path now shows the files it
  // would delete rather than only naming the component.
  "cs_remove_component",
];

/** Tools that declare their own confirm and build their own preview. */
const SELF_PREVIEW_TOOLS = ["cs_update_agent", "cs_generate_instructions", "cs_remove_component"];

/** The subset whose preview the registration wrapper builds from captured writes. */
export const CAPTURED_PREVIEW_TOOLS: readonly string[] = LOCAL_CONFIRM_TOOLS.filter((t) => !SELF_PREVIEW_TOOLS.includes(t));

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
