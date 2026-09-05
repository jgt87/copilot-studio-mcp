# copilot-studio-mcp

An MCP server that lets a coding agent in VS Code (GitHub Copilot agent mode) or Claude Code do
Microsoft Copilot Studio agent development from the terminal: scaffold or clone an agent, add
topics, knowledge sources, tools (connector / MCP / flow), flows and triggers as YAML, validate,
push and publish, run evaluations, and chat-test the published agent.

It wraps the official Power Platform CLI (`pac copilot`) for sync, writes the same YAML workspace
the Copilot Studio VS Code extension uses, and calls the Power Platform, Dataverse, BAP and
DirectLine APIs directly for everything the CLI does not cover.

## What is and is not possible (feasibility summary)

| Capability | How | Status |
| --- | --- | --- |
| Agent as files, sync both ways | `pac copilot init / clone / pull / push / pack / publish` | official, GA |
| Topics, knowledge, tools, triggers, flows as YAML | workspace layout of the VS Code extension and `pac copilot push` | official |
| Local validation | JSON schema from microsoft/skills-for-copilot-studio (MIT) + structural checks | this server |
| Run evaluations, read results | Power Platform API `makerevaluation` endpoints | official, GA, standard harness |
| Chat with the published agent | DirectLine v3 (no-auth / manual-auth agents) or Copilot Studio client SDK (Entra SSO) | official |
| Publish | `pac copilot publish` or Dataverse `PvaPublish` | official |

Hard limits the server works around rather than hides:

1. **Evaluation test sets cannot be created through the API.** `cs_create_test_set_csv` writes
   the CSV the portal imports (max 100 cases); after one import, runs and results are automated.
2. **Connector, MCP and prompt tools need a connection that only the portal can authorise.**
   `cs_add_tool` writes the YAML and the connection-reference stub and returns the portal step.
3. **Evaluations and topic YAML are standard-harness features.** GitHub Copilot harness agents
   (`--authoring-mode cli-copilot`) get init / pack / import / instructions / chat only.

Verified offline against pac 2.11.2: `pac copilot pack` on a workspace created by `pac copilot init`
(without `--environment`) packages **settings, agent and topics only** and rejects `knowledge/`,
`actions/`, `tools/`, `trigger/`, `variables/`, `workflows/` and `connectionreferences.mcs.yml`.
Those folders are handled by `pac copilot push` from a sync-connected workspace (clone, or init
with `--environment`). The authoring tools tell you when you are in a pack-only workspace.

## Prerequisites

- Node.js 20+
- .NET 10 SDK and the Power Platform CLI: `dotnet tool install --global Microsoft.PowerApps.CLI.Tool`
  (if the SDK is installed in your user profile, set `DOTNET_ROOT` to that folder; the server
  defaults it to `~/.dotnet` when present)
- For sync commands: a pac auth profile, created interactively once: `pac auth create --environment <id or URL>`
- For cloud tools (evaluations, environments, publish via Dataverse, chat): an Entra sign-in via
  `cs_login`. By default the first-party VS Code client id is used (no app registration needed);
  set `CPS_CLIENT_ID` to use your own. Entra-SSO agents additionally need your own app registration
  with the delegated permission `CopilotStudio.Copilots.Invoke` for `cs_chat`.

## Install and register

```sh
git clone https://github.com/jgt87/copilot-studio-mcp.git
cd copilot-studio-mcp
npm install
npm run build
```

VS Code (`.vscode/mcp.json` in your workspace, or the user-level `mcp.json`):

```json
{
  "servers": {
    "copilot-studio": {
      "type": "stdio",
      "command": "node",
      "args": ["<path-to-this-repo>/dist/index.js"],
      "env": { "CPS_WORKSPACE": "${workspaceFolder}" }
    }
  }
}
```

Claude Code (user scope):

```sh
claude mcp add-json copilot-studio '{"type":"stdio","command":"node","args":["<path-to-this-repo>/dist/index.js"]}' --scope user
```

Environment variables (all optional): `CPS_WORKSPACE`, `CPS_TENANT_ID`, `CPS_CLIENT_ID`,
`CPS_ENVIRONMENT_ID`, `CPS_ENVIRONMENT_URL`, `CPS_AGENT_ID`, `CPS_CACHE_DIR`, `PAC_PATH`, `DOTNET_ROOT`.

## Tools

Setup and sync (pac)

| Tool | Purpose |
| --- | --- |
| `cs_doctor` | pac / .NET / auth profiles / sign-in / workspace detection |
| `cs_login`, `cs_login_status`, `cs_logout` | MSAL sign-in (interactive or device code) for the cloud tools |
| `cs_list_environments`, `cs_list_agents` | environments (BAP) and agents (pac or Dataverse) |
| `cs_init_agent` | `pac copilot init` (classic or cli-copilot), optional bootstrap into an environment |
| `cs_clone_agent`, `cs_pull`, `cs_push`, `cs_status` | sync a live agent with the workspace |
| `cs_pack`, `cs_import_solution`, `cs_publish` | package, import, publish |
| `cs_pac` | run any pac command (read-only ones immediately, others with `confirm`) |

