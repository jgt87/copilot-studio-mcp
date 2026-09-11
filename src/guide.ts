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

FIRST
- Call cs_init before anything else. It reports pac, sign-in, the workspace, and the next steps.
- cs_init returns toolPresets: show it to the user, then call cs_set_tool_preset with their choice.
- Call cs_guide before inventing a sequence of calls: it names the tool for each step and the order that works. Its own description lists the topics.

WHAT AN AGENT IS
- A folder of YAML: agent.mcs.yml, settings.mcs.yml, topics/, knowledge/, actions/, trigger/, variables/, workflows/.
- Authoring tools only write files. Files reach the live agent only through cs_push.
- Get a workspace with cs_clone_agent (existing agent) or cs_create_agent (new one). List what is in it with cs_describe_workspace.
- Order that works: edit files, cs_review_agent, cs_validate, cs_push, cs_publish, cs_chat.

APPROVAL - NEVER SKIP
- A tool that changes an environment returns a dry run and does nothing else.
- Show the dry run to the user in your own words. Ask. Only then call again with confirm: true.
- One approval covers one call. Never pass confirm on your own initiative. Never approve several steps at once.
- Writing and editing local files needs no approval. Sending them to Copilot Studio does.
- If CPS_READ_ONLY is set, the environment-changing tools are absent on purpose. Say so. Do not look for a way around it.

WHEN A CALL DOES NOT DO WHAT YOU EXPECT
- needsInput: true is a question, not an error. Nothing was written. Ask the user the question, offer the choices listed, then call the same tool again with that argument.
- The call died after about a minute: that is the client's limit, not the tool's, and the work is still running. Call again with background: true, then poll cs_job_status. Never retry with a shorter path or smaller arguments.
- A tool named here is missing from tools/list: the server binary is older than its documentation. Say the build is stale. Check cs_init serverBuild.modulePath.
- A cloud tool fails: read cs_init cloudAccess.ready. If a resource is not ok, the user must run cs_login.
- pac says it failed but the tool says ok: trust the output text and tell the user to check the portal.

OTHER RULES
- Two sign-ins. pac: user runs "pac auth create --environment <id>" in a terminal. cs_login: for API tools; may return status pending with a URL to open.
- Connector, MCP and prompt tools need a portal-authorised connection. cs_add_tool writes the YAML and names the portal step; then run cs_pull.
- Makers also edit in the portal. cs_check_drift shows what changed there. cs_pull merges it.
- Use the specific tool. cs_pac is only for pac commands that have no tool of their own.
- Admin tools and cs_backup_tenant run as a separate account: pass profile (default CPS_ADMIN_PROFILE, listed by cs_list_auth_profiles). Reset, delete, copy and restore destroy whole environments: say what will be lost before you ask.`;

export type GuideTopic =
  | "getting-started"
  | "instructions"
  | "knowledge"
  | "tools"
  | "topics"
  | "flows"
  | "evaluations"
  | "publish-and-test"
  | "drift"
  | "transcripts"
  | "solutions"
  | "administration"
  | "troubleshooting";

export const GUIDE_TOPICS: GuideTopic[] = [
  "getting-started",
  "instructions",
  "knowledge",
  "tools",
  "topics",
  "flows",
  "evaluations",
  "publish-and-test",
  "drift",
  "transcripts",
  "solutions",
  "administration",
  "troubleshooting",
];

const GETTING_STARTED = `# Getting started

Follow these steps in order. Do not skip step 0.

