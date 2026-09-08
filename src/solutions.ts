/**
 * Solution-level ALM on top of `pac solution ...`: list, export, unpack,
 * inventory, deployment settings, pack, import. This is the vehicle for
 * "pull everything in a solution" and "redeploy 1:1 into another environment";
 * per-agent sync (`pac copilot clone/push`) stays bound to its source
 * environment and is not used for cross-environment moves.
 */
import fs from "node:fs";
import path from "node:path";
import { explainFailure, runPac, type PacResult } from "./pac.js";

// ---------------------------------------------------------------------------
// pac solution list / pac connection list parsers
// ---------------------------------------------------------------------------

export interface SolutionRow {
  uniqueName: string;
  friendlyName: string;
  version: string;
  isManaged: boolean;
}

export function parseSolutionList(stdout: string): SolutionRow[] {
  const rows: SolutionRow[] = [];
  const re = /^\s*(\S+)\s+(.+?)\s+(\d+(?:\.\d+)+)\s+(True|False)\s*$/;
  for (const line of stdout.split(/\r?\n/)) {
    const m = re.exec(line);
    if (!m) continue;
    rows.push({ uniqueName: m[1], friendlyName: m[2].trim(), version: m[3], isManaged: m[4] === "True" });
  }
  return rows;
}

export interface ConnectionRow {
  connectionId: string;
  connectorId: string | null;
  name: string | null;
  raw: string;
}

const GUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/** Rows of `pac connection list`, anchored on the connection id GUID; other columns are kept raw. */
export function parseConnectionList(stdout: string): ConnectionRow[] {
  const rows: ConnectionRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const g = GUID_RE.exec(line);
    if (!g) continue;
    const connector = /shared_[a-z0-9_]+/i.exec(line)?.[0] ?? null;
    const before = line.slice(0, g.index).trim();
    const after = line.slice(g.index + g[0].length).trim();
    const name = before || after.split(/\s{2,}/)[0] || null;
    rows.push({ connectionId: g[0], connectorId: connector, name: name && name !== connector ? name : null, raw: line.trim() });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// pac wrappers
// ---------------------------------------------------------------------------

function envArgs(environment?: string): string[] {
  return environment ? ["--environment", environment] : [];
}

function assertOk(r: PacResult): PacResult {
  if (!r.ok) throw new Error(`${r.command} failed: ${explainFailure(r)}`);
  return r;
}

export async function listSolutions(environment?: string, includeSystem = false): Promise<{ solutions: SolutionRow[]; pac: PacResult }> {
  const r = assertOk(await runPac(["solution", "list", ...envArgs(environment), ...(includeSystem ? ["--includeSystemSolutions"] : [])], { timeoutMs: 180_000 }));
  return { solutions: parseSolutionList(r.stdout), pac: r };
}

export async function listConnections(environment?: string): Promise<{ connections: ConnectionRow[]; pac: PacResult }> {
  const r = assertOk(await runPac(["connection", "list", ...envArgs(environment)], { timeoutMs: 180_000 }));
  return { connections: parseConnectionList(r.stdout), pac: r };
}

export interface ExportOptions {
  name: string;
  zipPath: string;
  environment?: string;
  managed?: boolean;
  overwrite?: boolean;
  /** Settings to include, e.g. ["general","customization"]; passed to --include. */
  include?: string[];
}

export async function exportSolution(o: ExportOptions): Promise<PacResult> {
  fs.mkdirSync(path.dirname(o.zipPath), { recursive: true });
  const args = ["solution", "export", "--name", o.name, "--path", o.zipPath, ...envArgs(o.environment), "--async"];
  if (o.managed) args.push("--managed");
  if (o.overwrite !== false) args.push("--overwrite");
  if (o.include?.length) args.push("--include", o.include.join(","));
  return assertOk(await runPac(args, { timeoutMs: 60 * 60_000 }));
}

export type PackageType = "Unmanaged" | "Managed" | "Both";

export async function unpackSolution(zipPath: string, folder: string, packagetype: PackageType = "Unmanaged"): Promise<PacResult> {
  fs.mkdirSync(folder, { recursive: true });
  return assertOk(await runPac(["solution", "unpack", "--zipfile", zipPath, "--folder", folder, "--packagetype", packagetype, "--allowWrite", "--allowDelete", "--clobber"], { timeoutMs: 10 * 60_000 }));
}

export async function packSolution(folder: string, zipPath: string, packagetype: "Unmanaged" | "Managed" = "Unmanaged"): Promise<PacResult> {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  return assertOk(await runPac(["solution", "pack", "--zipfile", zipPath, "--folder", folder, "--packagetype", packagetype], { timeoutMs: 10 * 60_000 }));
}

export interface ImportOptions {
  zipPath: string;
  environment?: string;
  settingsFile?: string;
  publishChanges?: boolean;
  forceOverwrite?: boolean;
  activatePlugins?: boolean;
  skipLowerVersion?: boolean;
  stageAndUpgrade?: boolean;
  maxAsyncWaitMinutes?: number;
}

export async function importSolution(o: ImportOptions): Promise<PacResult> {
  const args = ["solution", "import", "--path", o.zipPath, ...envArgs(o.environment), "--async"];
  if (o.settingsFile) args.push("--settings-file", o.settingsFile);
  if (o.publishChanges !== false) args.push("--publish-changes");
  if (o.forceOverwrite) args.push("--force-overwrite");
  if (o.activatePlugins !== false) args.push("--activate-plugins");
  if (o.skipLowerVersion) args.push("--skip-lower-version");
  if (o.stageAndUpgrade) args.push("--stage-and-upgrade");
  if (o.maxAsyncWaitMinutes) args.push("--max-async-wait-time", String(o.maxAsyncWaitMinutes));
  return assertOk(await runPac(args, { timeoutMs: 90 * 60_000 }));
}

// ---------------------------------------------------------------------------
// Deployment settings (connection references + environment variables)
// ---------------------------------------------------------------------------

/**
 * Shape written by `pac solution create-settings` (pac 2.11.2). Extra fields
 * (DefaultValue, Name, TypeId, IsRequired, ...) are preserved verbatim; the
 * CopilotAgents section carries the Entra security group that controls who can
 * use each agent in the target environment.
 */
export interface DeploymentSettings {
  EnvironmentVariables: ({ SchemaName: string; Value: string } & Record<string, unknown>)[];
  ConnectionReferences: ({ LogicalName: string; ConnectionId: string; ConnectorId: string } & Record<string, unknown>)[];
  CopilotAgents?: ({ Name: string; AadGroupId: string } & Record<string, unknown>)[];
  [extra: string]: unknown;
}

export const EMPTY_GUID = "00000000-0000-0000-0000-000000000000";

export async function createDeploymentSettings(source: { zipPath?: string; folder?: string }, settingsFile: string): Promise<DeploymentSettings> {
  const args = ["solution", "create-settings", "--settings-file", settingsFile];
  if (source.zipPath) args.push("--solution-zip", source.zipPath);
  else if (source.folder) args.push("--solution-folder", source.folder);
  else throw new Error("zipPath or folder is required");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  assertOk(await runPac(args, { timeoutMs: 5 * 60_000 }));
  return readDeploymentSettings(settingsFile);
}

export function readDeploymentSettings(file: string): DeploymentSettings {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as DeploymentSettings;
  raw.EnvironmentVariables = raw.EnvironmentVariables ?? [];
  raw.ConnectionReferences = raw.ConnectionReferences ?? [];
  return raw;
}

export interface SettingsValues {
  connectionReferences?: Record<string, string>;
  environmentVariables?: Record<string, string>;
  /** agent schema name -> Entra security group id allowed to use the agent in the target */
  copilotAgents?: Record<string, string>;
}

export function applyDeploymentSettings(file: string, values: SettingsValues): { settings: DeploymentSettings; applied: string[]; unknown: string[] } {
  const settings = readDeploymentSettings(file);
  const applied: string[] = [];
  const unknown: string[] = [];
  for (const [logical, id] of Object.entries(values.connectionReferences ?? {})) {
    const e = settings.ConnectionReferences.find((c) => c.LogicalName === logical);
    if (e) {
      e.ConnectionId = id;
      applied.push(logical);
    } else unknown.push(logical);
  }
  for (const [schema, value] of Object.entries(values.environmentVariables ?? {})) {
    const e = settings.EnvironmentVariables.find((v) => v.SchemaName === schema);
    if (e) {
      e.Value = value;
      applied.push(schema);
    } else unknown.push(schema);
  }
  for (const [name, group] of Object.entries(values.copilotAgents ?? {})) {
    const e = (settings.CopilotAgents ?? []).find((a) => a.Name === name);
    if (e) {
      e.AadGroupId = group;
      applied.push(name);
    } else unknown.push(name);
  }
  fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { settings, applied, unknown };
}

export interface Unmapped {
  connectionReferences: string[];
  environmentVariables: string[];
  /** Agents whose AadGroupId is still the empty GUID; informational, import proceeds. */
  copilotAgentsWithoutGroup: string[];
}

export function unmappedSettings(s: DeploymentSettings): Unmapped {
  return {
    connectionReferences: s.ConnectionReferences.filter((c) => !c.ConnectionId).map((c) => `${c.LogicalName} (${c.ConnectorId.split("/").pop()})`),
    environmentVariables: s.EnvironmentVariables.filter((v) => !v.Value && !v.DefaultValue).map((v) => v.SchemaName),
    copilotAgentsWithoutGroup: (s.CopilotAgents ?? []).filter((a) => !a.AadGroupId || a.AadGroupId === EMPTY_GUID).map((a) => a.Name),
  };
}

// ---------------------------------------------------------------------------
// Inventory of an unpacked solution folder
// ---------------------------------------------------------------------------

export interface SolutionInventory {
  folder: string;
  uniqueName: string | null;
  friendlyName: string | null;
  version: string | null;
  managed: boolean | null;
  publisher: { uniqueName: string | null; prefix: string | null };
  agents: { schemaName: string; name: string | null; authenticationMode: number | null; template: string | null; recognizer: string | null; authoringModel: string | null; componentCount: number }[];
  botComponents: { schemaName: string; name: string | null; parentBot: string | null; componentType: number | null; kind: string | null; description: string | null }[];
  flows: { workflowId: string | null; name: string | null; jsonFile: string | null; category: string | null; state: string | null }[];
  connectionReferences: { logicalName: string; displayName: string | null; connectorId: string | null }[];
  environmentVariables: { schemaName: string; displayName: string | null; type: string | null; defaultValue: string | null; currentValue: string | null }[];
  customConnectors: string[];
  otherFolders: { folder: string; files: number }[];
  missingDependencies: number;
}

const ENV_VAR_TYPES: Record<string, string> = {
  "100000000": "String",
  "100000001": "Number",
  "100000002": "Boolean",
  "100000003": "JSON",
  "100000004": "DataSource",
  "100000005": "Secret",
};

const COMPONENT_TYPES: Record<number, string> = { 0: "Topic (v1)", 9: "Topic", 15: "Agent (GPT)", 16: "Knowledge / file", 17: "External trigger" };

export function componentTypeLabel(t: number | null): string {
  if (t === null) return "unknown";
  return COMPONENT_TYPES[t] ?? `componenttype ${t}`;
}

function tag(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([^<]*)</${name}>`, "i").exec(xml);
  return m ? m[1].trim() : null;
}

function attr(xml: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`, "i").exec(xml);
  return m ? m[1] : null;
}

