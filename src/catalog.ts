/**
 * Tool catalog: what can be added to an agent in a given environment.
 *
 * Sources, in order of authority:
 *  1. the environment's connector registry (Power Apps API), first-party and
 *     custom connectors alike, the same list the portal's "Add a tool" uses
 *  2. each connector's OpenAPI definition, turned into operations with the
 *     operationId and parameters cs_add_tool needs; MCP-capable connectors
 *     carry the `x-ms-agentic-protocol: mcp-streamable-1.0` marker
 *  3. AI Builder prompts via `pac copilot model list`
 *  4. an offline seed (reference/connectors-seed.json) of display names to
 *     connector ids derived from the public connector reference
 *
 * Everything fetched is cached under the catalog directory so authoring and
 * validation work offline afterwards.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requestJson, type FetchLike } from "./cloud/http.js";
import { runPac, explainFailure } from "./pac.js";

export const POWERAPPS_API = "https://api.powerapps.com";
const API_VERSION = "2016-11-01";
export const MCP_PROTOCOL_MARKER = "x-ms-agentic-protocol";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConnectorSummary {
  /** e.g. shared_office365 */
  name: string;
  /** e.g. /providers/Microsoft.PowerApps/apis/shared_office365 */
  id: string;
  displayName: string;
  description: string | null;
  publisher: string | null;
  tier: string | null;
  isCustom: boolean;
  /** Heuristic from the name; definitive after describeConnector */
  mcpLikely: boolean;
  iconUri: string | null;
}

export interface OperationParameter {
  name: string;
  in: string;
  required: boolean;
  type: string | null;
  description: string | null;
  summary: string | null;
  visibility: string | null;
  dynamicValues: boolean;
}

export interface ConnectorOperation {
  operationId: string;
  method: string;
  path: string;
  summary: string | null;
  description: string | null;
  visibility: string | null;
  mcp: boolean;
  parameters: OperationParameter[];
  responseProperties: string[];
}

