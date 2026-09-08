/**
 * In-product guidance: what to do with this server, in what order, and what
 * each step means in Copilot Studio.
 *
 * Three delivery paths, all fed from here:
 *  - `SERVER_INSTRUCTIONS` goes out in the MCP handshake, so a client sees the
 *    ground rules before it calls anything.
 *  - `cs_guide` returns one walkthrough on demand (plus next steps for the
 *    workspace at hand).
 *  - MCP prompts wrap the same walkthroughs as ready-made requests.
 *
 * Keep every tool name here real: `test/guide.test.js` fails when a guide
 * mentions a tool the server does not register.
 */
import type { WorkspaceInfo } from "./workspace.js";

export const SERVER_INSTRUCTIONS = `copilot-studio-mcp builds Microsoft Copilot Studio agents from files.

Start here
- Call cs_init first in a session: it reports the pac CLI, sign-in state and the workspace it found, and ends with concrete next steps.
- Call cs_guide (topic: "getting-started", "instructions", "knowledge", "tools", "topics", "evaluations", "publish-and-test", "drift", "solutions", "administration", "troubleshooting") for a walkthrough before improvising a sequence of calls.

How the pieces fit
- An agent is a folder of YAML: agent.mcs.yml, settings.mcs.yml, topics/, knowledge/, actions/ (tools), trigger/, variables/, workflows/. Authoring tools write those files; nothing reaches the live agent until cs_push.
- Get a workspace with cs_clone_agent (existing agent) or cs_create_agent (new one). cs_describe_workspace inventories it.
- Order that works: edit files, cs_review_agent, cs_validate, cs_push, then cs_publish, then cs_chat.

Rules to respect
- Nothing reaches the live agent without the user's approval. Every tool that changes an environment (cs_push, cs_publish, cs_run_evaluation, cs_import_solution, cs_deploy_solution, cs_create_agent with an environment, the delete tools) returns a dry run until you pass confirm: true. Show the user that dry run in your own words, ask, and pass confirm only after they say yes. Never confirm on your own initiative, never confirm a batch of steps in advance, and treat approval for one call as approval for that call only. Local file changes (authoring, editing) do not need approval; sending them to Copilot Studio does.
- If CPS_READ_ONLY is set, the environment-changing tools are not registered at all: report that the user has locked this session to local work rather than looking for a way around it.
- Two sign-ins exist: pac (run "pac auth create --environment <id>" in a terminal, this server cannot do it interactively) and MSAL for the API-based tools (cs_login). cs_login can return status "pending" with a URL; give that URL to the user to open.
- Connector, MCP and prompt tools need a connection that only the portal can authorise. cs_add_tool writes the YAML and tells you the portal step; after the user connects, run cs_pull.
- Makers may edit the same agent in the portal. cs_check_drift shows what changed there since your last sync; cs_pull merges it.
- Prefer the specific tool over cs_pac. cs_pac is the escape hatch for pac commands that have no tool.
- Tenant administration runs as a different account from agent making. The tenant-administration tools and cs_backup_tenant take a 'profile' (the pac auth profile of the admin account, default CPS_ADMIN_PROFILE); cs_list_auth_profiles shows what exists. Reset, delete, copy and restore destroy or overwrite whole environments: say what will be lost before asking for confirmation.`;

export type GuideTopic =
  | "getting-started"
  | "instructions"
  | "knowledge"
  | "tools"
  | "topics"
  | "evaluations"
  | "publish-and-test"
  | "drift"
  | "solutions"
  | "administration"
  | "troubleshooting";

export const GUIDE_TOPICS: GuideTopic[] = [
  "getting-started",
  "instructions",
  "knowledge",
  "tools",
  "topics",
  "evaluations",
  "publish-and-test",
  "drift",
  "solutions",
  "administration",
  "troubleshooting",
];

