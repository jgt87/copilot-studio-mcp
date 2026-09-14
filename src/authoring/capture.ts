/**
 * Capture mode: run an authoring call and collect the files it would write
 * instead of writing them.
 *
 * Every change to an agent is shown to the user before it is made, and the
 * honest way to show it is to let the tool do its work and intercept the
 * write - a second implementation that predicts what each tool would produce
 * drifts from the tools themselves within a release. So the authoring layer
 * writes through three funnels (`writeComponentFile`, `saveWithHeader`, and
 * the handful of direct `fs` calls in this folder), and each of them asks here
 * first. In capture mode the intended content is recorded with the file's
 * current content and nothing is written; the caller diffs the pair, shows it,
 * and runs the same call again with `confirm: true`, which does not capture.
 *
 * The capture is held in an AsyncLocalStorage rather than a module variable so
 * a concurrent tool call - MCP clients may have several in flight - cannot have
 * its writes swallowed by someone else's preview.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";

export interface CapturedWrite {
  file: string;
  /** The file as it is now; null when it does not exist yet. */
  before: string | null;
  /** The file as it would be; null for a deletion. */
  after: string | null;
  /** Set for a file copied in verbatim (uploaded knowledge), where a diff says nothing. */
  copiedFrom?: string;
}

const store = new AsyncLocalStorage<Map<string, CapturedWrite>>();

export function capturing(): boolean {
  return store.getStore() !== undefined;
}

function readIfExists(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Record what the file would become. Returns true when the caller must not write. */
export function captureWrite(file: string, content: string): boolean {
  return record(file, (before) => ({ file, before, after: content }));
}

/** Record a deletion. Returns true when the caller must not delete. */
export function captureDelete(file: string): boolean {
  return record(file, (before) => ({ file, before, after: null }));
}

/** Record a verbatim copy (knowledge uploads). Returns true when the caller must not copy. */
export function captureCopy(source: string, dest: string): boolean {
  return record(dest, (before) => ({ file: dest, before, after: null, copiedFrom: source }));
}

function record(file: string, build: (before: string | null) => CapturedWrite): boolean {
  const m = store.getStore();
  if (!m) return false;
  // A file written twice in one call keeps the content it started with.
  const before = m.has(file) ? (m.get(file) as CapturedWrite).before : readIfExists(file);
  m.set(file, build(before));
  return true;
}

/**
 * Read a file the way the caller expects it to be: in capture mode, a file the
 * call has just "written" reads back as that content. Handlers that read back
 * what they wrote (cs_add_topic returns the YAML it produced) work unchanged.
 */
export function readTextFile(file: string): string {
  const m = store.getStore();
  const captured = m?.get(file);
  if (captured) {
    if (captured.after === null) throw new Error(`${file} was removed`);
    return captured.after;
  }
  return fs.readFileSync(file, "utf8");
}

/** Run `body` with its writes captured. The body still returns its own result. */
export async function withCapture<T>(body: () => Promise<T> | T): Promise<{ result: T; writes: CapturedWrite[] }> {
  const m = new Map<string, CapturedWrite>();
  const result = await store.run(m, async () => await body());
  return { result, writes: [...m.values()] };
}
