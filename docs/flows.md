# Flows: building Copilot Studio agents through this MCP

Diagrams are Mermaid; GitHub renders them inline. Tool names are the MCP tools listed in [tools.md](tools.md); the README describes the workflows.
Steps marked **confirm** only run when called with `confirm: true`; otherwise they return a dry run.

## Architecture

```mermaid
flowchart LR
    VS["VS Code / GitHub Copilot agent mode"] --> TOOLS
    CC["Claude Code"] --> TOOLS
    subgraph SERVER["copilot-studio-mcp (stdio)"]
        TOOLS["MCP tool call"] --> SYNC["Sync layer: pac copilot init, clone, pull, push, pack, publish"]
        TOOLS --> AUTH["Authoring layer: topics, knowledge, tools, flows, triggers, variables; schema validation"]
        TOOLS --> CLOUD["Cloud layer: MSAL, Power Platform API, Dataverse, BAP, DirectLine, SDK"]
    end
    AUTH --> WS["Agent workspace on disk: agent.mcs.yml, settings.mcs.yml, topics, knowledge, actions, workflows"]
    SYNC --> PAC["pac CLI"]
    PAC --> WS
    PAC --> DV["Dataverse: the agent definition"]
    DV --> CS["Copilot Studio portal"]
    CLOUD --> PPAPI["Power Platform API: evaluations"]
    CLOUD --> DV
    CLOUD --> DL["Published agent: DirectLine or Copilot Studio client"]
```

## Flow 1: new agent from scratch (standard harness)

```mermaid
flowchart TD
    A["cs_init<br/>pac, .NET, auth profile, sign-in"] --> B{"pac auth profile?"}
    B -- no --> B1["terminal: pac auth create --environment ID"] --> S
    B -- yes --> S["cs_list_solutions<br/>pick an unmanaged solution,<br/>or cs_create_solution confirm"]
    S --> C["cs_create_agent<br/>name, publisherPrefix, projectDir,<br/>environment + solutionName confirm<br/>(init, pack, import, clone)"]
    C --> D["cs_generate_instructions<br/>brief -> AI Builder prompt (cs_list_prompts)<br/>review, then apply"]
    D --> E["cs_add_topic<br/>trigger phrases + message / question / condition / set variable /<br/>redirect / HTTP / flow / generative answers / adaptive card / transfer / end nodes"]
    E --> F["cs_add_knowledge_source<br/>public-site | sharepoint | graph-connector | files"]
    F --> G["cs_add_tool<br/>connector | mcp | flow | prompt | agent<br/>(cs_list_connectors, cs_describe_connector)"]
    G --> R["cs_review_agent<br/>score and fixes"]
    R --> H["cs_validate"]
    H -- errors --> E
    H -- clean --> I["cs_push confirm"]
    I --> J{"tool needs a connection?"}
    J -- yes --> J1["portal: authorise the connection once"] --> J2["cs_pull"] --> K
    J -- no --> K["cs_publish confirm"]
    K --> L["cs_chat<br/>smoke-test the published agent"]
    L --> M["Flow 3: evaluations"]
```

Without `environment`, `cs_create_agent` scaffolds locally and `cs_pack` + `cs_import_solution` deploy
it; on that path only settings, agent and topics are packaged (verified with pac 2.11.2), so add
knowledge and tools after cloning the imported agent.

| Step (MCP tool) | The same action in Copilot Studio |
| --- | --- |
| `cs_init`, `pac auth create` | none in the portal; signing in to Power Platform from your machine |
| `cs_list_solutions`, `cs_create_solution` | Power Apps maker portal > Solutions: choose or create the solution the agent lives in |
| `cs_create_agent` | Copilot Studio > Create > New agent (name, publisher) inside that solution; the default system topics are created |
| `cs_generate_instructions` | Overview > Instructions, generated with AI and then reviewed |
| `cs_add_topic` | Topics > Add a topic > From blank; trigger phrases and the message, question, condition, set variable, redirect, HTTP, generative answers, adaptive card, transfer and end conversation nodes in the authoring canvas |
| `cs_add_knowledge_source` | Knowledge > Add knowledge (public website, SharePoint, Graph connector, files) |
| `cs_add_tool` | Tools > Add a tool: pick the connector action, MCP server, flow, prompt or agent |
| `cs_review_agent` | a maker's pre-publish walkthrough: instructions, escalation, tool descriptions, phrase overlap, authentication versus knowledge; no single portal page does this |
| `cs_validate` | the validation the portal runs when you save a node or topic |
| `cs_push` | Save: the draft agent in the portal reflects the local files |
| portal: authorise the connection | Tools > the tool > Connect: sign in to the connector once |
| `cs_pull` | refresh the local files with what the portal now holds (the connection id) |
| `cs_publish` | Publish |
| `cs_chat` | the Test pane against the published agent |