export interface ConnectorDefinition {
  name: string;
  id: string;
  displayName: string;
  description: string | null;
  isCustom: boolean;
  mcp: boolean;
  operations: ConnectorOperation[];
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Registry (list) and definition (swagger)
// ---------------------------------------------------------------------------

interface RawApi {
  name: string;
  id: string;
  properties?: Record<string, unknown>;
}

function toSummary(api: RawApi): ConnectorSummary {
  const p = api.properties ?? {};
  const displayName = String(p.displayName ?? api.name);
  const meta = (p.metadata ?? {}) as Record<string, unknown>;
  const capabilities = Array.isArray(p.capabilities) ? (p.capabilities as string[]) : [];
  return {
    name: api.name,
    id: api.id,
    displayName,
    description: (p.description as string | null) ?? null,
    publisher: (p.publisher as string | null) ?? null,
    tier: (p.tier as string | null) ?? null,
    isCustom: Boolean(p.isCustomApi),
    mcpLikely: /\bmcp\b/i.test(displayName) || /mcp/i.test(api.name) || capabilities.some((c) => /mcp/i.test(c)) || /mcp/i.test(JSON.stringify(meta.agenticProtocols ?? "")),
    iconUri: (p.iconUri as string | null) ?? null,
  };
}

export async function fetchConnectorList(environmentId: string, token: string, fetchImpl?: FetchLike): Promise<ConnectorSummary[]> {
  const url = `${POWERAPPS_API}/providers/Microsoft.PowerApps/apis?api-version=${API_VERSION}&$filter=${encodeURIComponent(`environment eq '${environmentId}'`)}`;
  const out: ConnectorSummary[] = [];
  let next: string | null = url;
  let guard = 0;
  while (next && guard++ < 50) {
    const page: { value?: RawApi[]; nextLink?: string } | null = await requestJson<{ value?: RawApi[]; nextLink?: string }>(next, { token, fetchImpl });
    for (const api of page?.value ?? []) out.push(toSummary(api));
    next = page?.nextLink ?? null;
  }
  return out.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function fetchConnectorSwagger(environmentId: string, name: string, token: string, fetchImpl?: FetchLike): Promise<{ api: RawApi; swagger: Record<string, unknown> | null }> {
  const base = `${POWERAPPS_API}/providers/Microsoft.PowerApps/apis/${encodeURIComponent(name)}?api-version=${API_VERSION}&$filter=${encodeURIComponent(`environment eq '${environmentId}'`)}`;
  const api = await requestJson<RawApi>(`${base}&$expand=swagger`, { token, fetchImpl });
  if (!api) throw new Error(`Connector ${name} not found in environment ${environmentId}`);
  const p = api.properties ?? {};
  let swagger = (p.swagger as Record<string, unknown> | undefined) ?? null;
  if (!swagger && typeof p.swaggerUrl === "string") swagger = await requestJson<Record<string, unknown>>(p.swaggerUrl, { fetchImpl });
  return { api, swagger };
}

/** Turn an OpenAPI 2.0 document into the operation list the authoring tools need. */
export function parseSwaggerOperations(swagger: Record<string, unknown>): { operations: ConnectorOperation[]; mcp: boolean } {
  const paths = (swagger.paths ?? {}) as Record<string, Record<string, unknown>>;
  const definitions = (swagger.definitions ?? {}) as Record<string, Record<string, unknown>>;
  const operations: ConnectorOperation[] = [];
  let mcp = false;
  const resolveRef = (schema: unknown): Record<string, unknown> | null => {
    if (!schema || typeof schema !== "object") return null;
    const s = schema as Record<string, unknown>;
    if (typeof s.$ref === "string") {
      const name = s.$ref.split("/").pop() ?? "";
      return definitions[name] ?? null;
    }
    return s;
  };
  for (const [p, methods] of Object.entries(paths)) {
    const pathMarker = typeof methods[MCP_PROTOCOL_MARKER] === "string";
    for (const [method, raw] of Object.entries(methods)) {
      if (!/^(get|post|put|patch|delete|head|options)$/i.test(method) || !raw || typeof raw !== "object") continue;
      const op = raw as Record<string, unknown>;
      const opMcp = pathMarker || typeof op[MCP_PROTOCOL_MARKER] === "string";
      if (opMcp) mcp = true;
      const params = (Array.isArray(op.parameters) ? (op.parameters as Record<string, unknown>[]) : []).flatMap((prm) => {
        const param = resolveRef(prm) ?? prm;
        if (param.in === "body") {
          const schema = resolveRef(param.schema) ?? {};
          const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
          const required = new Set((schema.required as string[] | undefined) ?? []);
          return Object.entries(props).map(([n, d]) => ({
            name: n,
            in: "body",
            required: required.has(n),
            type: (d.type as string | null) ?? null,
            description: (d.description as string | null) ?? null,
            summary: (d["x-ms-summary"] as string | null) ?? null,
            visibility: (d["x-ms-visibility"] as string | null) ?? null,
            dynamicValues: Boolean(d["x-ms-dynamic-values"] ?? d["x-ms-dynamic-list"]),
          }));
        }
        return [
          {
            name: String(param.name ?? ""),
            in: String(param.in ?? ""),
            required: Boolean(param.required),
            type: (param.type as string | null) ?? null,
            description: (param.description as string | null) ?? null,
            summary: (param["x-ms-summary"] as string | null) ?? null,
            visibility: (param["x-ms-visibility"] as string | null) ?? null,
            dynamicValues: Boolean(param["x-ms-dynamic-values"] ?? param["x-ms-dynamic-list"]),
          },
        ];
      });
      const responses = (op.responses ?? {}) as Record<string, Record<string, unknown>>;
      const ok = responses["200"] ?? responses["default"] ?? null;
      const respSchema = ok ? resolveRef(ok.schema) : null;
      const responseProperties = respSchema ? Object.keys((respSchema.properties ?? {}) as Record<string, unknown>) : [];
      operations.push({
        operationId: String(op.operationId ?? `${method}_${p}`),
        method: method.toUpperCase(),
        path: p,
        summary: (op.summary as string | null) ?? null,
        description: (op.description as string | null) ?? null,
        visibility: (op["x-ms-visibility"] as string | null) ?? null,
        mcp: opMcp,
        parameters: params,
        responseProperties,
      });
    }
  }
  return { operations: operations.sort((a, b) => a.operationId.localeCompare(b.operationId)), mcp };
}

export function toDefinition(api: RawApi, swagger: Record<string, unknown> | null): ConnectorDefinition {
  const s = toSummary(api);
  const parsed = swagger ? parseSwaggerOperations(swagger) : { operations: [], mcp: false };
  return { name: s.name, id: s.id, displayName: s.displayName, description: s.description, isCustom: s.isCustom, mcp: parsed.mcp || s.mcpLikely, operations: parsed.operations, fetchedAt: new Date().toISOString() };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

export function catalogDir(base?: string): string {
  return process.env.CPS_CATALOG_DIR ?? path.join(base ?? process.env.CPS_WORKSPACE ?? process.cwd(), ".cs-catalog");
}

function envDir(dir: string, environmentId: string): string {
  return path.join(dir, environmentId.replace(/[^A-Za-z0-9._-]/g, "_"));
}

export function writeConnectorList(dir: string, environmentId: string, list: ConnectorSummary[]): string {
  const d = envDir(dir, environmentId);
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, "connectors.json");
  fs.writeFileSync(file, JSON.stringify({ environmentId, fetchedAt: new Date().toISOString(), connectors: list }, null, 2) + "\n", "utf8");
  return file;
}

export function readConnectorList(dir: string, environmentId: string): { fetchedAt: string; connectors: ConnectorSummary[] } | null {
  const file = path.join(envDir(dir, environmentId), "connectors.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as { fetchedAt: string; connectors: ConnectorSummary[] };
}

export function writeConnectorDefinition(dir: string, environmentId: string, def: ConnectorDefinition): string {
  const d = path.join(envDir(dir, environmentId), "connectors");
  fs.mkdirSync(d, { recursive: true });
  const file = path.join(d, `${def.name}.json`);
  fs.writeFileSync(file, JSON.stringify(def, null, 2) + "\n", "utf8");
  return file;
}

export function readConnectorDefinition(dir: string, environmentId: string | null, name: string): ConnectorDefinition | null {
  const candidates = environmentId ? [envDir(dir, environmentId)] : fs.existsSync(dir) ? fs.readdirSync(dir).map((e) => path.join(dir, e)) : [];
  for (const c of candidates) {
    const file = path.join(c, "connectors", `${name}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8")) as ConnectorDefinition;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Offline seed
// ---------------------------------------------------------------------------

export interface SeedConnector {
  name: string;
  displayName: string;
  docs: string;
}

const SEED_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "reference", "connectors-seed.json");
let seedCache: SeedConnector[] | null = null;

export function loadSeed(): SeedConnector[] {
  if (seedCache) return seedCache;
  try {
    const raw = JSON.parse(fs.readFileSync(SEED_PATH, "utf8")) as { connectors?: SeedConnector[] };
    seedCache = raw.connectors ?? [];
  } catch {
    seedCache = [];
  }
  return seedCache;
}

/** Match by connector id, docs slug or display name (case-insensitive, substring). */
export function searchConnectors(query: string, pool: { name: string; displayName: string }[]): { name: string; displayName: string }[] {
  const q = query.trim().toLowerCase();
  if (!q) return pool.slice(0, 50);
  const exact = pool.filter((c) => c.name.toLowerCase() === q || c.name.toLowerCase() === `shared_${q}` || c.displayName.toLowerCase() === q);
  if (exact.length) return exact;
  return pool.filter((c) => c.name.toLowerCase().includes(q) || c.displayName.toLowerCase().includes(q)).slice(0, 50);
}

// ---------------------------------------------------------------------------
// AI Builder prompts via pac
// ---------------------------------------------------------------------------

export interface PromptRow {
  id: string;
  state: string;
  name: string;
}

const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Parse `pac copilot model list`: `Id  State  Name` rows. */
export function parseModelList(stdout: string): PromptRow[] {
  const rows: PromptRow[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s*(\S+)\s+(Active|Inactive|\S+)\s+(.+?)\s*$/.exec(line);
    if (!m || !GUID.test(m[1])) continue;
    rows.push({ id: m[1], state: m[2], name: m[3] });
  }
  return rows;
}

export async function listPrompts(environment?: string): Promise<PromptRow[]> {
  const r = await runPac(["copilot", "model", "list", ...(environment ? ["--environment", environment] : [])], { timeoutMs: 180_000 });
  if (!r.ok) throw new Error(`pac copilot model list failed: ${explainFailure(r)}`);
  return parseModelList(r.stdout);
}

// ---------------------------------------------------------------------------
// Validation helpers used by cs_validate / cs_add_tool
// ---------------------------------------------------------------------------

export interface OperationCheck {
  known: boolean;
  connector: string | null;
  operationFound: boolean | null;
  suggestions: string[];
  message: string | null;
}

/** Check an operationId against the cached definition of a connector (by connector name). */
export function checkOperation(dir: string, environmentId: string | null, connectorName: string, operationId: string): OperationCheck {
  const def = readConnectorDefinition(dir, environmentId, connectorName);
  if (!def) return { known: false, connector: connectorName, operationFound: null, suggestions: [], message: `no cached definition for ${connectorName}; run cs_describe_connector to enable operation checks` };
  const found = def.operations.some((o) => o.operationId === operationId);
  const suggestions = found ? [] : def.operations.filter((o) => o.operationId.toLowerCase().includes(operationId.toLowerCase().slice(0, 4))).map((o) => o.operationId).slice(0, 5);
  return { known: true, connector: connectorName, operationFound: found, suggestions, message: found ? null : `operation '${operationId}' not found in ${connectorName}${suggestions.length ? ` (similar: ${suggestions.join(", ")})` : ""}` };
}

/** Automatic inputs for a connector operation: required, non-internal parameters. */
export function inputsFromOperation(op: ConnectorOperation): { kind: "automatic"; name: string; description: string; entity?: string }[] {
  const entityFor = (t: string | null): string | undefined => (t === "integer" || t === "number" ? "Number" : t === "boolean" ? "Boolean" : undefined);
  return op.parameters
    .filter((p) => p.required && p.visibility !== "internal")
    .map((p) => ({ kind: "automatic" as const, name: p.name, description: p.summary ?? p.description ?? p.name, ...(entityFor(p.type) ? { entity: entityFor(p.type) } : {}) }));
}