const GETTING_STARTED = `# Getting started

## 0. Check the machine
\`cs_init\`. It reports the pac CLI and .NET, the pac auth profiles, the MSAL sign-in, and the
workspace it found. Fix what it flags before anything else.

If there is no pac auth profile, the user runs this in a terminal (this server cannot do the
interactive sign-in for them):

    pac auth create --environment <environment id or url>

For the API-based tools (evaluations, chat, drift, environment and agent lists) run \`cs_login\`.
It may return \`status: "pending"\` with a URL: show that URL and ask the user to open it.

## 1. Existing agent, or new one?

**Existing agent in Copilot Studio.** \`cs_list_environments\`, then \`cs_list_agents\`, then
\`cs_clone_agent\` with the agent id or schema name. You now have a sync-connected workspace: local
edits go back with \`cs_push\`. Run \`cs_describe_workspace\` to see what it contains.

**New agent.** Pick the solution it lives in: \`cs_list_solutions\`, or \`cs_create_solution\`
(needs \`confirm\`). Then \`cs_create_agent\` with \`name\`, \`publisherPrefix\`, \`projectDir\`,
\`environment\`, \`solutionName\` and \`confirm\`. That creates the agent in the environment and
clones it back, so the workspace is sync-connected.

Without \`environment\`, \`cs_create_agent\` only scaffolds locally. A local scaffold packs settings,
the agent and topics only; knowledge and tools need a sync-connected workspace. The tools say so
in a \`layoutNote\` when it applies.

## 2. Say what the agent is for
\`cs_generate_instructions\` drafts them with an AI Builder prompt; review the text, then call again
with \`apply: true\`. Or write them yourself with \`cs_update_agent\`. See \`cs_guide\`
topic \`instructions\`.

## 3. Give it something to work with
- Knowledge: \`cs_add_knowledge_source\` (topic \`knowledge\`).
- Tools: \`cs_list_connectors\`, \`cs_describe_connector\`, \`cs_add_tool\` (topic \`tools\`).
- Deterministic conversations: \`cs_add_topic\` (topic \`topics\`).

## 4. Check, then ship
Everything so far only touched files on disk. The next steps change the live agent, so each one
needs the user's approval: call it without \`confirm\`, show the dry run, ask, then call again with
\`confirm: true\`.

1. \`cs_review_agent\` scores the agent and names a fix per finding.
2. \`cs_validate\` checks every file against the schema and across files.
3. \`cs_push\` with \`confirm\`. Its dry run first shows what will change and whether a maker
   changed the same components in the portal.
4. Tools with a connection reference need one portal step: the user opens the agent's Tools page
   and connects each one. Then \`cs_pull\`.
5. \`cs_publish\` with \`confirm\`, then \`cs_chat\` to try it.

## 5. Keep it honest
\`cs_create_test_set_csv\` and the evaluation tools (topic \`evaluations\`), and \`cs_check_drift\`
before you edit again (topic \`drift\`).`;

