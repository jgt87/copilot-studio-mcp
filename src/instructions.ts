/**
 * Instruction edits are shown before they are written.
 *
 * Instructions are the field where a wrong edit is expensive and quiet: the
 * agent keeps answering, only differently, and the change is a wall of prose
 * that no one-line summary describes. So a write to `instructions` (and to
 * `responseInstructions`, which is the same kind of prose) returns a preview
 * first - the changed lines in their context, the character count, and what is
 * left of the budget - and touches the file only on the next call, with
 * `confirm: true`. Adding instructions to an agent that has none has no
 * "current" side; the proposed text is shown in full instead.
 *
 * The 8000-character limit is the product's, not ours: Copilot Studio refuses
 * longer instructions, so an over-long edit is refused here, where the text is
 * still in front of the user, rather than at push time.
 *
 * Everything here is pure: `test/instructions.test.js` pins the modes, the
 * counting and the refusal text.
 */
import { createTwoFilesPatch } from "diff";

/** Copilot Studio's cap on the instructions field. */
export const INSTRUCTIONS_LIMIT = 8000;

/**
 * The cap on the response instructions - the portal's Settings > Responses >
 * "Response formatting" box. Far smaller than the main instructions and easy
 * to write past without noticing, which is why it is counted here too.
 * Observed in the product, not read from a schema.
 */
export const RESPONSE_INSTRUCTIONS_LIMIT = 500;

/** The prose fields: an edit to either is previewed, and both are capped. */
export const PREVIEWED_TEXT_FIELDS = ["instructions", "responseInstructions"] as const;
export type PreviewedField = (typeof PREVIEWED_TEXT_FIELDS)[number];

export const FIELD_LIMITS: Record<PreviewedField, number> = {
  instructions: INSTRUCTIONS_LIMIT,
  responseInstructions: RESPONSE_INSTRUCTIONS_LIMIT,
};

/** The cap on a field by the name a caller used, including the dot paths cs_update_settings takes. */
export function limitForField(field: string): number | null {
  const leaf = field.split(".").pop() ?? field;
  if (/^responseInstructions$/i.test(leaf)) return RESPONSE_INSTRUCTIONS_LIMIT;
  if (/^instructions$/i.test(leaf)) return INSTRUCTIONS_LIMIT;
  return null;
}

export interface TextStats {
  characters: number;
  lines: number;
}

/** add: there was nothing there. append: the old text is still the head of the new. */
export type ChangeMode = "add" | "replace" | "append";

export interface FieldPreview {
  field: string;
  mode: ChangeMode;
  identical: boolean;
  current: TextStats | null;
  proposed: TextStats;
  limit: number | null;
  remaining: number | null;
  overBy: number | null;
  withinLimit: boolean;
  /** Unified diff, three lines of context; the whole text when there is no current one. */
  diff: string;
  /** The full proposed text, for a mode with no useful "before" to diff against. */
  proposedText?: string;
}

export function textStats(s: string): TextStats {
  return { characters: s.length, lines: s === "" ? 0 : s.split(/\r?\n/).length };
}

export function changeMode(before: string, after: string): ChangeMode {
  if (!before.trim()) return "add";
  return after.startsWith(before.replace(/\s+$/, "")) && after.length > before.length ? "append" : "replace";
}

/**
 * The before/after of one prose field. `limit` is the cap that applies to it
 * (null for a field with no documented cap), and is reported whether or not it
 * is exceeded, because the count is half the point of the preview.
 */
export function previewField(field: string, before: string, after: string, limit: number | null = null): FieldPreview {
  const mode = changeMode(before, after);
  const chars = after.length;
  const over = limit !== null && chars > limit;
  return {
    field,
    mode,
    identical: before === after,
    current: mode === "add" ? null : textStats(before),
    proposed: textStats(after),
    limit,
    remaining: limit === null ? null : Math.max(0, limit - chars),
    overBy: over ? chars - limit : null,
    withinLimit: !over,
    diff: createTwoFilesPatch(`${field} (${mode === "add" ? "none" : "current"})`, `${field} (proposed)`, before, after, "", "", { context: 3 }),
    ...(mode === "add" ? { proposedText: after } : {}),
  };
}

