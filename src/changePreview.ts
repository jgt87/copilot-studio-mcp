/**
 * The user-facing shape of a captured change: which files, what the lines are
 * now and what they would become.
 *
 * A created file is shown in full (there is no "current" side to diff against,
 * and a new topic is forty lines); an edited one is shown as a unified diff so
 * the answer to "what is actually changing" is not buried in a file the user
 * has already read. Long diffs are cut, with the count kept honest, because a
 * tool result that fills the context is a preview nobody reads.
 */
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { CapturedWrite } from "./authoring/capture.js";

const MAX_LINES = 200;

export type ChangeAction = "create" | "modify" | "delete" | "copy" | "unchanged";

export interface FileChange {
  file: string;
  action: ChangeAction;
  lines: { before: number; after: number };
  characters: { before: number; after: number };
  /** Unified diff for an edit. */
  diff?: string;
  /** The whole proposed file, for one that does not exist yet. */
  content?: string;
  truncated?: boolean;
  copiedFrom?: string;
}

export interface ChangePreview {
  preview: true;
  needsConfirmation: true;
  tool: string;
  files: FileChange[];
  hint: string;
}

function lineCount(s: string | null): number {
  return !s ? 0 : s.split(/\r?\n/).length;
}

function clip(s: string): { text: string; truncated: boolean } {
  const lines = s.split(/\r?\n/);
  if (lines.length <= MAX_LINES) return { text: s, truncated: false };
  return { text: `${lines.slice(0, MAX_LINES).join("\n")}\n... ${lines.length - MAX_LINES} more line(s)`, truncated: true };
}

function actionOf(w: CapturedWrite): ChangeAction {
  if (w.copiedFrom) return "copy";
  if (w.after === null) return "delete";
  if (w.before === null) return "create";
  return w.before === w.after ? "unchanged" : "modify";
}

export function fileChange(w: CapturedWrite, root?: string): FileChange {
  const action = actionOf(w);
  const rel = (root ? path.relative(root, w.file) || path.basename(w.file) : w.file).split(path.sep).join("/");
  const base: FileChange = {
    file: rel.startsWith("..") ? w.file : rel,
    action,
    lines: { before: lineCount(w.before), after: lineCount(w.after) },
    characters: { before: w.before?.length ?? 0, after: w.after?.length ?? 0 },
    ...(w.copiedFrom ? { copiedFrom: w.copiedFrom } : {}),
  };
  if (action === "create") {
    const { text, truncated } = clip(w.after as string);
    return { ...base, content: text, ...(truncated ? { truncated } : {}) };
  }
  if (action === "modify") {
    const { text, truncated } = clip(createTwoFilesPatch(`${base.file} (current)`, `${base.file} (proposed)`, w.before as string, w.after as string, "", "", { context: 3 }));
    return { ...base, diff: text, ...(truncated ? { truncated } : {}) };
  }
  return base;
}

export function buildChangePreview(tool: string, writes: CapturedWrite[], root?: string): ChangePreview {
  const files = writes.map((w) => fileChange(w, root));
  const real = files.filter((f) => f.action !== "unchanged");
  return {
    preview: true,
    needsConfirmation: true,
    tool,
    files,
    hint: real.length
      ? `Nothing was written. Show the user what changes in ${real.map((f) => f.file).join(", ")}, ask them, and only then call ${tool} again with the same arguments plus confirm: true.`
      : "Nothing would change: the files already say this.",
  };
}
