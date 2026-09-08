/**
 * Tools: remaining pac commands.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */


import { errorMessage } from "../log.js";
import { PAC_COMMANDS, buildPacArgs, describeSpec, isAdminCommand, isMutating, redactArgs, secretValues, zodShapeFor } from "../pacCommands.js";
import { adminProfileDefault, makerProfileDefault, runPacAs } from "../pacProfile.js";
import { readOnlyMode, readOnlyRefusal } from "../policy.js";

import { dryRun, fail, pacSummary, server, text } from "./shared.js";

// ---- remaining pac commands (declarative wrappers, see pacCommands.ts) ------

for (const spec of PAC_COMMANDS) {
  server.registerTool(spec.tool, { title: spec.title, description: describeSpec(spec), inputSchema: zodShapeFor(spec) }, async (raw) => {
    const input = raw as Record<string, unknown>;
    try {
      const args = buildPacArgs(spec, input);
      const secrets = secretValues(spec, input);
      const shown = redactArgs(args, secrets);
      const profile = (input.profile as string | undefined) ?? (isAdminCommand(spec) ? adminProfileDefault() : makerProfileDefault());
      if (isMutating(spec, input)) {
        if (readOnlyMode()) return fail(readOnlyRefusal(`pac ${shown.join(" ")}`));
        if (!input.confirm) return dryRun(`pac ${shown.join(" ")}${profile ? ` (as pac auth profile '${profile}')` : ""}`, spec.note ? { note: spec.note } : {});
      }
      const r = await runPacAs(profile, args, { cwd: input.cwd as string | undefined, timeoutMs: ((input.timeoutSeconds as number | undefined) ?? (spec.timeoutMs ?? 600_000) / 1000) * 1000, redact: secrets });
      const summary = pacSummary(r);
      for (const s of secrets) for (const k of ["command", "stdout", "stderr"] as const) if (typeof summary[k] === "string") summary[k] = (summary[k] as string).split(s).join("***");
      return text({ ...summary, ...(profile ? { profile } : {}), ...(spec.note ? { note: spec.note } : {}) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  });
}