const INSTRUCTIONS = `# Instructions (the agent's system prompt)

Instructions live in \`agent.mcs.yml\` and drive everything the orchestrator does: which tool it
picks, when it answers from knowledge, when it refuses, when it hands over to a person.

## Writing them
- **With AI Builder:** \`cs_generate_instructions\` with \`purpose\`, \`audience\`, \`tone\`,
  \`boundaries\`. It returns the draft text. Show it to the user, then call again with
  \`apply: true\` to write it into the workspace. \`cs_list_prompts\` lists the AI Builder prompts
  available; \`modelName\` picks one. Each run uses AI Builder capacity.
- **Revising:** call it again with \`refine: true\` and a \`changeRequest\`.
- **By hand:** \`cs_update_agent\` with \`instructions\` (replace) or \`appendInstructions\` (add a
  paragraph). The same tool sets \`displayName\`, conversation starters and the model hint.

## What good instructions contain
1. Role and scope: who the agent serves and what it does not do.
2. Grounding: answer from the knowledge sources, say when something is not covered, never invent.
3. Tool rules: when to use each tool, what to ask for first, what never to do without confirmation.
4. Escalation: when to hand over to a person, and how.
5. Tone: length, formality, language.

\`cs_review_agent\` warns under about 200 characters (too thin to cover scope, grounding and
escalation) and over about 8000 (the important rules get diluted; move procedures into topics).

## Conversation starters
\`cs_update_agent\` with \`addConversationStarters\`: two or three examples so users see what the
agent can do. The review notes their absence.

## Responses and the rest of the agent's settings
The same tool writes what the portal groups under responses and generative AI:

- \`responseInstructions\`: how answers should be worded and formatted (length, lists, citations,
  language). Keep it separate from the instructions, which say what the agent does.
- \`defaultResponseMode\`: \`Auto\`, \`ThinkDeeper\` (more reasoning, slower) or \`QuickResponse\`.
- \`history\` (\`none\` or \`conversation\`, with \`historyMessages\`): how much of the conversation
  the agent sees.
- \`capabilities\`: web browsing, code interpreter, image generation, and Teams, SharePoint, email,
  meeting and people search. Only the toggles you pass change.
- \`useModelKnowledge\`: whether the model may answer beyond your knowledge sources. Turning it off
  is the usual fix when an agent invents things.
- \`contentModeration\` (\`Minimum\` to \`Maximum\`), \`isFileAnalysisEnabled\`,
  \`isSemanticSearchEnabled\`.

How the agent runs (orchestration, authentication, language, analytics) lives in
\`settings.mcs.yml\` instead: \`cs_update_settings\` sets those by dot path.

## GitHub Copilot harness
In a \`cli-copilot\` workspace, instructions live in \`settings.mcs.yml\` under
\`configuration.agentSettings.instructions.segments\`. \`cs_update_agent\` handles that layout;
\`cs_update_settings\` refuses to change \`authoringModel\`, \`recognizer.kind\` and \`template\`.`;

const KNOWLEDGE = `# Knowledge sources

\`cs_add_knowledge_source\` writes one YAML file per source under \`knowledge/\`. Kinds:

| kind | What it is | What it needs |
| --- | --- | --- |
| \`public-site\` | a public website, optionally its sub-pages | the URL; no authentication |
| \`sharepoint\` | a SharePoint site or document library | the site URL and a signed-in user |
| \`graph-connector\` | a Microsoft Graph connector index | the connector id and a signed-in user |
| \`files\` | documents uploaded with the agent | the files, copied into \`knowledge/files/\` |

## The authentication rule
SharePoint, Graph connector, Dataverse and similar sources answer as the signed-in user. If the
agent's \`authenticationMode\` is \`None\`, those sources return nothing. \`cs_review_agent\` reports
this as an error. Fix it with \`cs_update_settings\` (\`authenticationMode: Integrated\`), or use
public sources instead.

## Useful options
- \`includeSubPages\` for a public site.
- \`triggerCondition\`: a Power Fx condition that decides when the source is consulted, for example
  a region or a role check.
- \`description\`: the orchestrator reads it when choosing between sources, so make it specific.

## Editing and removing
\`cs_edit_knowledge\` changes the site, description, trigger condition or search terms.
\`cs_remove_component\` with \`kind: "knowledge"\` deletes one (needs \`confirm\`).

## Getting it live
Knowledge is applied by \`cs_push\` from a sync-connected workspace. In a local scaffold (init
without an environment) \`pac copilot pack\` ignores the \`knowledge/\` folder; clone the agent first.

Uploaded files and Dataverse-backed knowledge are environment-specific: they do not travel with a
solution export, and they are outside the quick drift check.

## In a topic
Scope generative answers to named sources with a \`searchKnowledge\` node that lists them; see
\`cs_guide\` topic \`topics\`.`;

