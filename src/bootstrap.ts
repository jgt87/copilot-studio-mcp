/**
 * Getting-started helpers: create a solution, create a new agent inside a
 * chosen solution, and generate the first instructions with an AI Builder
 * prompt. Everything runs through pac (no MSAL needed).
 */
import fs from "node:fs";
import { withPacProfile, makerProfileDefault, hasPacProfileLock } from "./pacProfile.js";
import path from "node:path";
import { explainFailure, runPac, type PacResult } from "./pac.js";
import { importSolution, packSolution, listSolutions, type SolutionRow } from "./solutions.js";
import { findWorkspaceRoot, readWorkspace } from "./workspace.js";
import { log, errorMessage } from "./log.js";

// ---------------------------------------------------------------------------
// Empty solution source (pack + import creates the solution and its publisher)
// ---------------------------------------------------------------------------

export interface SolutionSpec {
  uniqueName: string;
  displayName?: string;
  publisherPrefix: string;
  publisherName?: string;
  version?: string;
  /** 10000-99999; random when omitted */
  optionValuePrefix?: number;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ADDRESS = (n: number) => `        <Address>
          <AddressNumber>${n}</AddressNumber>
          <AddressTypeCode>1</AddressTypeCode>
          <City xsi:nil="true"></City>
          <County xsi:nil="true"></County>
          <Country xsi:nil="true"></Country>
          <Fax xsi:nil="true"></Fax>
          <FreightTermsCode xsi:nil="true"></FreightTermsCode>
          <ImportSequenceNumber xsi:nil="true"></ImportSequenceNumber>
          <Latitude xsi:nil="true"></Latitude>
          <Line1 xsi:nil="true"></Line1>
          <Line2 xsi:nil="true"></Line2>
          <Line3 xsi:nil="true"></Line3>
          <Longitude xsi:nil="true"></Longitude>
          <Name xsi:nil="true"></Name>
          <PostalCode xsi:nil="true"></PostalCode>
          <PostOfficeBox xsi:nil="true"></PostOfficeBox>
          <PrimaryContactName xsi:nil="true"></PrimaryContactName>
          <ShippingMethodCode>1</ShippingMethodCode>
          <StateOrProvince xsi:nil="true"></StateOrProvince>
          <Telephone1 xsi:nil="true"></Telephone1>
          <Telephone2 xsi:nil="true"></Telephone2>
          <Telephone3 xsi:nil="true"></Telephone3>
          <TimeZoneRuleVersionNumber xsi:nil="true"></TimeZoneRuleVersionNumber>
          <UPSZone xsi:nil="true"></UPSZone>
          <UTCOffset xsi:nil="true"></UTCOffset>
          <UTCConversionTimeZoneCode xsi:nil="true"></UTCConversionTimeZoneCode>
        </Address>`;

export function validatePrefix(prefix: string): void {
  if (!/^[a-z][a-z0-9]{1,7}$/.test(prefix)) throw new Error(`publisherPrefix '${prefix}' must be 2-8 lowercase letters/digits starting with a letter`);
}

export function solutionXml(spec: SolutionSpec): string {
  validatePrefix(spec.publisherPrefix);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(spec.uniqueName)) throw new Error(`uniqueName '${spec.uniqueName}' must be letters, digits and underscores, starting with a letter`);
  const display = xmlEscape(spec.displayName ?? spec.uniqueName);
  const publisher = xmlEscape(spec.publisherName ?? spec.publisherPrefix);
  const ovp = spec.optionValuePrefix ?? 10000 + Math.floor(Math.random() * 89999);
  return `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml version="9.2.26031.139" SolutionPackageVersion="9.2" languagecode="1033" generatedBy="CrmLive" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <SolutionManifest>
    <UniqueName>${xmlEscape(spec.uniqueName)}</UniqueName>
    <LocalizedNames>
      <LocalizedName description="${display}" languagecode="1033" />
    </LocalizedNames>
    <Descriptions />
    <Version>${xmlEscape(spec.version ?? "1.0.0.0")}</Version>
    <Managed>0</Managed>
    <Publisher>
      <UniqueName>${xmlEscape(spec.publisherPrefix)}</UniqueName>
      <LocalizedNames>
        <LocalizedName description="${publisher}" languagecode="1033" />
      </LocalizedNames>
      <Descriptions>
        <Description description="${publisher}" languagecode="1033" />
      </Descriptions>
      <EMailAddress xsi:nil="true"></EMailAddress>
      <SupportingWebsiteUrl xsi:nil="true"></SupportingWebsiteUrl>
      <CustomizationPrefix>${xmlEscape(spec.publisherPrefix)}</CustomizationPrefix>
      <CustomizationOptionValuePrefix>${ovp}</CustomizationOptionValuePrefix>
      <Addresses>
${ADDRESS(1)}
${ADDRESS(2)}
      </Addresses>
    </Publisher>
    <RootComponents />
    <MissingDependencies />
  </SolutionManifest>
</ImportExportXml>
`;
}

