# Flows: building Copilot Studio agents through this MCP

Diagrams are Mermaid; GitHub renders them inline. Tool names are the MCP tools from the README.
Steps marked **confirm** only run when called with `confirm: true`; otherwise they return a dry run.

## Architecture

```mermaid
flowchart LR
    subgraph Client["Coding agent"]
        VS["VS Code / GitHub Copilot agent mode"]
        CC["Claude Code"]
    end
    subgraph MCP["copilot-studio-mcp (stdio)"]
        SYNC["Sync layer<br/>pac copilot init / clone / pull / push / pack / publish"]
        AUTH["Authoring layer<br/>topics, knowledge, tools, flows, triggers, variables<br/>schema validation"]
        CLOUD["Cloud layer<br/>MSAL + Power Platform API, Dataverse, BAP, DirectLine / SDK"]
    end
    WS[("Agent workspace<br/>agent.mcs.yml, settings.mcs.yml,<br/>topics/, knowledge/, actions/, workflows/")]
    PAC["pac CLI"]
    DV["Dataverse<br/>(agent definition)"]
    CS["Copilot Studio portal"]
    PPAPI["Power Platform API<br/>evaluations"]
    DL["DirectLine / Copilot Studio client<br/>published agent"]

    VS --> MCP
    CC --> MCP
    AUTH <--> WS
    SYNC --> PAC
    PAC <--> WS
    PAC <--> DV
    DV <--> CS
    CLOUD --> PPAPI
    CLOUD --> DV
    CLOUD --> DL
```

## Flow 1: new agent from scratch (standard harness)

```mermaid
flowchart TD
    A["cs_doctor<br/>pac, .NET, auth profile, sign-in"] --> B{"pac auth profile?"}
    B -- no --> B1["terminal: pac auth create --environment ID"] --> C
    B -- yes --> C["cs_init_agent<br/>name, publisherPrefix, projectDir,<br/>environment (bootstrap) confirm"]
    C --> D["cs_update_agent<br/>instructions, conversation starters"]
    D --> E["cs_add_topic<br/>trigger phrases + message / question / condition / redirect nodes"]
    E --> F["cs_add_knowledge_source<br/>public-site | sharepoint | graph-connector | files"]
    F --> G["cs_add_tool<br/>connector | mcp | flow"]
    G --> H["cs_validate"]
    H -- errors --> E
    H -- clean --> I["cs_push confirm"]
    I --> J{"tool needs a connection?"}
    J -- yes --> J1["portal: authorise the connection once"] --> J2["cs_pull"] --> K
    J -- no --> K["cs_publish confirm"]
    K --> L["cs_chat<br/>smoke-test the published agent"]
    L --> M["Flow 3: evaluations"]
```

Without `environment`, `cs_init_agent` scaffolds locally and `cs_pack` + `cs_import_solution` deploy
it; on that path only settings, agent and topics are packaged (verified with pac 2.11.2), so add
knowledge and tools after cloning the imported agent.

## Flow 2: existing agent

```mermaid
flowchart TD
    A["cs_list_environments"] --> B["cs_list_agents<br/>pac or Dataverse"]
    B --> C["cs_clone_agent<br/>bot id or schema name"]
    C --> D["cs_describe_workspace<br/>inventory: topics, knowledge, tools, flows, triggers"]
    D --> E["edit: cs_add_* / cs_update_agent<br/>or hand-edit YAML"]
    E --> F["cs_pull<br/>merge server changes first"]
    F --> G["cs_validate"]
    G -- errors --> E
    G -- clean --> H["cs_push confirm"]
    H -- conflict --> F
    H -- ok --> I["cs_publish confirm"]
```

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
    D -. "20 runs per agent per 24 h" .-> D
```

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
    C -. "edit agents/<name> workspaces,<br/>cs_push to the source" .-> C
    C -. "edit src/ then cs_pack_solution" .-> G
```

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