const TOOLS = `# Tools (what the agent can do)

## 1. Find the operation first
- \`cs_list_connectors search=ServiceNow\` lists the connectors in the environment, marking those
  that speak MCP.
- \`cs_describe_connector connector=shared_service-now operation=incident\` shows the operations and
  their parameters, and caches the definition so the next step can check it.
- \`cs_list_prompts\` lists AI Builder prompts.

## 2. Add the tool
\`cs_add_tool\` writes \`actions/<Name>.mcs.yml\` plus a connection-reference stub. Types:

| type | Use for |
| --- | --- |
| \`connector\` | one operation of a Power Platform connector |
| \`mcp\` | an MCP server exposed as a tool |
| \`flow\` | an existing cloud flow |
| \`prompt\` | an AI Builder prompt |
| \`agent\` | another agent (connected or child) |
| \`raw\` | any other TaskAction kind, written verbatim |

Give every tool a **specific \`modelDescription\`**: what it does, when to use it, what it needs.
The orchestrator routes on that text, so a vague description is the most common reason a tool is
never called. \`cs_review_agent\` reports a missing or very short one as an error.

Inputs: \`kind: "automatic"\` lets the orchestrator fill a parameter from the conversation;
\`literal\` pins a value; \`variable\` reads a topic or global variable.

## 3. The portal step that cannot be skipped
Connector, MCP and prompt tools need a **connection** that only the portal can authorise. After
\`cs_push\`, the user opens the agent, goes to Tools, and connects each tool once. Then run
\`cs_pull\` so the workspace picks up the connection id. \`cs_review_agent\` lists unbound
connection references.

The one exception: \`cs_create_connection\` creates a service-principal **Dataverse** connection
from the CLI. Connector connections still come from the portal.

## 4. Editing
\`cs_edit_tool\` changes the description, display name, operation, connection mode and inputs.
\`cs_remove_component\` with \`kind: "tool"\` deletes one and prunes the connection reference when no
other tool uses it (needs \`confirm\`).

## Flows

Cloud flows live in Power Automate, not in the agent, so they are read and changed through
Dataverse rather than the workspace:

- \`cs_list_flows\` shows every flow with its state, owner and last change. \`cs_get_flow\` reads
  one, including its trigger and action names, its connection references and (with
  \`includeDefinition\`) the full definition.
- \`cs_set_flow_state\` turns a flow on or off. This is the step a solution import leaves behind:
  flows whose connections were unbound at import time land switched off. Bind the connections
  first, then turn the flow on.
- \`cs_update_flow\` replaces the definition of an unmanaged flow, including its trigger. Read it
  with \`cs_get_flow\` first, change what you need, and send it back; the connection references are
  preserved. Managed flows cannot be edited in place.
- \`cs_create_flow\` creates a new flow from a definition, optionally straight into a solution. It is
  created switched off; bind its connections, then turn it on. A flow an agent can call needs a
  trigger of type \`Request\` with kind \`Skills\`.
- \`cs_list_flow_runs\`, \`cs_get_flow_run\` and \`cs_run_flow\` cover run history and starting a
  manual run. They use the Power Automate service, which is a separate sign-in:
  \`cs_login scope='flow'\`. Starting a run really executes the flow, so it needs confirmation like
  any other write.

To let the agent call a flow, add it as a tool with \`cs_add_tool\` type \`flow\` and the flow id.
\`cs_add_trigger\` adds an event trigger that starts one. \`cs_add_flow\` scaffolds a new flow in
the workspace, but it is experimental: the format has not been round-tripped through a real clone.`;