export function limitRefusal(field: string, characters: number, limit = INSTRUCTIONS_LIMIT): string {
  return `${field} would be ${characters} characters; Copilot Studio allows ${limit}. Shorten it by ${characters - limit} characters and call again - the push would be rejected otherwise.`;
}

/** Read a value out of a document by dot path ("aISettings.model.modelNameHint"). */
export function valueAt(doc: Record<string, unknown> | null, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/** `changed` entries carry a suffix for the appending variants; the path is the head. */
export function changedPath(entry: string): string {
  return entry.replace(/\s*\(.*\)$/, "");
}

export interface AgentPreview {
  preview: true;
  needsConfirmation: true;
  file: string;
  changed: string[];
  instructions?: FieldPreview;
  responseInstructions?: FieldPreview;
  otherChanges: { field: string; current: unknown; proposed: unknown }[];
  blocked?: string;
  hint: string;
}

/**
 * Everything one `cs_update_agent` call would change, from the document before
 * the patch and the document after it. Building it from the two documents,
 * rather than from the patch, means the preview cannot drift from what the
 * appliers actually do.
 */
export function buildAgentPreview(o: { file: string; before: Record<string, unknown>; after: Record<string, unknown>; changed: string[] }): AgentPreview {
  const fields: Partial<Record<PreviewedField, FieldPreview>> = {};
  const other: { field: string; current: unknown; proposed: unknown }[] = [];
  const seen = new Set<string>();
  for (const entry of o.changed) {
    const path = changedPath(entry);
    if (seen.has(path)) continue;
    seen.add(path);
    if ((PREVIEWED_TEXT_FIELDS as readonly string[]).includes(path)) {
      const field = path as PreviewedField;
      fields[field] = previewField(field, (valueAt(o.before, path) as string) ?? "", (valueAt(o.after, path) as string) ?? "", FIELD_LIMITS[field]);
      continue;
    }
    other.push({ field: path, current: valueAt(o.before, path) ?? null, proposed: valueAt(o.after, path) ?? null });
  }
  const over = Object.values(fields).find((f) => !f.withinLimit);
  return {
    preview: true,
    needsConfirmation: true,
    file: o.file,
    changed: o.changed,
    ...fields,
    otherChanges: other,
    ...(over ? { blocked: limitRefusal(over.field, over.proposed.characters, over.limit ?? INSTRUCTIONS_LIMIT) } : {}),
    hint: over
      ? "Nothing was written. Shorten the text and call again."
      : "Nothing was written yet. Show the user the diff and the character count, ask them, and only then call again with the same arguments plus confirm: true.",
  };
}

/**
 * The same preview for one field read out of a document shape of its own
 * (cli-copilot keeps the instructions in settings.mcs.yml, under
 * configuration.agentSettings.instructions.segments).
 */
export function singleFieldPreview(o: { file: string; field: PreviewedField; before: string; after: string }): AgentPreview {
  const preview = previewField(o.field, o.before, o.after, FIELD_LIMITS[o.field]);
  return buildFrom(o.file, [o.field], { [o.field]: preview });
}

function buildFrom(file: string, changed: string[], fields: Partial<Record<PreviewedField, FieldPreview>>): AgentPreview {
  const over = Object.values(fields).find((f) => !f.withinLimit);
  return {
    preview: true,
    needsConfirmation: true,
    file,
    changed,
    ...fields,
    otherChanges: [],
    ...(over ? { blocked: limitRefusal(over.field, over.proposed.characters, over.limit ?? INSTRUCTIONS_LIMIT) } : {}),
    hint: over
      ? "Nothing was written. Shorten the text and call again."
      : "Nothing was written yet. Show the user the diff and the character count, ask them, and only then call again with the same arguments plus confirm: true.",
  };
}
