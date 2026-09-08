/**
 * Tools: environment comparison.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import path from "node:path";
import { z } from "zod";


import { errorMessage } from "../log.js";

import { captureSnapshot, compareChain, compareSnapshots, writeReport } from "../compare.js";
import { clientArg, dataverseReadsFor, fail, server, tenantArg, text } from "./shared.js";

// ---- environment comparison (DTAP) -----------------------------------------


const snapshotArgs = {
  solution: z.string().optional().describe("Solution unique name to record version/managed state for"),
  agents: z.array(z.string()).optional().describe("Agent schema names or ids to clone; default: every agent pac copilot list returns"),
  maxAgents: z.number().optional().describe("Default 20"),
  includeDataverse: z.boolean().optional().describe("Default true: flows, connection references, environment variables and publish state via Dataverse (needs cs_login; skipped silently otherwise)"),
  tenantId: tenantArg,
  clientId: clientArg,
};

server.registerTool(
  "cs_snapshot_environment",
  {
    title: "Snapshot an environment",
    description: "Capture one environment into a folder for comparison or history: solution version, every agent cloned with pac copilot clone (agents/<name>), and, when signed in, flows, connection references, environment variables and publish state. Read-only for the environment.",
    inputSchema: { label: z.string().describe("Short name such as DEV, TEST, ACC, PROD"), environment: z.string().describe("Environment id or URL"), dir: z.string().describe("Snapshot folder (recreated)"), ...snapshotArgs },
  },
  async (a) => {
    try {
      const dv = a.includeDataverse === false ? { reads: null, note: null } : await dataverseReadsFor(a.environment, a.tenantId, a.clientId);
      const snap = await captureSnapshot({ label: a.label, environment: a.environment, dir: a.dir, solution: a.solution, agents: a.agents, maxAgents: a.maxAgents, dataverse: dv.reads });
      if (dv.note) snap.notes.push(dv.note);
      return text({ dir: path.resolve(a.dir), label: snap.label, solution: snap.solutionRow, agents: snap.agents.map(({ workspace, ...x }) => ({ ...x, workspace: workspace ? path.relative(path.resolve(a.dir), workspace) : null })), captured: { flows: snap.flows?.length ?? null, connectionReferences: snap.connectionReferences?.length ?? null, environmentVariables: snap.environmentVariables?.length ?? null }, notes: snap.notes });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_compare_snapshots",
  {
    title: "Compare two snapshots",
    description: "Offline diff of two snapshot folders: solution version, per-agent YAML differences (noise such as ids, audit info and connection ids removed), flows, connection references, environment variables, unpublished changes. Writes <reportDir>/<a>-vs-<b>.md and .json. failOnDrift returns an error result when drift is found (for pipeline gates).",
    inputSchema: { a: z.string().describe("Snapshot folder (earlier stage, e.g. DEV)"), b: z.string().describe("Snapshot folder (later stage, e.g. TEST)"), reportDir: z.string().optional().describe("Default: parent of b"), includeDiffs: z.boolean().optional().describe("Default true: unified diffs in the report"), strictVariables: z.boolean().optional().describe("Treat differing environment variable values as drift"), ignoredKeys: z.array(z.string()).optional(), failOnDrift: z.boolean().optional() },
  },
  async (a) => {
    try {
      const report = compareSnapshots(a.a, a.b, { includeDiffs: a.includeDiffs, strictVariables: a.strictVariables, ignoredKeys: a.ignoredKeys });
      const out = writeReport(a.reportDir ?? path.dirname(path.resolve(a.b)), `${report.a.label}-vs-${report.b.label}`, report);
      const payload = { drift: report.drift, driftSummary: report.driftSummary, expectedDifferences: report.expectedDifferences, solution: report.solution, agents: report.agents.map((x) => ({ schemaName: x.schemaName, status: x.status, changedFiles: x.changedFiles, files: x.files.map((f) => `${f.status}: ${f.path}`), publish: x.publish })), flows: report.flows, connectionReferences: report.connectionReferences, environmentVariables: report.environmentVariables, notes: report.notes, report: out };
      if (a.failOnDrift && report.drift) return { ...text(payload), isError: true as const };
      return text(payload);
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_compare_environments",
  {
    title: "Compare a DTAP chain",
    description: "Snapshot every environment in an ordered chain (e.g. DEV, TEST, ACC, PROD) and compare each adjacent pair. Returns one report per pair plus the first stage where drift appears. Snapshots go to <dir>/<label>, reports to <dir>/reports.",
    inputSchema: { chain: z.array(z.object({ label: z.string(), environment: z.string() })).min(2), dir: z.string(), includeDiffs: z.boolean().optional(), strictVariables: z.boolean().optional(), failOnDrift: z.boolean().optional(), ...snapshotArgs },
  },
  async (a) => {
    try {
      const dirs: string[] = [];
      const captured: Record<string, unknown>[] = [];
      for (const stage of a.chain) {
        const dir = path.join(a.dir, stage.label);
        const dv = a.includeDataverse === false ? { reads: null, note: null } : await dataverseReadsFor(stage.environment, a.tenantId, a.clientId);
        const snap = await captureSnapshot({ label: stage.label, environment: stage.environment, dir, solution: a.solution, agents: a.agents, maxAgents: a.maxAgents, dataverse: dv.reads });
        if (dv.note) snap.notes.push(dv.note);
        dirs.push(dir);
        captured.push({ label: stage.label, agents: snap.agents.length, cloneErrors: snap.agents.filter((x) => x.cloneError).length, notes: snap.notes });
      }
      const reports = compareChain(dirs, { includeDiffs: a.includeDiffs, strictVariables: a.strictVariables });
      const written = reports.map((r) => writeReport(path.join(a.dir, "reports"), `${r.a.label}-vs-${r.b.label}`, r));
      const firstDrift = reports.find((r) => r.drift);
      const payload = {
        drift: Boolean(firstDrift),
        firstDriftBetween: firstDrift ? `${firstDrift.a.label} -> ${firstDrift.b.label}` : null,
        stages: captured,
        pairs: reports.map((r, i) => ({ pair: `${r.a.label} -> ${r.b.label}`, drift: r.drift, driftSummary: r.driftSummary, expectedDifferences: r.expectedDifferences, report: written[i].markdown })),
      };
      if (a.failOnDrift && firstDrift) return { ...text(payload), isError: true as const };
      return text(payload);
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