const TOPICS = `# Topics (deterministic conversations)

\`cs_add_topic\` writes \`topics/<Name>.mcs.yml\` from a small spec: a trigger plus a list of nodes.

## Triggers
- \`phrases\`: what the user might say. Give **five to ten varied phrasings**; the review warns
  under three and flags a phrase that appears in two topics, because the winner is then arbitrary.
- System triggers: \`conversationStart\`, \`escalate\`, \`unknownIntent\`, \`error\` and the other
  system topics. Keep an escalation topic and a fallback topic; the review checks for both.

## Nodes
| type | What it does |
| --- | --- |
| \`message\` | say something |
| \`question\` | ask, validate the answer, store it in a variable |
| \`condition\` | branch on a Power Fx expression |
| \`setVariable\` | set a topic or global variable |
| \`searchKnowledge\` | generative answer, optionally scoped to named knowledge sources |
| \`card\` | an adaptive card, shown or used to collect input |
| \`invokeFlow\` | run a cloud flow |
| \`http\` | call a REST endpoint |
| \`redirect\` | hand over to another topic |
| \`transfer\` | hand over to a person or a phone number |
| \`endConversation\` | end it |
| \`raw\` | any other node kind, written verbatim |

## Editing
\`cs_edit_topic\` renames, changes the description, adds or removes trigger phrases, sets the
priority, appends or inserts nodes, and removes nodes by id. Comment headers survive.
\`cs_remove_component\` deletes a topic and names the topics that still redirect to it.

## Before pushing
\`cs_validate\` checks node kinds, unknown properties, duplicate ids, Power Fx prefixes and
redirects to topics that do not exist. It blocks \`cs_push\` on errors.`;

const EVALUATIONS = `# Evaluations and tests

## The one manual step
Test sets cannot be created through the API. The flow is:

1. \`cs_create_test_set_csv\` with \`suggestFromWorkspace: true\` writes a CSV (columns
   \`Question\` and \`Expected response\`, at most 100 cases) and returns a link to the agent's
   Evaluation page.
2. The user imports that CSV once in the portal.
3. Everything after that is automated.

## Running
- \`cs_list_test_sets\` shows the imported sets.
- \`cs_run_evaluation\` with \`confirm\` starts a run; \`wait: true\` polls to the end. The platform
  allows 20 runs per agent per 24 hours.
- \`cs_get_evaluation_run\` returns per-case results, \`cs_list_evaluation_runs\` the history.

Evaluations are a standard-harness feature; agents in the GitHub Copilot harness do not have them.

## Cheaper checks that need no portal step
\`cs_run_conversation_tests\` runs a local YAML file of utterances with expected keywords, topics or
tools through \`cs_chat\` and reports pass or fail. Good as a smoke test after every push.

## Reading a failure
A wrong answer usually traces back to one of: instructions that do not say how to answer, a
knowledge source that is not reachable for the signed-in user, a tool whose \`modelDescription\`
does not describe when to use it, or trigger phrases shared between topics. \`cs_review_agent\`
catches all four before an evaluation does.`;

const PUBLISH_AND_TEST = `# Publishing and chat-testing

## Publish
\`cs_publish\` with \`confirm\`. It publishes the draft agent and polls until the publish date
changes. Everything you push stays draft until then, so a push alone changes nothing for users.

## Chat
\`cs_chat utterance="..."\` talks to the published agent and returns the activities.
\`conversationId\` continues a conversation. Transport is chosen automatically:

- No authentication or manual authentication: DirectLine. Nothing to configure.
- Entra SSO (integrated authentication): the Copilot Studio client SDK, which needs **your own app
  registration** with the delegated \`CopilotStudio.Copilots.Invoke\` permission. Pass \`clientId\`
  or set \`CPS_CLIENT_ID\`.

If the answer is not grounded, check that the agent was published after the last push, that
knowledge sources are reachable for the signed-in user, and that the tool connections are bound.

## Repeatable checks
Turn the utterances that matter into a YAML file and run \`cs_run_conversation_tests\` after every
push. See \`cs_guide\` topic \`evaluations\`.`;

const DRIFT = `# Portal drift (someone edited the agent in Copilot Studio)

Makers can keep editing the agent in the portal; the platform sends no notification. Every edit
lands in Dataverse rows with a modified-on stamp and the user who changed it, so the server can see
drift without re-downloading everything.

## The stamp
\`cs_clone_agent\`, \`cs_pull\`, \`cs_push\` and \`cs_create_agent\` write \`.mcs/cs-sync.json\`: a
fingerprint per file and, when a Dataverse sign-in is cached, the modification stamp of every
component. \`cs_describe_workspace\` shows the last sync.

## Checking
- \`cs_check_drift\` (default \`mode: "quick"\`) reads the component rows and compares them with the
  stamp: what changed in the portal, by whom, when, whether agent settings changed, and whether the
  live agent has unpublished changes. Seconds; needs \`cs_login\`.
- \`cs_check_drift mode="full"\` clones the agent into a temporary folder and classifies every file
  as local-modified, remote-modified or both (a conflict), with diffs. Needs only the pac profile.

## Resolving
\`cs_pull\` merges server changes into the workspace (three-way). Commit afterwards: portal drift
then shows up as a reviewable diff, and accepting it is a commit while rejecting it is a push of
your version.

The \`cs_push\` dry run repeats the quick check, and a push is blocked when a portal change and a
local edit touch the same component. \`force: true\` overrides that, discarding the portal version.`;