export const CUSTOMIZATIONS_XML = `<?xml version="1.0" encoding="utf-8"?>
<ImportExportXml xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Entities />
  <Roles />
  <Workflows />
  <FieldSecurityProfiles />
  <Templates />
  <EntityMaps />
  <EntityRelationships />
  <OrganizationSettings />
  <optionsets />
  <CustomControls />
  <EntityDataProviders />
  <Languages>
    <Language>1033</Language>
  </Languages>
</ImportExportXml>
`;

/** Write an unpacked solution folder containing only the manifest; `pac solution pack` turns it into an importable zip. */
export function writeEmptySolutionSource(dir: string, spec: SolutionSpec): { folder: string; files: string[] } {
  const other = path.join(dir, "Other");
  fs.mkdirSync(other, { recursive: true });
  const s = path.join(other, "Solution.xml");
  const c = path.join(other, "Customizations.xml");
  fs.writeFileSync(s, solutionXml(spec), "utf8");
  fs.writeFileSync(c, CUSTOMIZATIONS_XML, "utf8");
  return { folder: dir, files: [s, c] };
}

export interface CreateSolutionResult {
  uniqueName: string;
  zip: string;
  existed: boolean;
  import: PacResult | null;
}

export async function createSolution(spec: SolutionSpec & { environment?: string; workDir: string }): Promise<CreateSolutionResult> {
  if (!hasPacProfileLock()) return (await withPacProfile(makerProfileDefault(), () => createSolution(spec))).result;
  const { solutions } = await listSolutions(spec.environment);
  const existing = solutions.find((s) => s.uniqueName.toLowerCase() === spec.uniqueName.toLowerCase());
  const zip = path.join(spec.workDir, `${spec.uniqueName}.zip`);
  if (existing) return { uniqueName: existing.uniqueName, zip, existed: true, import: null };
  const src = path.join(spec.workDir, "src");
  fs.rmSync(src, { recursive: true, force: true });
  writeEmptySolutionSource(src, spec);
  await packSolution(src, zip, "Unmanaged");
  const imp = await importSolution({ zipPath: zip, environment: spec.environment, publishChanges: true });
  return { uniqueName: spec.uniqueName, zip, existed: false, import: imp };
}

// ---------------------------------------------------------------------------
// New agent inside a chosen solution
// ---------------------------------------------------------------------------

export interface InitInSolutionOptions {
  name: string;
  publisherPrefix: string;
  projectDir: string;
  solutionName: string;
  environment: string;
  createSolution?: boolean;
  solutionDisplayName?: string;
  instructions?: string;
  schemaName?: string;
  template?: "default" | "minimal";
  authoringMode?: "classic" | "cli-copilot";
}