function readIf(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch {
    return null;
  }
}

function listDirs(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function countFiles(dir: string): number {
  let n = 0;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name));
      else n++;
    }
  };
  try {
    walk(dir);
  } catch {
    // ignore
  }
  return n;
}

type Agent = SolutionInventory["agents"][number];

/** Solution.xml: identity, version, publisher and the count of unmet dependencies. */
function readSolutionHeader(solutionXml: string): Pick<SolutionInventory, "uniqueName" | "friendlyName" | "version" | "managed" | "publisher" | "missingDependencies"> {
  const manifest = /<SolutionManifest>([\s\S]*?)<\/SolutionManifest>/i.exec(solutionXml)?.[1] ?? solutionXml;
  const publisherXml = /<Publisher>([\s\S]*?)<\/Publisher>/i.exec(manifest)?.[1] ?? "";
  const managed = tag(manifest, "Managed");
  return {
    // The publisher block carries a UniqueName of its own; drop it before reading the solution's.
    uniqueName: tag(manifest.replace(publisherXml, ""), "UniqueName"),
    friendlyName: /<LocalizedName description="([^"]*)"/i.exec(manifest)?.[1] ?? null,
    version: tag(manifest, "Version"),
    managed: managed === null ? null : managed === "1",
    publisher: { uniqueName: tag(publisherXml, "UniqueName"), prefix: tag(publisherXml, "CustomizationPrefix") },
    missingDependencies: (solutionXml.match(/<MissingDependency\b/gi) ?? []).length,
  };
}