## 0. Check the machine
Call \`cs_init\`.
Read \`toolPresets\` in the result. Put its question and the option table to the user, then call
\`cs_set_tool_preset\` with what they pick. Skip this only if the user already chose.
Read \`cloudAccess.ready\` in the result.
IF a resource is not "ok" -> the user must run \`cs_login\` before tools that need it.
IF there is no pac auth profile -> the user runs this in a terminal. You cannot do it for them:

    pac auth create --environment <environment id or url>

IF \`cs_login\` returns status "pending" -> show the URL and ask the user to open it. Then wait.

## 1. Choose: existing agent or new one

IF the agent already exists in Copilot Studio:
1. \`cs_list_environments\`
2. \`cs_list_agents\`
3. \`cs_clone_agent\` with \`bot\` (the id or schema name) and \`outputDir\`
4. \`cs_describe_workspace\` to see what came down

IF the agent does not exist yet:
1. \`cs_list_solutions\` to pick a solution, or \`cs_create_solution\` with \`confirm: true\`
2. \`cs_create_agent\` with \`name\`, \`publisherPrefix\`, \`projectDir\`, \`environment\`, \`solutionName\`, \`confirm: true\`

Leaving out \`environment\` makes a local scaffold only. A scaffold packs settings, the agent and
topics. Knowledge, tools and flows need a sync-connected workspace, so pass \`environment\` unless
the user asked for a local scaffold.

## 2. Say what the agent is for
\`cs_generate_instructions\` drafts them. Show the draft. Call again with \`apply: true\` to keep it.
Or write them yourself with \`cs_update_agent\`.
More: \`cs_guide\` topic "instructions".

## 3. Give it something to work with
Knowledge: \`cs_add_knowledge_source\`. Topic "knowledge".
Tools: \`cs_list_connectors\`, then \`cs_describe_connector\`, then \`cs_add_tool\`. Topic "tools".
Scripted conversations: \`cs_add_topic\`. Topic "topics".

## 4. Check the files
1. \`cs_review_agent\` - scores the agent and names a fix per finding.
2. \`cs_validate\` - must report 0 errors. \`cs_push\` refuses while there are errors.

Everything up to here only wrote files on disk. Nothing reached the live agent.

## 5. Ship it
Each step below changes the live agent. For each one: call it WITHOUT \`confirm\`, show the dry run
to the user, ask, then call again with \`confirm: true\`.
1. \`cs_push\` - sends the files. Its dry run also warns if a maker changed the same components.
2. IF a tool has a connection reference -> the user opens the agent's Tools page in the portal and
   connects it. You cannot do this step. Then run \`cs_pull\`.
3. \`cs_publish\` - makes the draft live.
4. \`cs_chat\` - ask the agent something and check the answer.

## 6. Keep it working
\`cs_check_drift\` before you edit again. Topic "drift".
\`cs_create_test_set_csv\` and the evaluation tools. Topic "evaluations".`;
const INSTRUCTIONS = `# Agent instructions

Instructions tell the agent how to behave in every conversation. They are the highest-value thing
to get right: most bad answers trace back to instructions, not to knowledge or tools.

## Where they live
Standard agents: \`agent.mcs.yml\`. Write them with \`cs_update_agent\`, field \`instructions\`.
GitHub Copilot harness agents: \`settings.mcs.yml\`. \`cs_update_agent\` writes the right file for the
harness it finds, so you do not need to choose.

## Write them
Option A - draft with AI Builder:
1. \`cs_generate_instructions\` with \`purpose\`, and optionally \`audience\`, \`tone\`, \`capabilities\`, \`boundaries\`.
2. Show the draft text to the user.
3. Call again with \`apply: true\` to write it.

Option B - write them yourself:
\`cs_update_agent\` with \`instructions\`.
\`cs_update_agent\` with \`appendResponseInstructions\` adds a line without rewriting what is there.

## What good instructions contain
- Role and scope: what the agent is for, and what it is not for.
- How to answer: ground answers in knowledge, cite sources, ask when the request is unclear.
- When to use each tool, by name.
- What to refuse, and how to escalate.

Write in the second person, as instructions to the agent. Keep each rule on its own line.

## Other settings on the same tool
\`cs_update_agent\` also writes: \`responseInstructions\` (formatting only), \`defaultResponseMode\`
(Auto, ThinkDeeper, QuickResponse), \`historyType\`, \`capabilities\` (web browsing, code interpreter,
file analysis), and content moderation.
Enum values are checked before writing, so a wrong value fails fast with the allowed list.

## After writing
1. \`cs_validate\`
2. \`cs_push\` with \`confirm: true\` after the user approves
3. \`cs_publish\` with \`confirm: true\`
4. \`cs_chat\` to see whether behaviour actually changed

Instructions only take effect for users after \`cs_publish\`.`;
const KNOWLEDGE = `# Knowledge sources

Knowledge is what the agent reads to answer questions it has no topic for.

## Add one
\`cs_add_knowledge_source\` with \`name\` and \`kind\`.

\`kind: "publicSite"\` - a public website. Pass \`site\` (the URL). Needs no connection. Start here.
\`kind: "sharePoint"\` - a SharePoint site. Pass \`site\`. Needs a connection the user makes in the portal.
\`kind: "graphConnector"\` - a Microsoft Graph connector already set up in the tenant.
\`kind: "files"\` - upload files. Pass \`files\` (paths). They are copied into \`knowledge/files/\`.

IF you do not know which kind the user means -> call the tool without \`kind\`. It returns a question
with the choices. Put that question to the user. Do not guess.

## Then
1. \`cs_validate\`
2. \`cs_push\` with \`confirm: true\` after the user approves
3. IF the source needs a connection -> the user opens the agent's Knowledge page in the portal and
   connects it. You cannot do this. Then \`cs_pull\`.
4. \`cs_publish\` with \`confirm: true\`
5. \`cs_chat\` with a question the source should answer

## When a source answers nothing
- The agent was pushed but not published. Run \`cs_publish\`.
- The source needs a connection that nobody made in the portal.
- A private source needs the signed-in user to have access to it. Public site sources do not.
- Generative answers are off, or the instructions tell the agent not to use knowledge.
  \`cs_review_agent\` catches the last one.

## Scope a source to part of the conversation
\`cs_add_knowledge_source\` takes \`triggerCondition\` (a Power Fx condition).
\`cs_edit_knowledge\` changes the site, the trigger condition or the name of a source that exists.`;
const TOOLS = `# Tools (what the agent can do)

A tool lets the agent call something: a connector operation, a cloud flow, an MCP server, a prompt,
or another agent.

## Find the operation first
1. \`cs_list_connectors\` with \`search\` (for example "SharePoint", "Outlook"). Returns connector ids.
2. \`cs_describe_connector\` with the connector id. Returns its operations and their parameters.
Do not guess an operation id. If you guess wrong, \`cs_validate\` fails later and the reason is unclear.

## Add the tool
\`cs_add_tool\` with \`name\`, \`description\` and \`type\`.

\`type: "connector"\` - a connector operation. Pass \`connectorId\` and \`operationId\`.
\`type: "flow"\` - a cloud flow. Pass \`flowId\`.
\`type: "mcp"\` - an MCP server exposed as a connector. Pass \`connectorId\`.
\`type: "prompt"\` - an AI Builder prompt. Pass \`promptId\`. \`cs_list_prompts\` lists them.
\`type: "connectedAgent"\` or \`"childAgent"\` - hand work to another agent.
\`type: "raw"\` - anything else: pass the action node as \`action\`.

IF you do not know which connector or operation -> call \`cs_add_tool\` without them. It returns a
question with ranked choices. Put that question to the user. Do not invent an id.

## description matters more than you think
The agent decides whether to call a tool from its description. Write when to use it, not what it is.
Good: "Look up an order by its number. Use when the user gives an order number."
Bad: "SharePoint connector".
\`cs_review_agent\` flags descriptions that do not say when to use the tool.

## The portal step you cannot do
Connector, MCP and prompt tools need a connection that only the portal can authorise.
\`cs_add_tool\` writes the YAML and a connection-reference stub, and tells you the exact portal step.
1. \`cs_push\` with \`confirm: true\` after the user approves.
2. The user opens the agent's Tools page and connects each tool.
3. \`cs_pull\` to bring the binding back.
Until that is done the tool exists but cannot run.

## Change or remove
\`cs_edit_tool\` - change the description, inputs or connection.
\`cs_remove_component\` - delete it, and prune the connection reference it used.`;
const TOPICS = `# Topics

A topic is a scripted conversation. Use one when the answer must be the same every time: a form, a
handoff, a fixed procedure. For open questions use knowledge instead.

## Add one
\`cs_add_topic\` with \`name\`, \`triggerPhrases\` (what the user might say) and \`actions\`.

Each entry in \`actions\` has a \`type\`:
- \`message\` - say something. Pass \`text\`.
- \`question\` - ask and store the answer. Pass \`prompt\`, \`variable\`, optionally \`entity\` or \`choices\`.
- \`condition\` - branch. Pass \`cases\` (each with \`condition\` and \`actions\`), optionally \`else\`.
- \`redirect\` - go to another topic. Pass \`topic\`.
- \`setVariable\` - store a value. Pass \`variable\` and \`value\`.
- \`searchKnowledge\` - answer from knowledge, then stop if it found something.
- \`http\` - call a URL. Pass \`url\`, \`responseVariable\`.
- \`invokeFlow\` - run a cloud flow. Pass \`flowId\`.
- \`card\` - show an adaptive card. Pass \`card\`.
- \`transfer\` - hand to a human. \`endConversation\` / \`end\` - stop.
- \`raw\` - anything else: pass the node as \`node\`.

## Triggers other than phrases
\`triggerKind\` accepts: conversationStart, unknownIntent, escalate, inactivity, error, signIn,
redirect, planComplete. With one of these, \`triggerPhrases\` is not used.

## Rules
Trigger phrases must not overlap between topics. Overlapping phrases make the agent pick the wrong
one. \`cs_review_agent\` reports overlaps.
Power Fx conditions start with "=". The tool adds it if you leave it out.

## Change an existing topic
\`cs_edit_topic\` - change phrases, priority, or one node by position or id.
\`cs_remove_component\` - delete the topic and warn about redirects that pointed at it.

## Then
\`cs_validate\`, then \`cs_push\` with \`confirm: true\`, then \`cs_publish\` with \`confirm: true\`.`;
const EVALUATIONS = `# Evaluations and tests

Two ways to check the agent. Use both.

## 1. Evaluations (Copilot Studio's own, needs the portal once)
Test sets cannot be created through the API. One manual import is unavoidable.

1. \`cs_create_test_set_csv\` with \`suggestFromWorkspace: true\` writes a CSV.
   Better: \`cs_test_set_from_transcripts\` builds it from questions real users asked and the agent
   failed to answer. Topic "transcripts".
2. Give the user the file path. They import it: agent > Evaluation tab > New evaluation >
   Single responses > Import. Maximum 100 cases.
3. \`cs_list_test_sets\` - find the id of the imported set.
4. \`cs_run_evaluation\` with \`confirm: true\` after the user approves.
5. \`cs_get_evaluation_run\` - per-case results, bucketed pass / fail / error.

Limit: 20 runs per agent per 24 hours.

## 2. Conversation tests (no portal step, run them often)
\`cs_run_conversation_tests\` runs a local YAML file of utterances with expected keywords, topics or
tools through \`cs_chat\` and reports pass or fail.
\`cs_run_conversation_tests\` with \`writeExample: true\` writes a starter file.
Run this after every push. It is the cheap check.

## Reading a failure
A wrong answer is almost always one of these four:
1. The instructions do not say how to answer. Topic "instructions".
2. A knowledge source is not reachable for the signed-in user. Topic "knowledge".
3. A tool's description does not say when to use it, so the agent never picks it. Topic "tools".
4. Two topics share trigger phrases, so the wrong one fires. Topic "topics".

\`cs_review_agent\` finds all four without running anything. Run it first.`;
const TRANSCRIPTS = `# What the agent is doing in production

Every other topic describes the agent you built. This one describes the agent people actually met.
All read-only. Needs a published agent that people have used, and a \`cs_login\` that covers Dataverse.

## 1. Look at the shape
\`cs_summarize_transcripts\` with \`days\` (for example 30).
Read \`sessionsWithoutTopic\` first: sessions where nothing you authored matched what the user asked.
That number is the clearest measure of a gap.
Also reported: how sessions ended, the escalation rate, average turns, which topics and tools
actually fire, and the questions behind sessions that went badly.

## 2. Read an actual conversation
A rate is not a diagnosis. Never propose a fix from the summary alone.
\`cs_list_transcripts\` with \`outcome\` or \`search\` to find the session.
\`cs_get_transcript\` with \`transcriptId\` for every turn, with the topic and tool attributed to each.

## 3. Turn the failures into a test
\`cs_test_set_from_transcripts\` writes the evaluation import CSV from the questions people actually
asked. By default it keeps only sessions that escalated, went unanswered or were abandoned.
Import it once in the portal, then \`cs_run_evaluation\` automates every run after that.
Topic "evaluations".

## What the outcomes are NOT
Copilot Studio does not report whether a session succeeded. This server reads the transcript and
guesses: an escalation, the agent saying it could not answer, a user turn with no reply, or none of
those.
"resolved" means nothing marked the session as failed. It does NOT mean the user was happy.
Never present these numbers as satisfaction or resolution rates. Say they are derived from the
transcript text.`;
const PUBLISH_AND_TEST = `# Publishing and testing

## Publish
\`cs_push\` sends files to the agent's DRAFT. Users do not see draft changes.
\`cs_publish\` makes the draft live. Until you publish, nothing you did is visible to anyone.

Both change a live environment:
1. Call without \`confirm\`.
2. Show the dry run to the user in your own words.
3. Ask.
4. Call again with \`confirm: true\`.

\`cs_publish\` has two routes. \`via: "pac"\` is the default. \`via: "dataverse"\` polls until the
published timestamp changes and says more when a publish fails.

IF \`cs_publish\` takes longer than the client allows -> call it again with \`background: true\` and
poll \`cs_job_status\`.
IF the result says pac reported a failure -> do not tell the user it published. Ask them to check
the agent in the portal.

## Test
\`cs_chat\` with \`utterance\`. Pass \`conversationId\` from the previous reply to continue a conversation.

Routing is automatic. \`transport: "auto"\` reads the agent's authentication mode:
- no authentication or manual authentication -> DirectLine. Needs nothing extra.
- Entra SSO -> the Copilot Studio SDK, which needs the user's own app id in \`clientId\`.

IF \`cs_chat\` returns no replies -> the result says what to try. The agent may be unpublished, slow,
or not reachable on that route. Raise \`maxMs\`, or pass \`background: true\`.
IF the reply contains a sign-in card -> the result has \`signInUrl\`. Show it to the user.

## After publishing
\`cs_run_conversation_tests\` for a repeatable check.
\`cs_summarize_transcripts\` once real users have used it. Topic "transcripts".`;
const DRIFT = `# Portal drift (someone edited the agent in Copilot Studio)

Makers edit agents in the portal. Those edits are not in your workspace. Pushing over them loses
their work.

## Always check before you edit
\`cs_check_drift\` with \`mode: "quick"\`.
It compares the agent's components in Dataverse with the stamp written at the last clone, pull or
push, and reports which topics, tools and knowledge sources changed, by whom and when.
Needs a \`cs_login\` that covers Dataverse. \`cs_init\` reports whether it does under \`cloudAccess.ready\`.

\`mode: "full"\` clones the agent into a temporary folder and compares every file, with diffs.
Slower. Needs only the pac auth profile, not \`cs_login\`. Use it when quick mode is unavailable.

## Reading the result
- \`localChanges\` - files you changed since the last sync.
- remote-modified - components a maker changed in the portal.
- \`conflicts\` - changed in both places. These are the dangerous ones.

## What to do
IF only the portal changed -> \`cs_pull\` to bring those edits down.
IF only local files changed -> \`cs_push\` (with approval).
IF there are conflicts -> \`cs_pull\` first. It does a three-way merge. Review the result, then push.

\`cs_push\` runs the quick check itself and refuses when there are conflicts. \`force: true\` overrides
that. Do not pass \`force\` unless the user has seen the conflict list and said to overwrite.

## Keep it reviewable
The workspace is files. Commit it to git after every pull and push. Then a portal edit that arrives
later shows up as a normal diff.`;
const SOLUTIONS = `# Solutions (moving agents between environments)

A per-agent workspace stays tied to the environment it came from. \`cs_push\` cannot move an agent to
another environment. Solutions are how things move from dev to test to production.

## Pull everything from the source
\`cs_pull_solution\` with \`name\` (the solution unique name) and \`targetDir\`.
It exports, unpacks, writes \`solution.json\` and \`deployment-settings.json\`, and clones every agent.

This runs for minutes. Pass \`background: true\`, then poll \`cs_job_status\` with the returned \`jobId\`.
IF the call is cut off after about a minute -> that was the client's limit, not the tool's. Call
again with \`background: true\`. Do not retry with a shorter path.
\`packagetype: "Unmanaged"\` halves the work by skipping the second export.

\`cs_describe_solution\` lists what is inside without keeping it: agents, components, flows,
connection references, environment variables, custom connectors.

## Map it to the target
1. \`cs_list_connections\` against the TARGET environment. Get the connection ids there.
2. \`cs_create_deployment_settings\` writes the settings file.
3. Fill in each connection reference and environment variable for the target.
Unmapped connection references are the usual reason an import looks fine and nothing works.

## Deploy
\`cs_deploy_solution\` with \`targetEnvironment\` and \`confirm: true\` after the user approves.

## After the import, check these
- Cloud flows arrive switched OFF when their connections could not be resolved. \`cs_bind_flow_connection\`
  points each one at a connection in the target and can turn the flow on in the same call; \`cs_set_flow_state\`
  turns one on by itself. cs_guide topic 'flows'.
- Agents may need publishing in the target.
- Tools show as not connected until someone connects them in the target portal.

## Compare environments
\`cs_snapshot_environment\` then \`cs_compare_snapshots\`, or \`cs_compare_environments\` directly.
It separates real drift from differences that are expected between stages (connection bindings,
variable values, managed flag).`;
const ADMINISTRATION = `# Tenant administration

These tools act on the tenant, not on one agent. They run as a DIFFERENT account from the maker
account.

## Set up the admin account once
\`cs_create_auth_profile\` with \`name: "admin"\`, \`environment\` and \`background: true\`.
pac opens a browser. The user signs in there. Poll \`cs_job_status\` with the returned \`jobId\`.
Then \`cs_list_auth_profiles\` shows it.
Set \`CPS_ADMIN_PROFILE=admin\` so the admin tools pick it automatically.

Every pac-backed tool takes \`profile\`. Pass it to choose the account for one call.

## Read-only, safe to run
\`cs_admin_list_environments\` - environments in the tenant.
\`cs_admin_list_dlp_policies\` and \`cs_admin_show_dlp_policy\` - data loss prevention.
\`cs_admin_list_environment_groups\`, \`cs_admin_list_security_roles\`, \`cs_admin_list_applications\`,
\`cs_admin_list_service_principals\`, \`cs_admin_list_backups\`, \`cs_admin_list_tenant_settings\`.

\`cs_backup_tenant\` writes the whole tenant configuration to files. Read-only for the tenant; it only
writes locally. Run it before any change, and commit the folder, so you can diff later.

## Destructive - say what will be lost BEFORE asking
\`cs_admin_reset_environment\` - erases everything in the environment.
\`cs_admin_delete_environment\` - removes it.
\`cs_admin_copy_environment\` - OVERWRITES the target with the source.
\`cs_admin_restore_environment\` - overwrites with a backup.
For each: name the environment, say what disappears, ask, and only then pass \`confirm: true\`.
Never chain two of these on one approval.

## Rules
Tenant settings and DLP policies affect every maker in the company. Change them only when the user
asked for that specific change.
IF an admin command fails with a permissions error -> the profile is probably the maker account.
Check \`profile\` and \`CPS_ADMIN_PROFILE\`.`;
const TROUBLESHOOTING = `# Troubleshooting

Find the symptom. Do what the line says.

## The tool is not in the list
A tool named in a guide but missing from tools/list is hidden or stale. It is not a missing feature.
1. Check \`cs_init\` \`serverBuild.toolPreset\`. A preset hides tools. \`cs_pac\` still runs pac commands.
2. Check \`cs_init\` \`serverBuild.modulePath\`. IF it points somewhere other than the repo the user
   just updated -> the client is running an old copy. Tell them to rebuild and restart the client.
Never report a tool as unimplemented on this evidence alone.

## The call died after about a minute
That is the MCP client's limit, not the tool's, and the work is still running.
Call the same tool again with \`background: true\`, then poll \`cs_job_status\`.
Never retry with a shorter path, a smaller argument, or a different directory. It will not help.

## A cloud tool fails
Run \`cs_init\`. Read \`cloudAccess.ready\`.
IF a resource is not "ok" -> the user runs \`cs_login\`. That is the whole fix.
A listed MSAL account does not mean the token works: read \`cloudAccess.ready\`, not the account list.

## pac says failed but the result says ok
Trust the output text. Tell the user to check the agent in the portal. Do not report success.

## Other symptoms
"workspace not found" - the folder is not sync-connected. Use \`cs_clone_agent\`, or
\`cs_create_agent\` with \`environment\`.
"Unsupported directory" from pack - a local scaffold packs settings, agent and topics only.
\`cs_push\` from a sync-connected workspace handles the rest.
\`cs_push\` refuses - \`cs_validate\` has errors, or \`cs_check_drift\` found conflicts. Fix the errors;
for conflicts run \`cs_pull\` first.
A knowledge source returns nothing - the agent was pushed but not published, or the source needs a
connection nobody made in the portal.
The agent answers as before after a push - a push only changes the draft. Run \`cs_publish\`.
A tool is never called - its description does not say WHEN to use it. Fix it with \`cs_edit_tool\`.
Too many tools for the client - the user sets \`CPS_TOOLS=core\` in the server environment.

## Where to look
Diagnostics go to stderr; the client's MCP output pane shows them.
Every pac-backed result carries the exact command, exit code and output tail.`;
const FLOWS = `# Cloud flows: build, bind, run, diagnose

A cloud flow is a Power Automate workflow in the same environment as the agent. An agent calls one
through a tool (\`cs_add_tool\` type 'flow'); the flow itself lives in Dataverse, not in the agent's
workspace, so these tools reach the environment directly rather than writing YAML.

## Build one

1. \`cs_list_connectors\` and \`cs_describe_connector\` give the connector id, the operation id and
   the parameters an operation takes. Guessing an operation id produces a flow that saves and then
   fails at runtime, so look it up.
2. \`cs_build_flow_definition\` composes the definition from a trigger plus steps, without touching
   the environment. Steps run in order; conditions, loops and scopes nest. Expressions are Logic
   Apps expressions, not Power Fx.
3. \`cs_create_flow\` creates it, optionally straight into a solution, with the same spec. It is
   created switched OFF, because a flow can only run once its connections are bound.
4. \`cs_update_flow\` replaces the definition of an existing unmanaged flow, keeping its connection
   references.

## Bind its connections

A connection reference names a connector; a connection is one person's authorised account for it.
Until they are joined the flow cannot be turned on.

- \`cs_bind_flow_connection\` does the join. With one reference and one usable connection it needs
  no arguments beyond the flow id; otherwise it asks which. \`activate: true\` turns the flow on in
  the same call.
- \`cs_list_connections\` shows what exists. \`cs_create_connection\` makes one for connectors that
  do not require an interactive sign-in; the rest must be authorised in the portal.
- A flow that arrived through a solution points at a \`connectionreference\` row instead of naming
  a connection directly. \`cs_bind_flow_connection\` writes whichever of the two applies.
- \`cs_set_flow_state\` turns a flow on or off once it is bound.

## Run it

\`cs_run_flow\` starts a manually triggered or agent-callable flow, with an optional payload
(\`confirm\` required: the flow's actions happen for real). Scheduled and event-driven flows start
themselves. \`cs_list_flow_runs\` is the history; \`cs_get_flow_run\` is one run's status and timing.

## Diagnose a failure

The run list says a run failed and nothing more. Three tools answer why.

- \`cs_explain_flow_run\` is where to start. A failed connector action carries no error message of
  its own - the message is in the action's outputs, behind a link that expires after a few days -
  so this fetches it, says whether the fault is the connector, an expression or a timeout, and
  shows the inputs the action was called with plus the outputs of the actions just before it.
- \`cs_compare_flow_runs\` answers "it worked yesterday". It diffs the failed run against the most
  recent successful one and names the action where they part company. With
  \`compareTriggerData: true\` it also reports which keys of the trigger payload differ, which is
  what separates a bad input from a broken flow. Actions present in one run but not the other mean
  the definition itself changed.
- \`cs_analyze_flow_health\` answers "it fails sometimes": failure rate, duration spread, and which
  actions the failures land on. One action responsible for most of them is a broken step; failures
  spread across many actions point at the connection, throttling or the system being called.

A trigger that failed means the flow never ran at all: the fault is in the trigger's connection or
its parameters, not in the logic. Actions marked Skipped are consequences of an earlier failure.

## What to expect

- The run tools use the Power Automate service, which is a separate sign-in from Dataverse:
  \`cs_login\` with scope 'flow'. The signed-in user must own or co-own the flow.
- Run detail ages out. Inputs and outputs are kept for a limited time, so diagnose a failure while
  it is recent; afterwards only the status survives.
- Managed flows cannot be edited in place. Change them in their source environment and redeploy the
  solution.`;