const SOLUTIONS = `# Solutions: moving everything to another environment

A per-agent workspace always pushes back to the environment it came from. Moving between
environments goes through solutions.

## Pull everything
1. \`cs_list_solutions\` to find the solution.
2. \`cs_describe_solution\` for its contents: agents, components, flows, connection references,
   environment variables, custom connectors.
3. \`cs_pull_solution\` exports it managed and unmanaged, unpacks it to \`src/\`, clones every agent
   into \`agents/\`, and writes \`solution.json\` plus a deployment settings file.

## Deploy to the target
1. \`cs_list_connections\` in the **target** environment: the connections must already exist there,
   created and authorised by a user in that environment.
2. \`cs_create_deployment_settings\` maps each connection reference to a target connection id and
   sets the environment variable values.
3. \`cs_deploy_solution\` with \`confirm\` imports and publishes each agent. It refuses while a
   connection reference is unmapped unless you pass \`allowUnmapped\`.
4. Flows whose connections could not be resolved arrive switched off: \`cs_list_flows\` shows which,
   and \`cs_set_flow_state\` turns each on once its connections are bound.

Deploy managed to test and production; keep unmanaged for development. \`cs_check_solution\` runs
Solution Checker on the zip first, and \`cs_deploy_pipeline\` is the alternative when the tenant
uses Power Platform pipelines.

## What does not travel
Connections themselves, uploaded knowledge files, Dataverse knowledge, SharePoint permissions,
channel configuration and agent access groups. The README section "Caveats when moving a solution
between environments" is the full list.

## Comparing environments
\`cs_snapshot_environment\` per stage and \`cs_compare_snapshots\`, or \`cs_compare_environments\`
for a whole DEV, TEST, ACC, PROD chain. The report separates real drift from differences that are
expected per stage (connection bindings, variable values, managed flag). \`failOnDrift\` turns it
into a pipeline gate.`;