/** bots/<schema>/: bot.xml for the identity, configuration.json for the harness. */
function readAgents(folder: string): Agent[] {
  return listDirs(path.join(folder, "bots")).map((schema) => {
    const xml = readIf(path.join(folder, "bots", schema, "bot.xml")) ?? "";
    let recognizer: string | null = null;
    let authoringModel: string | null = null;
    try {
      const cfg = JSON.parse(readIf(path.join(folder, "bots", schema, "configuration.json")) ?? "{}") as Record<string, unknown>;
      recognizer = ((cfg.recognizer as Record<string, unknown> | undefined)?.$kind as string) ?? null;
      authoringModel = (cfg.authoringModel as string) ?? null;
    } catch {
      // ignore
    }
    const am = tag(xml, "authenticationmode");
    return {
      schemaName: attr(xml, "schemaname") ?? schema,
      name: tag(xml, "name"),
      authenticationMode: am === null ? null : Number(am),
      template: tag(xml, "template"),
      recognizer,
      authoringModel,
      componentCount: 0,
    };
  });
}

/** botcomponents/<schema>/: botcomponent.xml plus the `data` YAML the kind comes from. */
function readBotComponents(folder: string): SolutionInventory["botComponents"] {
  return listDirs(path.join(folder, "botcomponents")).map((schema) => {
    const dir = path.join(folder, "botcomponents", schema);
    const xml = readIf(path.join(dir, "botcomponent.xml")) ?? "";
    const dataFile = fs.existsSync(path.join(dir, "data")) ? path.join(dir, "data") : fs.readdirSync(dir).map((f) => path.join(dir, f)).find((f) => /data/i.test(path.basename(f))) ?? null;
    const data = dataFile ? (readIf(dataFile) ?? "") : "";
    const ct = tag(xml, "componenttype");
    return {
      schemaName: attr(xml, "schemaname") ?? schema,
      name: tag(xml, "name"),
      parentBot: /<parentbotid>[\s\S]*?<schemaname>([^<]*)<\/schemaname>/i.exec(xml)?.[1] ?? null,
      componentType: ct === null ? null : Number(ct),
      kind: /^kind:\s*(\S+)/m.exec(data)?.[1] ?? null,
      description: tag(xml, "description"),
    };
  });
}

/** Cloud flows: the `<Workflow>` entries of Customizations.xml, or the JSON files when there are none. */
function readFlows(folder: string, customizations: string): SolutionInventory["flows"] {
  const flows: SolutionInventory["flows"] = [];
  for (const m of customizations.matchAll(/<Workflow\b([^>]*)>([\s\S]*?)<\/Workflow>/gi)) {
    const attrs = m[1];
    const body = m[2];
    flows.push({
      workflowId: attr(attrs, "WorkflowId")?.replace(/[{}]/g, "") ?? null,
      name: attr(attrs, "Name"),
      jsonFile: tag(body, "JsonFileName"),
      category: tag(body, "Category") === "5" ? "Modern flow" : tag(body, "Category"),
      state: tag(body, "StateCode") === "1" ? "Activated" : tag(body, "StateCode") === "0" ? "Draft" : tag(body, "StateCode"),
    });
  }
  if (flows.length) return flows;
  const wfDir = path.join(folder, "Workflows");
  for (const f of fs.existsSync(wfDir) ? fs.readdirSync(wfDir).filter((f) => f.endsWith(".json")) : []) {
    flows.push({ workflowId: GUID_RE.exec(f)?.[0] ?? null, name: f.replace(/-[0-9a-f-]{36}\.json$/i, ""), jsonFile: `/Workflows/${f}`, category: null, state: null });
  }
  return flows;
}

/** The `<connectionreference>` entries of Customizations.xml. */
function readConnectionReferences(customizations: string): SolutionInventory["connectionReferences"] {
  return [...customizations.matchAll(/<connectionreference\b([^>]*)>([\s\S]*?)<\/connectionreference>/gi)].map((m) => ({
    logicalName: attr(m[1], "connectionreferencelogicalname") ?? "",
    displayName: tag(m[2], "connectionreferencedisplayname"),
    connectorId: tag(m[2], "connectorid") ?? tag(m[2], "customconnectorid"),
  }));
}

/** environmentvariabledefinitions/<schema>/: the definition, plus the last value found beside it. */
function readEnvironmentVariables(folder: string): SolutionInventory["environmentVariables"] {
  const evDir = path.join(folder, "environmentvariabledefinitions");
  return listDirs(evDir).map((schema) => {
    const xml = readIf(path.join(evDir, schema, "environmentvariabledefinition.xml")) ?? "";
    let currentValue: string | null = null;
    const valDir = path.join(evDir, schema, "environmentvariablevalues");
    for (const v of listDirs(valDir)) {
      const vx = readIf(path.join(valDir, v, "environmentvariablevalue.xml")) ?? "";
      currentValue = tag(vx, "value") ?? currentValue;
    }
    const type = tag(xml, "type");
    return {
      schemaName: attr(xml, "schemaname") ?? schema,
      displayName: /<displayname default="([^"]*)"/i.exec(xml)?.[1] ?? null,
      type: type ? (ENV_VAR_TYPES[type] ?? type) : null,
      defaultValue: tag(xml, "defaultvalue"),
      currentValue,
    };
  });
}

