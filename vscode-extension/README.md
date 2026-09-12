# Copilot Studio MCP for VS Code

Builds Microsoft Copilot Studio agents from files, inside VS Code's agent mode.

This extension contributes one MCP server: [`copilot-studio-mcp`](https://www.npmjs.com/package/copilot-studio-mcp).
The server wraps the Power Platform CLI (`pac copilot`) for workspace sync, writes the YAML workspace
the Copilot Studio VS Code extension uses, and calls the Power Platform, Dataverse, BAP and
DirectLine APIs for the things the CLI does not cover - evaluations, publish and chat-testing.

The server ships inside the extension, so there is nothing to `npm install` and no network fetch on
first run.

## What you can ask for

- "Clone the HR agent into this folder" - `cs_clone_agent`
- "Add a topic that answers questions about parental leave" - `cs_add_topic`
- "Point the agent's knowledge at our public docs site" - `cs_add_knowledge_source`
- "Check this agent for problems before I push" - `cs_review_agent`, `cs_validate`
- "Send my changes up and publish them" - `cs_push`, then `cs_publish`
- "Why did that flow run fail?" - `cs_explain_flow_run`
- "What changed in the portal since I last synced?" - `cs_check_drift`

Start a session with `cs_init`: it reports whether `pac` is installed, who is signed in, what the
workspace contains, and what to do next.

## Requirements

- **Power Platform CLI (`pac`)** on PATH, for everything that syncs a workspace.
  Install it with `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`, or point
  `copilotStudioMcp.pacPath` at it. Sign in once with `pac auth create --environment <id>`.
- **Node 20 or newer** on PATH is recommended but not required. Without it the server runs on the
  editor's own Node, which cannot load the native token cache, so sign-ins are not remembered
  between sessions.

## Safety

Every tool that can change a live Copilot Studio environment returns a dry run and does nothing
else until it is called again with `confirm: true`. Local file authoring needs no approval; sending
those files to Copilot Studio does.

Set `copilotStudioMcp.readOnly` to withhold the environment-changing tools entirely.

## Settings

| Setting | Effect |
| --- | --- |
| `copilotStudioMcp.tools` | Tool preset or allow-list: `core`, `authoring`, `admin`, `solutions`, `full`, or a comma-separated list of names and globs. The full list is ~140 tools, which a smaller model chooses badly from. |
| `copilotStudioMcp.readOnly` | Withhold every environment-changing tool. |
| `copilotStudioMcp.workspaceFolder` | Agent workspace the server starts from. Defaults to the first folder open in VS Code. |
| `copilotStudioMcp.environmentId`, `.environmentUrl`, `.tenantId` | Defaults used when a call and the workspace do not name an environment. |
| `copilotStudioMcp.clientId` | Your own app registration, if the first-party client id is blocked in your tenant. |
| `copilotStudioMcp.pacProfile`, `.adminProfile` | Which `pac` auth profile maker and admin commands use. |
| `copilotStudioMcp.pacPath` | Full path to `pac` when it is not on PATH. |
| `copilotStudioMcp.nodePath` | Node executable used to run the server. |
| `copilotStudioMcp.serverPath` | Run a local checkout of the server instead of the bundled copy. |

Run **Copilot Studio MCP: Show Server Info** from the command palette to see the command, arguments
and environment the server is actually started with.

## Documentation

- [README and workflows](https://github.com/jgt87/copilot-studio-mcp#readme)
- [Tool table](https://cdn.jsdelivr.net/npm/copilot-studio-mcp/docs/tools.md)
- [Flow diagrams](https://cdn.jsdelivr.net/npm/copilot-studio-mcp/docs/flows.md)
- [Authentication and app registration](https://github.com/jgt87/copilot-studio-mcp#authentication-and-app-registration)
  names the API and permission each cloud tool needs.

## License

MIT. Not affiliated with or endorsed by Microsoft.
