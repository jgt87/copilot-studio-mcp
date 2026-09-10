/**
 * Which topic, tool and knowledge source an activity is attributed to.
 *
 * Copilot Studio hangs this off an activity's `channelData`, and the same
 * activities reach this server two ways: live from DirectLine (`cs_chat`) and
 * stored in Dataverse (`conversationtranscripts`). Both readers use this
 * module, so there is one place to correct when a shape is confirmed against a
 * live tenant.
 *
 * UNVERIFIED. The key names below come from the published channel documentation
 * and from transcript rows, not from a live capture, so each accessor accepts
 * every casing and nesting seen in the docs rather than assuming one.
 * `docs/test-verification.md` is the runbook that settles which are real; treat
 * an empty attribution as "not observed", never as "the tool did not run".
 */

/** Anything with string-keyed fields: a DirectLine Activity or a stored transcript row. */
export type AttributableActivity = Record<string, unknown>;

export interface ActivityAttribution {
  topic: string | null;
  tool: string | null;
  /** Knowledge sources cited on this activity, by title or URL. */
  citations: string[];
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The channel data Copilot Studio attaches, whichever casing it used. */
export function channelDataOf(a: AttributableActivity): Record<string, unknown> {
  return obj(a.channelData ?? a.ChannelData);
}

/** The topic or dialog this activity belongs to. */
export function topicOf(a: AttributableActivity): string | null {
  const cd = channelDataOf(a);
  return str(cd.topicName) ?? str(cd.TopicName) ?? str(obj(cd.enclosingScope).topicName) ?? str(obj(cd.enclosingScope).TopicName) ?? null;
}

/** The tool, action or connector call this activity records. */
export function toolOf(a: AttributableActivity): string | null {
  const cd = channelDataOf(a);
  return str(cd.actionName) ?? str(cd.ActionName) ?? str(cd.toolName) ?? str(cd.ToolName) ?? null;
}

/**
 * Knowledge sources cited on this activity.
 *
 * The least certain of the three: generative answers have carried citations as
 * schema.org entities and as a channelData array in different releases, so both
 * are read and the results merged.
 */
export function citationsOf(a: AttributableActivity): string[] {
  const found: string[] = [];
  const take = (entry: unknown) => {
    const e = obj(entry);
    const appearance = obj(e.appearance);
    const name = str(e.name) ?? str(e.title) ?? str(appearance.name) ?? str(appearance.text) ?? str(e.url) ?? str(appearance.url);
    if (name) found.push(name);
  };
  for (const entity of Array.isArray(a.entities) ? a.entities : []) {
    const e = obj(entity);
    const citation = e.citation ?? e.Citation;
    if (Array.isArray(citation)) citation.forEach(take);
  }
  const cd = channelDataOf(a);
  const cited = cd.citations ?? cd.Citations;
  if (Array.isArray(cited)) cited.forEach(take);
  return [...new Set(found)];
}

export function attributionOf(a: AttributableActivity): ActivityAttribution {
  return { topic: topicOf(a), tool: toolOf(a), citations: citationsOf(a) };
}

/** Every distinct topic named across these activities, in the order first seen. */
export function invokedTopics(activities: AttributableActivity[]): string[] {
  return [...new Set(activities.map(topicOf).filter((t): t is string => t !== null))];
}

/** Every distinct tool named across these activities, in the order first seen. */
export function invokedTools(activities: AttributableActivity[]): string[] {
  return [...new Set(activities.map(toolOf).filter((t): t is string => t !== null))];
}

/** Every distinct knowledge source cited across these activities. */
export function invokedCitations(activities: AttributableActivity[]): string[] {
  return [...new Set(activities.flatMap(citationsOf))];
}

/**
 * Whether an observed name satisfies an expected one: equal or containing it,
 * ignoring case. Forgiving on purpose, because a transcript may report a tool
 * by a qualified name ("contoso_orderLookup.Run") where the test names the tool
 * ("orderLookup"), and a test that fails on qualification teaches nothing.
 */
export function nameMatches(observed: string, expected: string): boolean {
  const o = observed.toLowerCase();
  const e = expected.trim().toLowerCase();
  return o === e || o.includes(e);
}

/** The expected names that nothing in `observed` matches. */
export function missingNames(observed: string[], expected: string[]): string[] {
  return expected.filter((e) => !observed.some((o) => nameMatches(o, e)));
}

/** The expected names that something in `observed` does match. */
export function presentNames(observed: string[], expected: string[]): string[] {
  return expected.filter((e) => observed.some((o) => nameMatches(o, e)));
}
