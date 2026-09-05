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