Authoring (files, schema-validated)

| Tool | Purpose |
| --- | --- |
| `cs_describe_workspace` | inventory of settings, topics, knowledge, tools, flows, triggers, variables |
| `cs_validate` | structural + cross-file validation; `cs_push` runs it first |
| `cs_lookup_schema` | inspect the YAML schema (summaries, resolved definitions, kinds) |
| `cs_add_topic` | topic from a declarative spec (phrases + message/question/condition/redirect/http/flow nodes) |
| `cs_add_knowledge_source` | public website, SharePoint, Graph connector, or files |
| `cs_add_tool` | connector action, MCP server, or cloud flow tool (+ connection-reference stub) |
| `cs_add_flow` | experimental cloud-flow scaffold (`workflows/<Name>/metadata.yaml` + `workflow.json`) |
| `cs_add_trigger`, `cs_add_variable` | event trigger for a flow; global variable |
| `cs_update_agent`, `cs_update_settings` | instructions, conversation starters, model, settings |

Evaluation and testing (cloud)

| Tool | Purpose |
| --- | --- |
| `cs_create_test_set_csv` | CSV for the portal's Evaluation import, optionally suggested from the workspace |
| `cs_list_test_sets`, `cs_run_evaluation`, `cs_get_evaluation_run`, `cs_list_evaluation_runs` | Power Platform API evaluations with pass/fail summaries |
| `cs_chat` | one utterance to the published agent (DirectLine or SDK), multi-turn via `conversationId` |
| `cs_run_conversation_tests` | YAML test file of utterances + expectations, run through `cs_chat` |

Every tool that mutates a live environment (`cs_push`, `cs_publish`, `cs_import_solution`,
`cs_run_evaluation`, bootstrap `cs_init_agent`, non-read-only `cs_pac`) returns a dry run unless
called with `confirm: true`.

## How it fits together

```mermaid
flowchart LR
    subgraph Client["Coding agent"]
        VS["VS Code / GitHub Copilot"]
        CC["Claude Code"]
    end
    subgraph MCP["copilot-studio-mcp"]
        SYNC["Sync<br/>pac copilot"]
        AUTH["Authoring<br/>YAML + schema validation"]
        CLOUD["Cloud<br/>evaluations, publish, chat"]
    end
    WS[("Agent workspace<br/>topics/, knowledge/, actions/, workflows/")]
    DV["Dataverse / Copilot Studio"]
    PPAPI["Power Platform API"]
    DL["Published agent<br/>DirectLine / SDK"]

    VS --> MCP
    CC --> MCP
    AUTH <--> WS
    SYNC <--> WS
    SYNC <--> DV
    CLOUD --> PPAPI
    CLOUD --> DV
    CLOUD --> DL
```

## Typical flows

All diagrams, including existing-agent sync, chat routing and the connection step for tools, are in
[docs/flows.md](docs/flows.md).

New agent (standard harness):

```mermaid
flowchart TD
    A["cs_doctor"] --> C["cs_init_agent<br/>environment + confirm"]
    C --> D["cs_update_agent<br/>instructions"]
    D --> E["cs_add_topic / cs_add_knowledge_source / cs_add_tool"]
    E --> H["cs_validate"]
    H -- errors --> E
    H -- clean --> I["cs_push confirm"]
    I --> J{"tool needs a connection?"}
    J -- yes --> J1["portal: authorise once"] --> J2["cs_pull"] --> K
    J -- no --> K["cs_publish confirm"]
    K --> L["cs_chat"]
```

Evaluation loop (test sets are imported once in the portal; runs and results are automated):

```mermaid
flowchart TD
    A["cs_create_test_set_csv"] --> B["portal: Evaluation > Import CSV"]
    B --> C["cs_list_test_sets"] --> D["cs_run_evaluation confirm wait"]
    D --> E["cs_get_evaluation_run"] --> F{"failures?"}
    F -- yes --> G["fix topics / instructions / knowledge"] --> H["cs_push confirm"] --> D
    F -- no --> I["cs_publish confirm"]
```

Existing agent: `cs_clone_agent` -> edit -> `cs_pull` -> `cs_validate` -> `cs_push confirm`.

## Development

```sh
npm test                      # build + unit tests (fixtures, no network)
node scripts/smoke.mjs        # drive the built server over stdio
node scripts/oracle-pack.mjs  # pac copilot init + authoring tools + pac copilot pack
```

`reference/bot.schema.yaml-authoring.json` and `reference/templates` come from
microsoft/skills-for-copilot-studio (MIT, see `reference/LICENSE.skills-for-copilot-studio.txt`).
Fixtures under `test/fixtures/pac-*` were generated with `pac copilot init`.

MIT licensed.