const ADMINISTRATION = `# Tenant administration and the two accounts

Making agents and administering the tenant are usually different accounts: the maker works in
Copilot Studio, the admin in the Power Platform admin centre. pac keeps one *active* auth profile,
so this server switches between them per call.

## Set the two profiles up once
In a terminal, one profile per account:

    pac auth create --name maker --environment <environment id or url>
    pac auth create --name admin --environment <environment id or url>

\`cs_list_auth_profiles\` shows them, which is active, and which account each belongs to. Then
either pass \`profile: "admin"\` to a call, or set \`CPS_ADMIN_PROFILE=admin\` (used by every
tenant-administration tool) and \`CPS_PAC_PROFILE=maker\` (used by the rest) in the server's environment
and forget about it. Every pac-backed tool takes \`profile\`; the server selects it, runs the
command and puts the previous active profile back.

## Reading the tenant
- \`cs_admin_list_environments\` (every environment, its type and region), \`cs_admin_list_backups\`,
  \`cs_admin_environment_status\` (operations in progress).
- \`cs_admin_list_tenant_settings\` with \`settingsFile\` writes the tenant settings as JSON.
- \`cs_admin_list_dlp_policies\` and \`cs_admin_show_dlp_policy\`: the data loss prevention rules
  that decide which connectors an agent or flow may combine. A tool that will not run in production
  is often a DLP rule, not a bug.
- \`cs_admin_list_security_roles\`, \`cs_admin_list_service_principals\`,
  \`cs_admin_list_applications\`, \`cs_admin_list_environment_groups\`, \`cs_admin_query\`.

## Backing the tenant up to files
\`cs_backup_tenant dir="tenant-backup"\` writes the whole configuration to a folder: tenant
settings, environments, DLP policies, groups, service principals, registered applications and app
templates, and per environment its details, solutions, agents, connections, security roles and
platform backups. With a Dataverse sign-in it also records flows, connection references and
environment variables per environment.

Each capture is independent: a command the account may not run is listed under \`skipped\` and the
rest still completes. Commit the folder and re-run it later to see what changed in the tenant.
It is read-only: nothing in the tenant is modified.

## Changing the tenant
Every one of these needs \`confirm: true\` and the user's agreement, and several are destructive:
\`cs_admin_update_tenant_settings\`, \`cs_admin_set_governance_config\` (managed environments),
\`cs_admin_assign_user\` and \`cs_admin_assign_group\`, \`cs_admin_create_service_principal\`,
\`cs_admin_set_runtime_state\` (administration mode), \`cs_admin_backup_environment\`,
\`cs_admin_restore_environment\`, \`cs_admin_copy_environment\`, \`cs_admin_create_environment\`,
\`cs_admin_reset_environment\` and \`cs_admin_delete_environment\`.

Reset and delete destroy everything in an environment, and copy and restore overwrite the target.
Take a backup first (\`cs_backup_tenant\` for the configuration, \`cs_admin_backup_environment\` for
the platform's own backup), and say plainly what will be lost before asking for confirmation.
\`CPS_READ_ONLY\` hides all of them.`;

const TROUBLESHOOTING = `# Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| \`cs_init\` says pac was not found | Install the CLI: \`dotnet tool install --global Microsoft.PowerApps.CLI.Tool\` (needs .NET 10). If pac is installed but fails, set \`DOTNET_ROOT\`; the server defaults it to \`~/.dotnet\` when the SDK lives there. |
| "No profiles were found on this computer" | The user runs \`pac auth create --environment <id>\` in a terminal. This server cannot do that interactive sign-in. |
| \`cs_login\` returns \`status: "pending"\` | Normal when no browser can be opened from the server. Show the URL and ask the user to open it on the machine running the server; the login completes in the background. \`cs_login_status wait=true\` then confirms it. |
| Device-code sign-in is refused | Many tenants block that flow by Conditional Access. Use the pending-URL path above. |
| A cloud tool says there is no cached token | Run \`cs_login\`. The drift check and other silent readers never prompt on their own. |
| "Unsupported directory" from pac pack | The workspace was created by \`cs_create_agent\` without an environment. It packs settings, agent and topics only. Clone the agent (or init with \`environment\`) to use knowledge, tools, triggers and flows. |
| \`cs_push\` is blocked by validation | \`cs_validate\` names the file and the property. Unknown properties inside dialog actions are errors; at the document root they are only warnings. \`force: true\` pushes anyway. |
| \`cs_push\` is blocked by drift | A maker changed the same component in the portal. \`cs_pull\` merges, then push again. \`force: true\` discards their change. |
| A tool never runs | Its \`modelDescription\` does not say when to use it, or its connection is unbound. \`cs_review_agent\` reports both. |
| A knowledge source returns nothing | Private sources need \`authenticationMode: Integrated\` and a signed-in user with access. |
| The agent answers as before after a push | A push only changes the draft. Run \`cs_publish\` with \`confirm\`. |
| Too many tools for the client | Set \`CPS_TOOLS\` or \`CPS_TOOLS_EXCLUDE\` (comma-separated names, \`*\` wildcards) in the server's environment. |

Diagnostics go to stderr; the client's MCP output pane shows them. Every pac-backed result carries
the exact command, exit code and output tail, and known pac errors come back with an explanation.`;

