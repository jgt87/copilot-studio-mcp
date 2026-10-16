/**
 * Workspace validation: per-file schema checks (schema.ts) plus the
 * cross-file checks that need the whole workspace: connection references,
 * catalog operations, topic redirects.
 */
import fs from "node:fs";
import path from "node:path";
import * as yaml from "js-yaml";
import { errorMessage } from "./log.js";
import { validateDocument, type Diagnostic } from "./schemaValidate.js";
import { readWorkspace, type WorkspaceInfo } from "./workspace.js";
import { readTextFile } from "./authoring/capture.js";
import { connectorFromReference, readConnectionReferences, type ConnectionReferenceEntry } from "./authoring/tools.js";
import { catalogDir, checkOperation } from "./catalog.js";
import { isYamlFile, listFilesRecursive, pascal } from "./authoring/util.js";

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
  topicDisplayNames: Map<string, string>;
  agentSchema: string | null;
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

/**
 * Git conflict markers, as `pac copilot pull` leaves them when a merge conflicts.
 * A push of such a file kept only the text before the first marker and reported
 * success (microsoft/vscode-copilotstudio#429, #435), so this is an error even
 * where the YAML still happens to parse.
 */
const CONFLICT_MARKER = /^(<{7}|={7}|>{7})(\s|$)/m;

function conflictDiagnostics(raw: string): Diagnostic[] {
  const m = CONFLICT_MARKER.exec(raw);
  if (!m) return [];
  const line = raw.slice(0, m.index).split("\n").length;
  return [{ severity: "error", message: `line ${line}: unresolved merge conflict marker '${m[1]}'; resolve the conflict before pushing, or the push keeps only the text before it` }];
}

function parseAndValidate(file: string): { doc: Doc | null; diagnostics: Diagnostic[] } {
  let raw = "";
  try {
    // Capture-aware: a file a previewed call would have written validates as
    // the content it would have, not as the file that is not there yet.
    raw = readTextFile(file);
    const doc = yaml.load(raw);
    const diagnostics = [...conflictDiagnostics(raw), ...validateDocument(doc, raw)];
    return { doc: doc && typeof doc === "object" ? (doc as Doc) : null, diagnostics };
  } catch (err) {
    return { doc: null, diagnostics: [...conflictDiagnostics(raw), { severity: "error", message: `YAML parse error: ${errorMessage(err)}` }] };
  }
}

/**
 * Files pac pushes that have no component schema of their own to check:
 * settings, the connection reference list, flow metadata. They are still
 * parsed, so a broken one fails here instead of at push.
 */
function collectSupportFiles(root: string): string[] {
  const files = ["settings.mcs.yml", "settings.mcs.yaml", "connectionreferences.mcs.yml", "connectionreferences.mcs.yaml"].map((n) => path.join(root, n)).filter((f) => fs.existsSync(f));
  const workflows = path.join(root, "workflows");
  if (fs.existsSync(workflows)) files.push(...listFilesRecursive(workflows, isYamlFile, 2));
  return files;
}

function parseOnly(file: string): Diagnostic[] {
  let raw = "";
  try {
    raw = readTextFile(file);
    yaml.load(raw);
    return conflictDiagnostics(raw);
  } catch (err) {
    return [...conflictDiagnostics(raw), { severity: "error", message: `YAML parse error: ${errorMessage(err)}` }];
  }
}

/**
 * Characters pac accepts in a schema name, quoted from its own error message
 * (microsoft/vscode-copilotstudio#431), and the Dataverse length cap (#138).
 * The file stem becomes the last segment of the component's schema name.
 */
const SCHEMA_NAME_CHARS = /^[A-Za-z0-9_\-.{}!]+$/;
const SCHEMA_NAME_MAX = 100;

function checkSchemaNames(file: string, doc: Doc | null, agentSchema: string | null): Diagnostic[] {
  const out: Diagnostic[] = [];
  const stem = path.basename(file).replace(/\.mcs\.ya?ml$/i, "");
  if (!AGENT_FILES.includes(path.basename(file)) && !SCHEMA_NAME_CHARS.test(stem)) {
    out.push({ severity: "error", message: `file name '${stem}' becomes part of the schema name, which allows only letters, digits and _ - . { } !; rename the file` });
  }
  const explicit = typeof doc?.schemaName === "string" ? doc.schemaName : null;
  const topicDir = path.basename(path.dirname(file)) === "topics";
  const name = explicit ?? (topicDir && agentSchema ? `${agentSchema}.topic.${stem}` : null);
  if (name && !name.includes(PLACEHOLDER) && name.length > SCHEMA_NAME_MAX) {
    out.push({ severity: "error", message: `schema name '${name}' is ${name.length} characters; Dataverse allows ${SCHEMA_NAME_MAX}` });
  }
  if (explicit && !explicit.includes(PLACEHOLDER) && !SCHEMA_NAME_CHARS.test(explicit)) {
    out.push({ severity: "error", message: `schemaName '${explicit}' has characters outside letters, digits and _ - . { } !` });
  }
  return out;
}

