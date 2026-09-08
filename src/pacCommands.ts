/**
 * Declarative wrappers for the pac commands that have no bespoke tool of their
 * own. Each spec becomes one MCP tool: a typed schema built from `params`, the
 * confirm contract for anything that changes an environment, secret redaction,
 * and the same result shape as the other pac-backed tools.
 *
 * The specs live in `pacSpecs/`, one file per pac command group; this module
 * assembles them in registration order and turns a spec into a schema, an argv
 * and a dry-run description. Groups outside Copilot Studio work (canvas, pcf,
 * plugin, pages, code, data, package, ...) stay reachable through `cs_pac`.
 */
import { z } from "zod";
import { type PacCommandSpec, type PacParam } from "./pacParams.js";

export { ASYNC, ENV, SOLUTION_EXPORT, type PacCommandSpec, type PacParam, type ParamType } from "./pacParams.js";

import { SPECS as copilotSpecs } from "./pacSpecs/copilot.js";
import { SPECS as solutionSpecs } from "./pacSpecs/solution.js";
import { SPECS as pipelineSpecs } from "./pacSpecs/pipeline.js";
import { SPECS as connectionSpecs } from "./pacSpecs/connection.js";
import { SPECS as authSpecs } from "./pacSpecs/auth.js";
import { SPECS as adminSpecs } from "./pacSpecs/admin.js";
import { SPECS as envSpecs } from "./pacSpecs/env.js";

/** Every wrapped pac command, in the order the tools are registered. */
export const PAC_COMMANDS: PacCommandSpec[] = [...copilotSpecs, ...solutionSpecs, ...pipelineSpecs, ...connectionSpecs, ...authSpecs, ...adminSpecs, ...envSpecs];

// ---------------------------------------------------------------------------
// From spec to argv / schema
// ---------------------------------------------------------------------------

function present(v: unknown): boolean {
  return v !== undefined && v !== null && v !== "";
}

/** True for the tenant-administration commands, which default to the admin profile. */
export function isAdminCommand(spec: PacCommandSpec): boolean {
  return spec.command[0] === "admin";
}

/** A list parameter: repeat the flag per value, or pass one comma-joined value. */
function listArgs(p: PacParam, value: unknown, where: string): string[] {
  const list = (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
  if (!list.length) {
    if (p.required) throw new Error(`${where} needs at least one value`);
    return [];
  }
  if (p.join === "comma") return [p.flag, list.join(",")];
  return list.flatMap((x) => [p.flag, x]);
}

/** The argv fragment one supplied parameter contributes. */
function paramArgs(p: PacParam, value: unknown, where: string): string[] {
  switch (p.type) {
    case "boolean":
      return value === true ? [p.flag] : [];
    case "boolstring":
      return [p.flag, value ? "true" : "false"];
    case "number":
      return [p.flag, String(value)];
    case "string[]":
      return listArgs(p, value, where);
    default: {
      const s = String(value);
      if (p.values && !p.values.includes(s)) throw new Error(`${where} must be one of ${p.values.join(", ")}`);
      return [p.flag, s];
    }
  }
}

export function buildPacArgs(spec: PacCommandSpec, input: Record<string, unknown>): string[] {
  const args = [...spec.command];
  for (const [key, p] of Object.entries(spec.params)) {
    const v = input[key];
    if (!present(v)) {
      if (p.required) throw new Error(`${spec.tool}: '${key}' is required (${p.flag})`);
      continue;
    }
    args.push(...paramArgs(p, v, `${spec.tool}: '${key}'`));
  }
  return args;
}

/** Values of secret params that were supplied, for masking. */
export function secretValues(spec: PacCommandSpec, input: Record<string, unknown>): string[] {
  return Object.entries(spec.params)
    .filter(([key, p]) => p.secret && present(input[key]))
    .map(([key]) => String(input[key]));
}

export function redactArgs(args: string[], secrets: string[]): string[] {
  return secrets.length ? args.map((a) => (secrets.includes(a) ? "***" : a)) : args;
}

export function isMutating(spec: PacCommandSpec, input: Record<string, unknown>): boolean {
  return typeof spec.mutating === "function" ? spec.mutating(input) : spec.mutating;
}

export function describeSpec(spec: PacCommandSpec): string {
  const confirm = spec.mutating === false ? "" : " Mutates a live environment: requires confirm: true (a dry run otherwise)." + (typeof spec.mutating === "function" ? " Only some inputs mutate; see the parameter descriptions." : "");
  return `${spec.description} Runs 'pac ${spec.command.join(" ")}' with the active pac auth profile.${confirm}`;
}

/** zod shape for the tool input: one field per param, plus cwd, timeoutSeconds and (when relevant) confirm. */
export function zodShapeFor(spec: PacCommandSpec): Record<string, z.ZodTypeAny> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, p] of Object.entries(spec.params)) {
    let base: z.ZodTypeAny;
    switch (p.type) {
      case "boolean":
      case "boolstring":
        base = z.boolean();
        break;
      case "number":
        base = z.number();
        break;
      case "string[]":
        base = z.array(z.string());
        break;
      default:
        base = p.values ? z.enum(p.values as [string, ...string[]]) : z.string();
    }
    const described = base.describe(p.description + (p.secret ? " (masked in logs and results)" : ""));
    shape[key] = p.required ? described : described.optional();
  }
  shape.profile = z.string().optional().describe("pac auth profile to run as: the admin account for tenant commands. Defaults to CPS_ADMIN_PROFILE for admin commands and CPS_PAC_PROFILE otherwise, then the active profile. cs_init lists the profiles.");
  shape.cwd = z.string().optional().describe("Working directory for pac (for project commands: the solution project folder)");
  shape.timeoutSeconds = z.number().optional().describe(`Default ${Math.round((spec.timeoutMs ?? 600_000) / 1000)}`);
  if (spec.mutating !== false) shape.confirm = z.boolean().optional().describe("Required to actually perform a change in a live environment. Without it the tool returns a dry run.");
  return shape;
}