## Flow 2: existing agent

```mermaid
flowchart TD
    A["cs_list_environments"] --> B["cs_list_agents<br/>pac or Dataverse"]
    B --> C["cs_clone_agent<br/>bot id or schema name"]
    C --> D["cs_describe_workspace<br/>inventory: topics, knowledge, tools, flows, triggers"]
    D --> D2{"cs_check_drift<br/>changed in the portal since the last sync?"}
    D2 -- yes --> D3["cs_pull, then commit"] --> E
    D2 -- no --> E["edit: cs_edit_topic / cs_edit_tool / cs_edit_knowledge<br/>cs_remove_component confirm / cs_add_* / cs_update_agent<br/>or hand-edit YAML"]
    E --> E2["cs_review_agent"]
    E2 --> F["cs_pull<br/>merge server changes first"]
    F --> G["cs_validate"]
    G -- errors --> E
    G -- clean --> H["cs_push confirm"]
    H -- conflict --> F
    H -- ok --> I["cs_publish confirm"]
```

| Step (MCP tool) | The same action in Copilot Studio |
| --- | --- |
| `cs_list_environments`, `cs_list_agents` | the environment picker and the Agents list |
| `cs_clone_agent` | opening the agent and getting its full definition as files (what the VS Code extension's Clone does) |
| `cs_describe_workspace` | reading the Overview, Topics, Knowledge and Tools pages at once |
| `cs_check_drift` | reading the "modified by" line of each topic, tool and knowledge source to see what colleagues changed since you last synced (Flow 8) |
| `cs_add_*`, `cs_update_agent` | adding topics, knowledge and tools, editing instructions in the portal |
| `cs_edit_topic`, `cs_edit_tool`, `cs_edit_knowledge` | opening an existing topic, tool or knowledge source and changing its phrases, nodes, description, inputs or site |
| `cs_remove_component` | deleting a topic, knowledge source, tool, trigger or variable from the agent; unused connection references go with the tool |
| `cs_review_agent` | a maker's pre-publish walkthrough of the agent |
| `cs_pull` | picking up edits other makers made in the portal since the clone |
| `cs_delete_agent`, `cs_delete_solution` | Agents > delete; Power Apps maker portal > Solutions > delete (both behind `confirm`) |
| `cs_validate`, `cs_push` | Save |
| `cs_publish` | Publish |

## Flow 3: evaluation loop

The evaluation API can list and run test sets but not create them, so the import happens once in the
portal; every later run is automated.

```mermaid
flowchart TD
    A["cs_create_test_set_csv<br/>suggestFromWorkspace or explicit cases<br/>(max 100)"] --> B["portal: Evaluation > New evaluation > Import CSV<br/>choose test methods, save"]
    B --> C["cs_list_test_sets<br/>get the test set id"]
    C --> D["cs_run_evaluation confirm<br/>draft or published agent, wait"]
    D --> E["cs_get_evaluation_run<br/>per-case results, pass / fail per method"]
    E --> F{"failures?"}
    F -- yes --> G["fix topics / instructions / knowledge"] --> H["cs_push confirm"] --> D
    F -- no --> I["cs_publish confirm"]
```

The evaluation API allows 20 runs per agent per 24 hours.

| Step (MCP tool) | The same action in Copilot Studio |
| --- | --- |
| `cs_create_test_set_csv` | Evaluation > New evaluation > Single responses > Import: the CSV you would fill in by hand |
| portal import | Evaluation > Import the CSV, choose test methods, Save (the one step the API cannot do) |
| `cs_list_test_sets` | the Test sets list on the Evaluation page |
| `cs_run_evaluation` | Run on a test set (draft or published agent) |
| `cs_get_evaluation_run` | the results view: per test case, per test method, pass or fail |
| `cs_push`, `cs_publish` | Save and Publish after fixing what failed |

## Flow 4: chat-testing a published agent

```mermaid
flowchart TD
    A["cs_chat utterance<br/>or cs_run_conversation_tests file"] --> B{"transport"}
    B -- auto --> C["Dataverse: read authenticationmode"]
    C -- "1 no auth / 3 manual" --> D["DirectLine v3<br/>token endpoint from environment id + schema name<br/>(no app registration)"]
    C -- "2 Entra SSO" --> E["Copilot Studio client SDK<br/>your app id + CopilotStudio.Copilots.Invoke"]
    B -- directline --> D
    B -- sdk --> E
    D --> F["replies, activities, conversationId"]
    E --> F
    F --> G{"sign-in card?"}
    G -- yes --> H["signInUrl returned; complete sign-in, resend"]
    G -- no --> I["expectations: contains / notContains / regex / minLength"]
```

| Step (MCP tool) | The same action in Copilot Studio |
| --- | --- |
| `cs_chat` | typing in the Test pane; the published agent answers through its web channel (DirectLine) or, for Entra-SSO agents, the same path a custom app uses (Copilot Studio client) |
| sign-in card | the "Sign in" card the Test pane shows for authenticated agents |
| `cs_run_conversation_tests` | repeating a scripted set of Test pane conversations and checking the answers |

## Flow 5: adding a tool that needs a connection

```mermaid
sequenceDiagram
    participant Agent as Coding agent
    participant MCP as copilot-studio-mcp
    participant WS as Workspace files
    participant PAC as pac
    participant Portal as Copilot Studio portal

    Agent->>MCP: cs_add_tool type=connector, connectorId, operationId
    MCP->>WS: actions/Name.mcs.yml + connectionreferences.mcs.yml stub
    MCP-->>Agent: yaml, validation, portalStep
    Agent->>MCP: cs_push confirm
    MCP->>PAC: pac copilot push
    PAC-->>MCP: pushed
    Agent->>Portal: open agent > Tools, authorise the connection
    Agent->>MCP: cs_pull
    MCP->>PAC: pac copilot pull
    PAC->>WS: connection id lands in connectionreferences.mcs.yml
    Agent->>MCP: cs_publish confirm, then cs_chat
```

## Flow 6: pull a whole solution and redeploy it 1:1

Solution export/import is the vehicle for moving between environments; per-agent sync workspaces
stay bound to their source environment.

```mermaid
flowchart TD
    A["cs_list_solutions<br/>source environment"] --> B["cs_describe_solution<br/>agents, flows, connection references,<br/>environment variables, connectors"]
    B --> C["cs_pull_solution targetDir<br/>export unmanaged + managed zips<br/>unpack to src/<br/>deployment-settings.json<br/>clone every agent to agents/"]
    C --> D["cs_list_connections<br/>target environment"]
    D --> E["cs_create_deployment_settings<br/>map connection references to target connection ids<br/>set environment variable values"]
    E --> F{"anything unmapped?"}
    F -- yes --> D
    F -- no --> G["cs_deploy_solution confirm<br/>pac solution import with settings file"]
    G --> H["publish each agent in the target<br/>(automatic)"]
    H --> I["portal checks: tool connections,<br/>knowledge outside the solution, channels"]
    C -.-> J["optional edits before deploying:<br/>agents/name workspaces (cs_push to the source),<br/>or src/ then cs_pack_solution"]
    J -.-> G
```

| Step (MCP tool) | The same action in Copilot Studio / Power Apps |
| --- | --- |
| `cs_list_solutions` | Power Apps maker portal > Solutions in the source environment |
| `cs_describe_solution` | opening the solution and reading its component list (agents, flows, connection references, environment variables) |
| `cs_pull_solution` | Solutions > Export solution (unmanaged and managed), plus opening each agent in Copilot Studio; the agents come down as editable workspaces |
| `cs_list_connections` | Power Automate or Power Apps > Connections in the target environment |
| `cs_create_deployment_settings` | the "Connections" and "Environment variables" pages of the Import solution wizard, filled in ahead of time |
| `cs_deploy_solution` | Solutions > Import solution in the target, then Publish on each agent in Copilot Studio |
| portal checks | Copilot Studio > agent > Tools (Connect), Knowledge, Channels in the target |

## Flow 7: compare environments in a DTAP pipeline

```mermaid
flowchart LR
    subgraph Capture["cs_snapshot_environment (per stage)"]
        D["DEV"] --> S1["snapshots/DEV"]
        T["TEST"] --> S2["snapshots/TEST"]
        AC["ACC"] --> S3["snapshots/ACC"]
        P["PROD"] --> S4["snapshots/PROD"]
    end
    S1 --> C1["cs_compare_snapshots<br/>DEV vs TEST"]
    S2 --> C1
    S2 --> C2["cs_compare_snapshots<br/>TEST vs ACC"]
    S3 --> C2
    S3 --> C3["cs_compare_snapshots<br/>ACC vs PROD"]
    S4 --> C3
    C1 --> R["reports/*.md + *.json<br/>DRIFT or no drift<br/>failOnDrift gates the pipeline"]
    C2 --> R
    C3 --> R
    R --> F{"drift?"}
    F -- "agent YAML / version" --> G["promote again: cs_pull_solution -> cs_deploy_solution"]
    F -- "connections / variables / flows" --> H["fix deployment settings, redeploy"]
    F -- "unpublished changes" --> I["cs_publish in that stage"]
```

`cs_compare_environments` runs the whole chain in one call.

| Step (MCP tool) | The same action in Copilot Studio / Power Apps |
| --- | --- |
| `cs_snapshot_environment` | opening each agent in every environment and noting its topics, knowledge, tools and publish state; Solutions > version; Power Automate > flow state; Connections; environment variable values |
| `cs_compare_snapshots` | comparing those notes by hand between two environments (no portal feature does this) |
| `cs_compare_environments` | the same across the whole DEV, TEST, ACC, PROD chain |
| `cs_list_pipelines`, `cs_deploy_pipeline` | Power Platform pipelines: Deploy to the next stage from the pipelines app, when the tenant uses pipelines instead of solution import |
| `cs_check_solution` | Solution Checker on the exported zip before promoting |
| follow-up | promote again with the solution flow, fix deployment settings, or Publish in the stage that has unpublished changes |

## Flow 8: portal drift (changes made directly in Copilot Studio)

```mermaid
flowchart TD
    A["cs_clone_agent / cs_pull / cs_push<br/>write .mcs/cs-sync.json<br/>file fingerprints + component stamps"] --> B["a maker edits the agent<br/>in Copilot Studio"]
    B --> C["cs_check_drift quick<br/>Dataverse: bot row + component rows vs stamp"]
    C --> D{"changed in the portal?"}
    D -- no --> E["edit locally"]
    D -- "yes, not touched locally" --> F["cs_pull (three-way merge)<br/>git commit"] --> E
    D -- "yes, also changed locally" --> G["cs_check_drift full<br/>temporary clone, per-file diff"]
    G --> H["decide per file: keep local, take portal, merge"] --> F
    E --> I["cs_push dry run<br/>repeats the quick check"]
    I -- conflict --> F
    I -- clean --> J["cs_push confirm"]
```

| Step (MCP tool) | The same action in Copilot Studio |
| --- | --- |
| sync stamp (automatic) | none; the portal keeps a modified-on and modified-by stamp per topic, tool and knowledge source |
| `cs_check_drift` quick | opening each topic, tool and knowledge source and reading its "modified by" line, plus the agent's unpublished-changes banner |
| `cs_check_drift` full | opening the agent side by side with your local files and comparing them node by node |
| `cs_pull` | taking over the portal version of what changed there, merged with your local edits |
| git commit | none; the portal has no history of who changed what over time |
| `cs_push` | Save; refused when a maker changed the same component since your last pull |

## The confirm contract

```mermaid
sequenceDiagram
    participant Agent as Coding agent
    participant MCP as copilot-studio-mcp
    participant Env as Live environment

    Agent->>MCP: cs_publish (no confirm)
    MCP-->>Agent: dryRun: true, wouldDo: "publish agent X ...", hint
    Agent->>Agent: show the user what will happen
    Agent->>MCP: cs_publish confirm=true
    MCP->>Env: PvaPublish / pac copilot publish
    Env-->>MCP: publishedon changed
    MCP-->>Agent: result
```
