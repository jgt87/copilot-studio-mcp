/**
 * The shape of a wrapped pac command: its spec type, its parameter type, and
 * the parameter fragments the spec files share (environment, async flags, the
 * solution export options).
 *
 * Kept apart from pacCommands.ts so the per-group spec files can import these
 * without a cycle back through the assembled table.
 */
import { z } from "zod";

export type ParamType = "string" | "boolean" | "number" | "string[]" | "boolstring";

export interface PacParam {
  /** The pac flag, e.g. `--templateFileName`. */
  flag: string;
  type: ParamType;
  description: string;
  required?: boolean;
  /** Arrays: repeat the flag per value (default) or pass one comma-joined value. */
  join?: "repeat" | "comma";
  /** Masked in logs, dry runs and results. */
  secret?: boolean;
  /** Allowed values for string params. */
  values?: readonly string[];
}

export interface PacCommandSpec {
  tool: string;
  title: string;
  description: string;
  command: readonly string[];
  params: Record<string, PacParam>;
  /** Changes a live environment (needs confirm); a function decides per input. */
  mutating: boolean | ((input: Record<string, unknown>) => boolean);
  timeoutMs?: number;
  /** Appended to every result: verification status or the portal step that remains. */
  note?: string;
  /**
   * pac waits for a person at the keyboard (it opens its own browser). The tool
   * still runs it, but only usefully with `background: true`, and it says so.
   */
  interactive?: boolean;
}

export const ENV: PacParam = { flag: "--environment", type: "string", description: "Environment id or URL; default: the environment of the active pac auth profile" };
export const ASYNC: Record<string, PacParam> = {
  async: { flag: "--async", type: "boolean", description: "Run the operation asynchronously" },
  maxAsyncWaitTime: { flag: "--max-async-wait-time", type: "number", description: "Max asynchronous wait time in minutes (default 60)" },
};
export const SOLUTION_EXPORT: Record<string, PacParam> = {
  include: { flag: "--include", type: "string", description: "Settings to include in the export (pac solution export --include values)" },
  packageType: { flag: "--packagetype", type: "string", values: ["Unmanaged", "Managed", "Both"], description: "Unmanaged, Managed or Both (default Both)" },
  localize: { flag: "--localize", type: "boolean", description: "Extract string resources into .resx files" },
  map: { flag: "--map", type: "string", description: "Mapping XML file for component folders" },
};
