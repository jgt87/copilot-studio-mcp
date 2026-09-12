/**
 * VS Code wrapper for copilot-studio-mcp.
 *
 * The extension itself does no Copilot Studio work. It contributes one MCP
 * server definition so that VS Code (Copilot Chat / agent mode) starts the
 * stdio server bundled under `server/` in this extension, with the CPS_*
 * environment the user configured in settings.
 *
 * The server is plain Node, so the only interesting decision here is which
 * Node runs it - see `resolveNode`.
 */
import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

const PROVIDER_ID = "copilot-studio";
const SECTION = "copilotStudioMcp";
const LABEL = "Copilot Studio";
const MIN_NODE_MAJOR = 20;

let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("Copilot Studio MCP");
  context.subscriptions.push(output);

  const changed = new vscode.EventEmitter<void>();
  context.subscriptions.push(changed);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(SECTION)) {
        nodeChoice = undefined;
        changed.fire();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
  );

  const provider: vscode.McpServerDefinitionProvider<vscode.McpStdioServerDefinition> = {
    onDidChangeMcpServerDefinitions: changed.event,
    provideMcpServerDefinitions: () => [buildDefinition(context)],
    resolveMcpServerDefinition: (server) => server,
  };
  context.subscriptions.push(vscode.lm.registerMcpServerDefinitionProvider(PROVIDER_ID, provider));

  context.subscriptions.push(
    vscode.commands.registerCommand(`${SECTION}.showServerInfo`, () => {
      const def = buildDefinition(context);
      output.appendLine("--- copilot-studio-mcp ---");
      output.appendLine(`server version : ${def.version ?? "unknown"}`);
      output.appendLine(`command        : ${def.command}`);
      output.appendLine(`args           : ${def.args.join(" ")}`);
      output.appendLine(`cwd            : ${def.cwd?.fsPath ?? "(extension host)"}`);
      output.appendLine("env            :");
      for (const [k, v] of Object.entries(def.env)) output.appendLine(`  ${k}=${v}`);
      output.show(true);
    }),
  );
}

export function deactivate(): void {
  /* the server is owned by VS Code's MCP host; nothing to tear down */
}

function buildDefinition(context: vscode.ExtensionContext): vscode.McpStdioServerDefinition {
  const entry = serverEntry(context);
  const node = resolveNode();
  const def = new vscode.McpStdioServerDefinition(
    LABEL,
    node.command,
    [entry],
    { ...node.env, ...serverEnv() },
    serverVersion(entry),
  );
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) def.cwd = folder.uri;
  return def;
}

/** `dist/index.js` of the bundled server, or of the checkout named by `serverPath`. */
function serverEntry(context: vscode.ExtensionContext): string {
  const configured = str("serverPath");
  if (configured) {
    const resolved = path.resolve(expand(configured));
    if (resolved.endsWith(".js")) return resolved;
    const candidate = path.join(resolved, "dist", "index.js");
    if (fs.existsSync(candidate)) return candidate;
    vscode.window.showWarningMessage(
      `copilotStudioMcp.serverPath does not contain dist/index.js (${resolved}); using the bundled server.`,
    );
  }
  return context.asAbsolutePath(path.join("server", "dist", "index.js"));
}

/** Shown to VS Code so it re-reads the tool list when the bundled server changes. */
function serverVersion(entry: string): string | undefined {
  try {
    const pkg = path.resolve(path.dirname(entry), "..", "package.json");
    return JSON.parse(fs.readFileSync(pkg, "utf8")).version as string;
  } catch {
    return undefined;
  }
}

type NodeChoice = { command: string; env: Record<string, string | number | null> };
let nodeChoice: NodeChoice | undefined;

/**
 * Prefer a real Node on PATH: the server's optional persistent token cache
 * (@azure/msal-node-extensions) loads a native module, and the copies bundled
 * here are built for Node on this platform. Electron-as-Node is the fallback
 * so the extension still works with no Node installed - the server then keeps
 * tokens in memory only, which it says on stderr.
 */
function resolveNode(): NodeChoice {
  if (nodeChoice) return nodeChoice;

  const configured = str("nodePath");
  if (configured) {
    nodeChoice = { command: expand(configured), env: {} };
    return nodeChoice;
  }

  try {
    const version = execFileSync("node", ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
    const major = Number(/^v(\d+)/.exec(version)?.[1]);
    if (major >= MIN_NODE_MAJOR) {
      output?.appendLine(`using node ${version} from PATH`);
      nodeChoice = { command: "node", env: {} };
      return nodeChoice;
    }
    output?.appendLine(`node ${version} on PATH is older than ${MIN_NODE_MAJOR}; using the editor's Node instead`);
  } catch {
    output?.appendLine("no node on PATH; using the editor's Node instead");
  }

  nodeChoice = { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: "1" } };
  return nodeChoice;
}

/** Settings that map one-for-one onto the server's CPS_* / PAC_* environment. */
function serverEnv(): Record<string, string | number | null> {
  const env: Record<string, string | number | null> = {};

  const workspace = str("workspaceFolder") ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (workspace) env.CPS_WORKSPACE = expand(workspace);

  if (vscode.workspace.getConfiguration(SECTION).get<boolean>("readOnly")) env.CPS_READ_ONLY = "1";

  const map: Record<string, string> = {
    tools: "CPS_TOOLS",
    toolsExclude: "CPS_TOOLS_EXCLUDE",
    environmentId: "CPS_ENVIRONMENT_ID",
    environmentUrl: "CPS_ENVIRONMENT_URL",
    tenantId: "CPS_TENANT_ID",
    clientId: "CPS_CLIENT_ID",
    pacProfile: "CPS_PAC_PROFILE",
    adminProfile: "CPS_ADMIN_PROFILE",
    pacPath: "PAC_PATH",
  };
  for (const [setting, variable] of Object.entries(map)) {
    const value = str(setting);
    if (value) env[variable] = variable === "PAC_PATH" ? expand(value) : value;
  }
  return env;
}

function str(key: string): string | undefined {
  const value = vscode.workspace.getConfiguration(SECTION).get<string>(key);
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Supports ${workspaceFolder} and ${userHome} the way settings elsewhere do. */
function expand(value: string): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "";
  return value
    .replace(/\$\{workspaceFolder\}/g, folder)
    .replace(/\$\{userHome\}/g, process.env.HOME ?? process.env.USERPROFILE ?? "");
}
