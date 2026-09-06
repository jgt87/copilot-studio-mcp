/**
 * Optional tool filter so a client with a small context window (or a user
 * who only authors) can expose a subset of the tools:
 *
 *   CPS_TOOLS=cs_doctor,cs_describe_workspace,cs_add_*,cs_edit_*   allow-list
 *   CPS_TOOLS_EXCLUDE=cs_*_solution,cs_pipeline_*                  deny-list
 *
 * Comma-separated tool names; `*` matches any run of characters. The allow-list
 * applies first (empty means everything), then the deny-list.
 */
export function parsePatterns(value: string | undefined): RegExp[] {
  return (value ?? "")
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