const GUIDES: Record<GuideTopic, string> = {
  "getting-started": GETTING_STARTED,
  instructions: INSTRUCTIONS,
  knowledge: KNOWLEDGE,
  tools: TOOLS,
  topics: TOPICS,
  flows: FLOWS,
  evaluations: EVALUATIONS,
  "publish-and-test": PUBLISH_AND_TEST,
  drift: DRIFT,
  transcripts: TRANSCRIPTS,
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
  flows: "build a cloud flow, bind its connections, run it, and work out why a run failed",
  evaluations: "test sets, runs and results, plus local conversation tests",
  "publish-and-test": "publish the agent and chat with it",
  drift: "changes made in the portal since the last sync, and how to merge them",
  transcripts: "what real users asked, how those sessions ended, and turning the failures into a test set",
  solutions: "pull a solution, redeploy it elsewhere, compare environments",
  administration: "tenant administration with a separate admin account, and backing the tenant configuration up to files",
  troubleshooting: "the errors this server can return, and what each one means",
};

/**
 * What to do next in this workspace, most useful first. Derived from the
 * inventory only, so it costs nothing to include in other tool results.
 */
/** What the machine still needs before any cloud tool will work. */
function machineSteps(opts: { pacFound?: boolean; pacProfile?: boolean; signedIn?: boolean }): string[] {
  const out: string[] = [];
  if (opts.pacFound === false) out.push("Install the Power Platform CLI: dotnet tool install --global Microsoft.PowerApps.CLI.Tool (needs .NET 10). cs_guide topic 'troubleshooting'.");
  if (opts.pacProfile === false) out.push("No pac auth profile: ask the user to run 'pac auth create --environment <id>' in a terminal.");
  if (opts.signedIn === false) out.push("Not signed in for the API-based tools (evaluations, chat, drift): run cs_login.");
  return out;
}

