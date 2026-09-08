/**
 * Question-shaped results.
 *
 * When a call cannot proceed because something has not been decided yet, a
 * plain error ("connectorId is required") tells the calling agent what is
 * wrong but not what to do, so it either guesses a value or hands the user a
 * technical message. `needsInput` returns the question instead: what is
 * missing, why, the real choices when the server can enumerate them, and the
 * tool that lists more.
 *
 * This is deliberately client-agnostic. MCP's own elicitation asks the client
 * to collect input, and clients support it unevenly; a structured result works
 * everywhere and stays useful in the clients that do support elicitation.
 *
 * The result is not an error: the call did nothing, and the agent is expected
 * to ask the user and call again.
 */
export interface NeedChoice {
  value: string;
  label?: string;
  detail?: string;
}

export interface NeedSpec {
  /** Argument that has to be decided, e.g. "connectorId". */
  argument: string;
  /** The question to put to the user, in plain words. */
  question: string;
  /** Why it cannot be guessed. */
  why?: string;
  choices?: NeedChoice[];
  /** Total matches when `choices` is a shortened list. */
  totalChoices?: number;
  /** Tool that lists or narrows the options. */
  moreWith?: string;
}

export interface NeedsInputResult {
  needsInput: true;
  tool: string;
  needs: NeedSpec[];
  /** What the agent should do, spelled out. */
  next: string;
}

const MAX_CHOICES = 25;

export function needsInput(tool: string, needs: NeedSpec[], next?: string): NeedsInputResult {
  const trimmed = needs.map((n) => {
    if (!n.choices || n.choices.length <= MAX_CHOICES) return n;
    return { ...n, choices: n.choices.slice(0, MAX_CHOICES), totalChoices: n.totalChoices ?? n.choices.length };
  });
  const single = trimmed.length === 1 ? trimmed[0] : null;
  return {
    needsInput: true,
    tool,
    needs: trimmed,
    next:
      next ??
      (single
        ? `Ask the user: ${single.question}${single.choices?.length ? " Offer the choices listed here rather than inventing values." : ""}${single.moreWith ? ` ${single.moreWith} lists more.` : ""} Then call ${tool} again with '${single.argument}'.`
        : `Ask the user the questions listed here, using the choices given rather than inventing values, then call ${tool} again with those arguments.`),
  };
}

/** Rank candidates by how well they match what the user said (exact, prefix, substring, then the rest). */
export function rankChoices<T>(items: T[], search: string | undefined, text: (item: T) => string): T[] {
  if (!search?.trim()) return items;
  const q = search.trim().toLowerCase();
  const score = (item: T): number => {
    const s = text(item).toLowerCase();
    if (s === q) return 0;
    if (s.startsWith(q)) return 1;
    if (s.includes(q)) return 2;
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length > 1 && words.every((w) => s.includes(w))) return 3;
    return 4;
  };
  return items
    .map((item, i) => ({ item, i, rank: score(item) }))
    .filter((x) => x.rank < 4)
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((x) => x.item);
}
