/**
 * Workspace validation: per-file schema checks (schema.ts) plus the
 * cross-file checks that need the whole workspace: connection references,
 * catalog operations, topic redirects.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { errorMessage } from "./log.js";
import { validateDocument, type Diagnostic } from "./schema.js";
import { readWorkspace, type WorkspaceInfo } from "./workspace.js";
import { connectorFromReference, readConnectionReferences, type ConnectionReferenceEntry } from "./authoring/tools.js";
import { catalogDir, checkOperation } from "./catalog.js";
import { isYamlFile, listFilesRecursive } from "./authoring/util.js";

export interface FileValidation {
  file: string;
  diagnostics: Diagnostic[];
}

export interface WorkspaceValidation {
  files: FileValidation[];
  errors: number;
  warnings: number;
}

const COMPONENT_DIRS = ["topics", "knowledge", "actions", "tools", "trigger", "triggers", "variables"];
const AGENT_FILES = ["agent.mcs.yml", "agent.mcs.yaml"];
/** Built-in topics every classic agent has; redirects to them never need a local file. */
const SYSTEM_TOPICS = /^(Escalate|Fallback|Greeting|Goodbye|ThankYou|StartOver|ConversationStart|OnError|EndOfConversation|Signin|MultipleTopicsMatched|ResetConversation)$/i;
const PLACEHOLDER = "<AGENT_SCHEMA>";

type Doc = Record<string, unknown>;

interface CrossFileContext {
  root: string;
  environmentId: string | null;
  crEntries: ConnectionReferenceEntry[];
  crNames: Set<string>;
  topicNames: Set<string>;
}

function collectComponentFiles(root: string, only?: string): string[] {
  if (only) return [path.isAbsolute(only) ? only : path.join(root, only)];
  const files: string[] = [];
  for (const d of COMPONENT_DIRS) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    files.push(...listFilesRecursive(dir, (f) => isYamlFile(f) && !f.includes(`${path.sep}files${path.sep}`), 2));
  }
  for (const n of AGENT_FILES) {
    const f = path.join(root, n);
    if (fs.existsSync(f)) files.push(f);
  }
  return files;
}

function parseAndValidate(file: string): { doc: Doc | null; diagnostics: Diagnostic[] } {
  const raw = fs.readFileSync(file, "utf8");
  try {
    const doc = yaml.load(raw);
    const diagnostics = validateDocument(doc, raw);
    return { doc: doc && typeof doc === "object" ? (doc as Doc) : null, diagnostics };
  } catch (err) {
    return { doc: null, diagnostics: [{ severity: "error", message: `YAML parse error: ${errorMessage(err)}` }] };
  }
}

function checkConnectionReference(action: Doc | undefined, ctx: CrossFileContext): Diagnostic[] {
  const cr = action?.connectionReference;
  if (typeof cr !== "string") return [];
  if (cr.includes(PLACEHOLDER)) return [{ severity: "error", message: `connectionReference still contains ${PLACEHOLDER}` }];
  if (ctx.crNames.size && !ctx.crNames.has(cr)) return [{ severity: "warning", message: `connectionReference '${cr}' is not listed in connectionreferences.mcs.yml` }];
  return [];
}

/** Does the operation exist on the connector? Only answerable when the connector definition is cached. */
function checkCatalogOperation(action: Doc | undefined, ctx: CrossFileContext): Diagnostic[] {
  if (action?.kind !== "InvokeConnectorTaskAction") return [];
  const cr = action.connectionReference;
  const operationId = action.operationId;
  if (typeof cr !== "string" || typeof operationId !== "string") return [];
  const connector = connectorFromReference(cr, ctx.crEntries);
  if (!connector) return [];
  const chk = checkOperation(catalogDir(ctx.root), ctx.environmentId, connector, operationId);
  if (!chk.known) return [{ severity: "info", message: chk.message ?? "no catalog" }];
  if (chk.operationFound === false) return [{ severity: "warning", message: chk.message ?? "operation not found in catalog" }];
  return [];
}

/** Every `dialog:` value in the document (BeginDialog / ReplaceDialog targets). */
export function collectDialogReferences(doc: unknown): string[] {
  const refs: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    if (!n || typeof n !== "object") return;
    const o = n as Doc;
    if (typeof o.dialog === "string") refs.push(o.dialog);
    Object.values(o).forEach(walk);
  };
  walk(doc);
  return refs;
}

function checkTopicRedirect(ref: string, ctx: CrossFileContext): Diagnostic[] {
  if (ref.includes(PLACEHOLDER)) return [{ severity: "error", message: `topic reference '${ref}' still contains ${PLACEHOLDER}` }];
  const target = /\.topic\.([A-Za-z0-9_]+)$/.exec(ref)?.[1];
  if (!target || !ctx.topicNames.size || ctx.topicNames.has(target) || SYSTEM_TOPICS.test(target)) return [];
  return [{ severity: "warning", message: `redirect target '${ref}' does not match any local topic (system topics are fine)` }];
}

function crossFileDiagnostics(doc: Doc, ctx: CrossFileContext): Diagnostic[] {
  const action = doc.action as Doc | undefined;
  return [
    ...checkConnectionReference(action, ctx),
    ...checkCatalogOperation(action, ctx),
    ...collectDialogReferences(doc).flatMap((ref) => checkTopicRedirect(ref, ctx)),
  ];
}

function crossFileContext(root: string, ws: WorkspaceInfo): CrossFileContext {
  const crEntries = readConnectionReferences(root).entries;
  return {
    root,
    environmentId: ws.sync.environmentId,
    crEntries,
    crNames: new Set(crEntries.map((e) => e.connectionReferenceLogicalName)),
    topicNames: new Set(ws.topics.map((t) => t.name.replace(/[^A-Za-z0-9]/g, ""))),
  };
}

/**
 * Validate every component file in the workspace (or a single file when
 * `only` is given). Errors block cs_push; warnings and infos are advisory.
 */
export function validateWorkspace(root: string, only?: string): WorkspaceValidation {
  const ctx = crossFileContext(root, readWorkspace(root));
  const files = collectComponentFiles(root, only).map((file): FileValidation => {
    const { doc, diagnostics } = parseAndValidate(file);
    if (doc) diagnostics.push(...crossFileDiagnostics(doc, ctx));
    return { file: path.relative(root, file).split(path.sep).join("/"), diagnostics };
  });
  const count = (severity: Diagnostic["severity"]) => files.reduce((n, f) => n + f.diagnostics.filter((d) => d.severity === severity).length, 0);
  return { files, errors: count("error"), warnings: count("warning") };
}