/** Connectors/<name>.xml, one custom connector each. */
function readCustomConnectors(folder: string): string[] {
  const connDir = path.join(folder, "Connectors");
  if (!fs.existsSync(connDir)) return [];
  return fs.readdirSync(connDir).filter((f) => f.endsWith(".xml")).map((f) => f.replace(/\.xml$/i, ""));
}

const KNOWN_FOLDERS = new Set(["bots", "botcomponents", "Other", "Workflows", "environmentvariabledefinitions", "Connectors"]);

/** Everything this inventory does not read, so the caller knows what it is not seeing. */
function readOtherFolders(folder: string): SolutionInventory["otherFolders"] {
  return listDirs(folder)
    .filter((d) => !KNOWN_FOLDERS.has(d))
    .map((d) => ({ folder: d, files: countFiles(path.join(folder, d)) }));
}

export function inventorySolutionFolder(folder: string): SolutionInventory {
  const customizations = readIf(path.join(folder, "Other", "Customizations.xml")) ?? "";
  const agents = readAgents(folder);
  const botComponents = readBotComponents(folder);
  for (const c of botComponents) {
    const agent = agents.find((a) => a.schemaName === c.parentBot);
    if (agent) agent.componentCount++;
  }
  const header = readSolutionHeader(readIf(path.join(folder, "Other", "Solution.xml")) ?? "");
  return {
    folder,
    uniqueName: header.uniqueName,
    friendlyName: header.friendlyName,
    version: header.version,
    managed: header.managed,
    publisher: header.publisher,
    agents,
    botComponents,
    flows: readFlows(folder, customizations),
    connectionReferences: readConnectionReferences(customizations),
    environmentVariables: readEnvironmentVariables(folder),
    customConnectors: readCustomConnectors(folder),
    otherFolders: readOtherFolders(folder),
    missingDependencies: header.missingDependencies,
  };
}

export function summarizeInventory(inv: SolutionInventory): Record<string, unknown> {
  return {
    solution: { uniqueName: inv.uniqueName, friendlyName: inv.friendlyName, version: inv.version, managed: inv.managed, publisher: inv.publisher, missingDependencies: inv.missingDependencies },
    counts: {
      agents: inv.agents.length,
      botComponents: inv.botComponents.length,
      flows: inv.flows.length,
      connectionReferences: inv.connectionReferences.length,
      environmentVariables: inv.environmentVariables.length,
      customConnectors: inv.customConnectors.length,
    },
    agents: inv.agents.map((a) => ({
      ...a,
      harness: a.authoringModel === "CliCopilot" ? "github-copilot" : "standard",
      components: inv.botComponents.filter((c) => c.parentBot === a.schemaName).reduce<Record<string, number>>((acc, c) => {
        const k = c.kind ?? componentTypeLabel(c.componentType);
        acc[k] = (acc[k] ?? 0) + 1;
        return acc;
      }, {}),
    })),
    flows: inv.flows,
    connectionReferences: inv.connectionReferences,
    environmentVariables: inv.environmentVariables,
    customConnectors: inv.customConnectors,
    otherFolders: inv.otherFolders,
  };
}

// ---------------------------------------------------------------------------
// Pull manifest written by cs_pull_solution and read by cs_deploy_solution
// ---------------------------------------------------------------------------

export interface PullManifest {
  solution: string;
  sourceEnvironment: string | null;
  pulledAt: string;
  packagetype: PackageType;
  exports: { unmanaged: string | null; managed: string | null };
  srcFolder: string;
  settingsFile: string | null;
  agents: { schemaName: string; name: string | null; workspace: string | null; cloneError: string | null }[];
}

export const MANIFEST_FILE = "solution.json";

export function writeManifest(dir: string, m: PullManifest): string {
  const file = path.join(dir, MANIFEST_FILE);
  fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n", "utf8");
  return file;
}

export function readManifest(dir: string): PullManifest | null {
  const file = path.join(dir, MANIFEST_FILE);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as PullManifest;
}