export interface InitInSolutionResult {
  workspace: string;
  syncConnected: boolean;
  schemaName: string | null;
  solution: { uniqueName: string; created: boolean };
  zip: string;
  steps: { step: string; ok: boolean; detail?: string }[];
  next: string;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * init (local) -> pack with --solution-name -> solution import -> clone by
 * schema name so the final folder is a sync-connected workspace inside the
 * chosen solution. Falls back to the local scaffold when the clone fails.
 */
/** Scaffold the workspace locally; the live agent comes later, from the packed solution. */
async function scaffoldWorkspace(o: InitInSolutionOptions, projectDir: string): Promise<PacResult> {
  const args = ["copilot", "init", "--name", o.name, "--publisher-prefix", o.publisherPrefix, "--project-dir", projectDir];
  if (o.instructions) args.push("--instructions", o.instructions);
  if (o.schemaName) args.push("--schema-name", o.schemaName);
  if (o.template) args.push("--template", o.template);
  if (o.authoringMode) args.push("--authoring-mode", o.authoringMode);
  return runPac(args, { timeoutMs: 5 * 60_000 });
}

export async function initAgentInSolution(o: InitInSolutionOptions): Promise<InitInSolutionResult> {
  if (!hasPacProfileLock()) return (await withPacProfile(makerProfileDefault(), () => initAgentInSolution(o))).result;
  validatePrefix(o.publisherPrefix);
  const projectDir = path.resolve(o.projectDir);
  const parent = path.dirname(projectDir);
  const steps: InitInSolutionResult["steps"] = [];

  const { solutions } = await listSolutions(o.environment);
  let solution: SolutionRow | undefined = solutions.find((s) => s.uniqueName.toLowerCase() === o.solutionName.toLowerCase());
  let created = false;
  if (!solution) {
    if (!o.createSolution) throw new Error(`Solution '${o.solutionName}' does not exist in ${o.environment}. Pass createSolution: true to create it (publisher prefix ${o.publisherPrefix}).`);
    created = true;
  } else if (solution.isManaged) {
    throw new Error(`Solution '${o.solutionName}' is managed; agents can only be added to unmanaged solutions`);
  }
  steps.push({ step: "solution", ok: true, detail: solution ? `exists (${solution.version})` : "will be created by the import" });

  const init = await scaffoldWorkspace(o, projectDir);
  steps.push({ step: "pac copilot init", ok: init.ok, detail: init.ok ? undefined : explainFailure(init) });
  if (!init.ok) throw new Error(`pac copilot init failed: ${explainFailure(init)}`);
  const schemaName = readWorkspace(projectDir).schemaName;

  const packOut = path.join(parent, `.cs-pack-${path.basename(projectDir)}`);
  fs.rmSync(packOut, { recursive: true, force: true });
  const pack = await runPac(["copilot", "pack", "--publisher-prefix", o.publisherPrefix, "--project-dir", projectDir, "--output-path", packOut, "--solution-name", o.solutionName], { timeoutMs: 5 * 60_000 });
  steps.push({ step: "pac copilot pack", ok: pack.ok, detail: pack.ok ? undefined : explainFailure(pack) });
  if (!pack.ok) throw new Error(`pac copilot pack failed: ${explainFailure(pack)}`);
  const zip = fs.readdirSync(packOut).filter((f) => f.toLowerCase().endsWith(".zip")).map((f) => path.join(packOut, f))[0];
  if (!zip) throw new Error(`pack produced no zip in ${packOut}`);

  // Add the display name for a new solution (pack names it after the unique name).
  const imp = await importSolution({ zipPath: zip, environment: o.environment, publishChanges: true, forceOverwrite: false });
  steps.push({ step: "pac solution import", ok: imp.ok, detail: imp.ok ? undefined : explainFailure(imp) });
  if (!imp.ok) throw new Error(`pac solution import failed: ${explainFailure(imp)}`);

  // Clone into a sibling folder, then swap it in for the local scaffold.
  const cloneOut = path.join(parent, `.cs-clone-${path.basename(projectDir)}`);
  fs.rmSync(cloneOut, { recursive: true, force: true });
  fs.mkdirSync(cloneOut, { recursive: true });
  const bot = schemaName ?? o.name;
  let clone = await runPac(["copilot", "clone", "--bot", bot, "--environment", o.environment, "--output-dir", cloneOut, "--display-name", path.basename(projectDir)], { timeoutMs: 15 * 60_000 });
  if (!clone.ok) {
    log(`clone failed once (${explainFailure(clone)}); retrying after provisioning delay`);
    await sleep(20_000);
    clone = await runPac(["copilot", "clone", "--bot", bot, "--environment", o.environment, "--output-dir", cloneOut, "--display-name", path.basename(projectDir)], { timeoutMs: 15 * 60_000 });
  }
  let workspace = projectDir;
  let syncConnected = false;
  if (clone.ok) {
    const cloned = findWorkspaceRoot(cloneOut);
    if (cloned) {
      fs.rmSync(projectDir, { recursive: true, force: true });
      fs.renameSync(cloned, projectDir);
      fs.rmSync(cloneOut, { recursive: true, force: true });
      syncConnected = true;
    }
  }
  steps.push({ step: "pac copilot clone", ok: clone.ok && syncConnected, detail: clone.ok ? undefined : explainFailure(clone) });
  return {
    workspace,
    syncConnected,
    schemaName,
    solution: { uniqueName: o.solutionName, created },
    zip,
    steps,
    next: syncConnected
      ? "Workspace is sync-connected: author with cs_add_topic / cs_add_knowledge_source / cs_add_tool, then cs_validate and cs_push."
      : "The agent was imported but the clone did not succeed; run cs_clone_agent with the schema name into an empty folder to get a sync-connected workspace.",
  };
}

// ---------------------------------------------------------------------------
// Instructions from an AI Builder prompt
// ---------------------------------------------------------------------------

export interface InstructionsBrief {
  purpose: string;
  audience?: string;
  tone?: string;
  boundaries?: string[];
  capabilities?: string[];
  examples?: string[];
  language?: string;
  currentInstructions?: string;
  changeRequest?: string;
}

/** What the maker told us about the agent, as labelled lines the model can follow. */
function briefFacts(b: InstructionsBrief): string[] {
  const lines: string[] = [`PURPOSE: ${b.purpose.trim()}`];
  if (b.audience) lines.push(`AUDIENCE: ${b.audience.trim()}`);
  if (b.tone) lines.push(`TONE: ${b.tone.trim()}`);
  if (b.language) lines.push(`LANGUAGE OF THE INSTRUCTIONS: ${b.language.trim()}`);
  if (b.capabilities?.length) lines.push("CAPABILITIES (tools, knowledge, topics the agent has):", ...b.capabilities.map((c) => `- ${c}`));
  if (b.boundaries?.length) lines.push("BOUNDARIES (what the agent must not do):", ...b.boundaries.map((c) => `- ${c}`));
  if (b.examples?.length) lines.push("EXAMPLE USER REQUESTS:", ...b.examples.map((c) => `- ${c}`));
  return lines;
}

export function buildInstructionsBrief(b: InstructionsBrief): string {
  const lines: string[] = [];
  if (b.currentInstructions) {
    lines.push("Revise the following Copilot Studio agent instructions.", "", "CURRENT INSTRUCTIONS:", b.currentInstructions.trim(), "");
    if (b.changeRequest) lines.push("CHANGE REQUEST:", b.changeRequest.trim(), "");
    lines.push("Return only the complete revised instructions.");
    return lines.join("\n");
  }
  lines.push("Write system instructions for a Microsoft Copilot Studio agent. Return only the instructions, written in the second person, as concise imperative guidance the agent follows in every conversation.", "");
  lines.push(...briefFacts(b));
  lines.push("", "Cover: role and scope, how to answer (grounding in knowledge, citing sources, asking clarifying questions), when to use each capability, escalation, and what to refuse.");
  return lines.join("\n");
}

const BANNER = /^(Microsoft PowerPlatform CLI|Version:|Online documentation:|Feedback, Suggestions, Issues:|Connected as |Connected to\.\.\.|Warning:)/i;

/** Strip pac's banner and connection lines from `pac copilot model predict` output. */
export function cleanPredictOutput(stdout: string): string {
  const lines = stdout.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (BANNER.test(line.trim())) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export interface GenerateOptions {
  modelId?: string;
  modelName?: string;
  brief: string;
  environment?: string;
  /** --prompt (default, for prompt models) or --text (for text-input models) */
  inputMode?: "prompt" | "text";
}

/** The argv for `pac copilot model predict`: the prompt by id or by name, and how the brief is passed. */
function predictArgs(o: GenerateOptions): string[] {
  const args = ["copilot", "model", "predict"];
  if (o.modelId) args.push("--model-id", o.modelId);
  else args.push("--model-name", o.modelName as string);
  args.push(o.inputMode === "text" ? "--text" : "--prompt", o.brief);
  if (o.environment) args.push("--environment", o.environment);
  return args;
}

export async function generateWithAiBuilder(o: GenerateOptions): Promise<{ text: string; pac: PacResult }> {
  if (!o.modelId && !o.modelName) throw new Error("modelId or modelName is required (see cs_list_prompts)");
  const r = await runPac(predictArgs(o), { timeoutMs: 5 * 60_000 });
  if (!r.ok) throw new Error(`pac copilot model predict failed: ${explainFailure(r)}`);
  const text = cleanPredictOutput(r.stdout);
  if (!text) throw new Error(`the model returned no text (raw output: ${r.stdout.slice(0, 200)}${errorMessage("") ? "" : ""})`);
  return { text, pac: r };
}