/** What the agent is still missing: instructions, and something to answer from. */
function contentSteps(ws: WorkspaceInfo): string[] {
  const out: string[] = [];
  const instructions = (ws.agent?.instructions ?? "").trim();
  if (ws.harness !== "github-copilot" && instructions.length < 200) {
    out.push(instructions ? "Instructions are short: expand them with cs_generate_instructions (refine: true) or cs_update_agent. cs_guide topic 'instructions'." : "The agent has no instructions: cs_generate_instructions, then apply. cs_guide topic 'instructions'.");
  }
  if (!ws.knowledge.length && !ws.knowledgeFiles.length) out.push("No knowledge sources: cs_add_knowledge_source. cs_guide topic 'knowledge'.");
  if (!ws.actions.length) out.push("No tools: cs_list_connectors then cs_add_tool. cs_guide topic 'tools'.");
  if (!ws.topics.some((t) => t.details.triggerKind === "OnRecognizedIntent")) out.push("No custom topics: cs_add_topic for conversations that must follow a fixed path. cs_guide topic 'topics'.");
  return out;
}

/** What has to happen before and after the workspace reaches the environment. */
function syncSteps(ws: WorkspaceInfo): string[] {
  const out: string[] = [];
  const unbound = ws.connectionReferences.filter((c) => !c.connectionId).length;
  if (unbound) out.push(`${unbound} connection reference(s) are not bound: after cs_push, the user connects each tool once in the portal, then run cs_pull.`);
  out.push(
    ws.sync.source !== "none"
      ? "Before editing: cs_check_drift (what changed in the portal since your last sync). Before pushing: cs_review_agent, then cs_validate, then cs_push with confirm."
      : "Before pushing: cs_review_agent, then cs_validate.",
  );
  return out;
}

export function nextSteps(ws: WorkspaceInfo | null, opts: { pacFound?: boolean; pacProfile?: boolean; signedIn?: boolean } = {}): string[] {
  const out = machineSteps(opts);
  if (!ws) {
    out.push("No workspace found: cs_clone_agent for an existing agent, or cs_create_agent (with environment and solutionName) for a new one. cs_guide topic 'getting-started'.");
    return out;
  }
  if (ws.sync.source === "none") out.push("This workspace has no sync metadata, so only settings, agent and topics can be packaged. Clone the agent (cs_clone_agent) or init with an environment to use knowledge, tools and flows.");
  return [...out, ...contentSteps(ws), ...syncSteps(ws)];
}