/** A period in a topic's display name stops the solution from exporting (Microsoft Learn, "Create and edit topics"). */
function checkTopicDisplayName(file: string, ctx: CrossFileContext): Diagnostic[] {
  const name = ctx.topicDisplayNames.get(file);
  return name && name.includes(".") ? [{ severity: "warning", message: `topic name '${name}' contains a period; a solution containing it cannot be exported` }] : [];
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

/**
 * The placeholder anywhere else (a variable's schemaName, a knowledge search's
 * sources): the service would store it verbatim. Redirects and connection
 * references have their own, more specific messages above.
 */
function checkLeftoverPlaceholders(doc: Doc): Diagnostic[] {
  const out: Diagnostic[] = [];
  const walk = (n: unknown, at: string, key: string): void => {
    if (typeof n === "string") {
      if (n.includes(PLACEHOLDER) && key !== "dialog" && key !== "connectionReference") {
        out.push({ severity: "error", message: `'${n}' still contains ${PLACEHOLDER}; clone or sync the workspace so the agent schema name is known`, path: at });
      }
      return;
    }
    if (Array.isArray(n)) n.forEach((v, i) => walk(v, `${at}[${i}]`, key));
    else if (n && typeof n === "object") for (const [k, v] of Object.entries(n)) walk(v, `${at}.${k}`, k);
  };
  walk(doc, "$", "");
  return out;
}

function crossFileDiagnostics(doc: Doc, ctx: CrossFileContext): Diagnostic[] {
  const action = doc.action as Doc | undefined;
  return [
    ...checkConnectionReference(action, ctx),
    ...checkCatalogOperation(action, ctx),
    ...collectDialogReferences(doc).flatMap((ref) => checkTopicRedirect(ref, ctx)),
    ...checkLeftoverPlaceholders(doc),
  ];
}

function crossFileContext(root: string, ws: WorkspaceInfo): CrossFileContext {
  const crEntries = readConnectionReferences(root).entries;
  return {
    root,
    environmentId: ws.sync.environmentId,
    crEntries,
    crNames: new Set(crEntries.map((e) => e.connectionReferenceLogicalName)),
    topicNames: topicReferenceNames(ws),
    topicDisplayNames: new Map(ws.topics.map((t) => [path.resolve(t.file), t.name])),
    agentSchema: ws.schemaName ?? null,
  };
}

/**
 * The names a `.topic.<X>` reference can resolve to. X is the file stem (that is
 * what the schema name is built from), so a display name that differs from it -
 * "order status" in OrderStatus.mcs.yml, or a renamed clone - must not count as
 * missing. Display names stay in the set for files named before that rule.
 */
export function topicReferenceNames(ws: Pick<WorkspaceInfo, "topics">): Set<string> {
  const names = new Set<string>();
  for (const t of ws.topics) {
    const stem = path.basename(t.file).replace(/\.mcs\.ya?ml$/i, "");
    names.add(stem);
    names.add(stem.replace(/\.topic$/i, ""));
    names.add(t.name.replace(/[^A-Za-z0-9]/g, ""));
    names.add(pascal(t.name));
  }
  return names;
}

/**
 * Validate every component file in the workspace (or a single file when
 * `only` is given). Errors block cs_push; warnings and infos are advisory.
 */
export function validateWorkspace(root: string, only?: string): WorkspaceValidation {
  const ctx = crossFileContext(root, readWorkspace(root));
  const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");
  const files = collectComponentFiles(root, only).map((file): FileValidation => {
    const { doc, diagnostics } = parseAndValidate(file);
    if (doc) diagnostics.push(...crossFileDiagnostics(doc, ctx));
    diagnostics.push(...checkSchemaNames(file, doc, ctx.agentSchema), ...checkTopicDisplayName(path.resolve(file), ctx));
    return { file: rel(file), diagnostics };
  });
  if (!only) files.push(...collectSupportFiles(root).map((file) => ({ file: rel(file), diagnostics: parseOnly(file) })));
  const count = (severity: Diagnostic["severity"]) => files.reduce((n, f) => n + f.diagnostics.filter((d) => d.severity === severity).length, 0);
  return { files, errors: count("error"), warnings: count("warning") };
}