const GUIDES: Record<GuideTopic, string> = {
  "getting-started": GETTING_STARTED,
  instructions: INSTRUCTIONS,
  knowledge: KNOWLEDGE,
  tools: TOOLS,
  topics: TOPICS,
  evaluations: EVALUATIONS,
  "publish-and-test": PUBLISH_AND_TEST,
  drift: DRIFT,
  solutions: SOLUTIONS,
  administration: ADMINISTRATION,
  troubleshooting: TROUBLESHOOTING,
};

export function guide(topic: GuideTopic): string {
  return GUIDES[topic];
}

export const TOPIC_SUMMARY: Record<GuideTopic, string> = {
  "getting-started": "clone or create an agent and take it to a published, tested state",
  instructions: "write the agent's instructions, with AI Builder or by hand",
  knowledge: "add public site, SharePoint, Graph connector or file knowledge",
  tools: "find a connector operation, add the tool, bind its connection",
  topics: "deterministic conversations: triggers and the node types",
  evaluations: "test sets, runs and results, plus local conversation tests",
  "publish-and-test": "publish the agent and chat with it",
  drift: "changes made in the portal since the last sync, and how to merge them",
  solutions: "pull a solution, redeploy it elsewhere, compare environments",
  administration: "tenant administration with a separate admin account, and backing the tenant configuration up to files",
  troubleshooting: "the errors this server can return, and what each one means",
};

/**
 * What to do next in this workspace, most useful first. Derived from the
 * inventory only, so it costs nothing to include in other tool results.
 */
export function nextSteps(ws: WorkspaceInfo | null, opts: { pacFound?: boolean; pacProfile?: boolean; signedIn?: boolean } = {}): string[] {
  const out: string[] = [];
  if (opts.pacFound === false) out.push("Install the Power Platform CLI: dotnet tool install --global Microsoft.PowerApps.CLI.Tool (needs .NET 10). cs_guide topic 'troubleshooting'.");
  if (opts.pacProfile === false) out.push("No pac auth profile: ask the user to run 'pac auth create --environment <id>' in a terminal.");
  if (opts.signedIn === false) out.push("Not signed in for the API-based tools (evaluations, chat, drift): run cs_login.");
  if (!ws) {
    out.push("No workspace found: cs_clone_agent for an existing agent, or cs_create_agent (with environment and solutionName) for a new one. cs_guide topic 'getting-started'.");
    return out;
  }
  if (ws.sync.source === "none") out.push("This workspace has no sync metadata, so only settings, agent and topics can be packaged. Clone the agent (cs_clone_agent) or init with an environment to use knowledge, tools and flows.");
  const instructions = (ws.agent?.instructions ?? "").trim();
  if (ws.harness !== "github-copilot" && instructions.length < 200) {
    out.push(instructions ? "Instructions are short: expand them with cs_generate_instructions (refine: true) or cs_update_agent. cs_guide topic 'instructions'." : "The agent has no instructions: cs_generate_instructions, then apply. cs_guide topic 'instructions'.");
  }
  const customTopics = ws.topics.filter((t) => t.details.triggerKind === "OnRecognizedIntent").length;
  if (!ws.knowledge.length && !ws.knowledgeFiles.length) out.push("No knowledge sources: cs_add_knowledge_source. cs_guide topic 'knowledge'.");
  if (!ws.actions.length) out.push("No tools: cs_list_connectors then cs_add_tool. cs_guide topic 'tools'.");
  if (!customTopics) out.push("No custom topics: cs_add_topic for conversations that must follow a fixed path. cs_guide topic 'topics'.");
  const unbound = ws.connectionReferences.filter((c) => !c.connectionId).length;
  if (unbound) out.push(`${unbound} connection reference(s) are not bound: after cs_push, the user connects each tool once in the portal, then run cs_pull.`);
  if (ws.sync.source !== "none") out.push("Before editing: cs_check_drift (what changed in the portal since your last sync). Before pushing: cs_review_agent, then cs_validate, then cs_push with confirm.");
  else out.push("Before pushing: cs_review_agent, then cs_validate.");
  return out;
}
