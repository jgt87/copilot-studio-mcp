/**
 * Optional tool filter so a client with a small context window (or a user
 * who only authors) can expose a subset of the tools:
 *
 *   CPS_TOOLS=core                                               named preset
 *   CPS_TOOLS=cs_init,cs_describe_workspace,cs_add_*,cs_edit_*   allow-list
 *   CPS_TOOLS_EXCLUDE=cs_*_solution,cs_pipeline_*                deny-list
 *
 * Comma-separated tool names, preset names, or globs where `*` matches any run
 * of characters. The allow-list applies first (empty means everything), then
 * the deny-list. Presets and globs can be mixed: `CPS_TOOLS=core,cs_admin_*`.
 *
 * Why presets exist: the full list is 131 tools and about 50k tokens of schema
 * before any work starts. A large model copes; a smaller one spends most of its
 * context on the menu and picks worse from it. `core` is the agent-building
 * loop and nothing else, and `cs_pac` is still there for anything it leaves out.
 */

/** Named subsets. Each entry is a glob accepted by `parsePatterns`. */
export const TOOL_PRESETS: Record<string, string[]> = {
  /** Everything. The default when CPS_TOOLS is unset. */
  full: ["*"],

  /** The loop that builds an agent and gets it live. Start here on a small model. */
  core: [
    "cs_init",
    "cs_guide",
    "cs_set_tool_preset",
    "cs_login",
    "cs_login_status",
    "cs_list_environments",
    "cs_list_agents",
    "cs_clone_agent",
    "cs_create_agent",
    "cs_describe_workspace",
    "cs_lookup_schema",
    "cs_validate",
    "cs_review_agent",
    "cs_add_topic",
    "cs_add_knowledge_source",
    "cs_add_tool",
    "cs_add_trigger",
    "cs_add_variable",
    "cs_edit_topic",
    "cs_edit_tool",
    "cs_edit_knowledge",
    "cs_remove_component",
    "cs_update_agent",
    "cs_update_settings",
    "cs_pull",
    "cs_push",
    "cs_publish",
    "cs_check_drift",
    "cs_chat",
    "cs_run_conversation_tests",
    "cs_list_connectors",
    "cs_describe_connector",
    "cs_job_status",
    "cs_pac",
  ],

  /** Local files only: no sign-in, nothing that reaches an environment. */
  authoring: [
    "cs_init",
    "cs_guide",
    "cs_set_tool_preset",
    "cs_describe_workspace",
    "cs_lookup_schema",
    "cs_validate",
    "cs_review_agent",
    "cs_add_*",
    "cs_edit_*",
    "cs_remove_component",
    "cs_update_agent",
    "cs_update_settings",
    "cs_build_flow_definition",
    "cs_create_test_set_csv",
    "cs_job_status",
  ],

  /** Tenant administration, for a session running as the admin account. */
  admin: ["cs_init", "cs_guide", "cs_set_tool_preset", "cs_admin_*", "cs_backup_tenant", "cs_list_auth_profiles", "cs_list_environments", "cs_job_status", "cs_pac"],

  /** Everything about moving solutions between environments. */
  solutions: ["cs_init", "cs_guide", "cs_set_tool_preset", "cs_list_solutions", "cs_describe_solution", "cs_*_solution", "cs_list_connections", "cs_snapshot_environment", "cs_compare_*", "cs_job_status", "cs_pac"],
};

export function presetNames(): string[] {
  return Object.keys(TOOL_PRESETS);
}

/** Expand any preset names in a comma-separated list; other entries pass through. */
export function expandPresets(value: string | undefined): string {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((entry) => TOOL_PRESETS[entry.toLowerCase()] ?? [entry])
    .join(",");
}

export function parsePatterns(value: string | undefined): RegExp[] {
  return expandPresets(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((glob) => new RegExp(`^${glob.split("*").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i"));
}

export function toolEnabled(name: string, env: Record<string, string | undefined> = process.env): boolean {
  const allow = parsePatterns(env.CPS_TOOLS);
  const deny = parsePatterns(env.CPS_TOOLS_EXCLUDE);
  if (allow.length && !allow.some((re) => re.test(name))) return false;
  return !deny.some((re) => re.test(name));
}

/** The preset in force, for cs_init and the startup log; null when the list is custom or unset. */
export function activePreset(env: Record<string, string | undefined> = process.env): string | null {
  const raw = (env.CPS_TOOLS ?? "").trim().toLowerCase();
  return raw && TOOL_PRESETS[raw] ? raw : null;
}

/** When to pick each preset, shown to the user by cs_init and cs_set_tool_preset. */
export const PRESET_WHEN: Record<string, string> = {
  full: "Everything. Use on a large model, or when you do not yet know what the task needs.",
  core: "Build or change one agent and get it live: clone or create, edit topics, knowledge and tools, validate, push, publish, chat. The usual choice.",
  authoring: "Write and check files only. No sign-in, and nothing can reach an environment. Use when the user wants to draft offline or is not ready to touch the tenant.",
  admin: "Tenant administration as an admin account: environments, DLP policies, security roles, tenant settings, and backing the configuration up to files.",
  solutions: "Move things between environments: pull a solution, map connections, deploy to test or production, compare two environments.",
};

/** The preset menu with a live count of what each would offer, given the tools this process registered. */
export function presetOptions(registered: string[]): { preset: string; offers: number; when: string }[] {
  return Object.keys(TOOL_PRESETS).map((preset) => {
    const patterns = parsePatterns(preset);
    return { preset, offers: registered.filter((name) => patterns.some((re) => re.test(name))).length, when: PRESET_WHEN[preset] ?? "" };
  });
}
