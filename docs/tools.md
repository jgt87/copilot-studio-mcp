# Tool reference

Every tool the server registers, grouped by area. The README describes the workflows these tools
serve; this page is the lookup table. Tool names are exact. Counts: 142 tools in total; the
`core`, `authoring`, `admin` and `solutions` presets (README, "Running on a smaller model") offer
34, 25, 44 and 25 of them.

Every tool that can change a live environment returns a dry run and does nothing else until it is
called again with `confirm: true` (README, "Approval before anything changes"). Tools marked
`confirm` below are on that list. With `CPS_READ_ONLY=1` they are not registered at all.

## Guidance (start here)

| Tool | Purpose |
| --- | --- |
| `cs_guide` | walkthrough for one topic: `getting-started`, `instructions`, `knowledge`, `tools`, `topics`, `evaluations`, `publish-and-test`, `drift`, `transcripts`, `solutions`, `administration`, `troubleshooting`; each names the tool per step and the portal steps that cannot be automated, and ends with next steps for your workspace |

The server also sends usage instructions in the MCP handshake, `cs_init` and
`cs_describe_workspace` end with next steps for the workspace they found, and six MCP prompts
(new agent, add knowledge, add tool, write instructions, review and push, check drift) are
available in clients that show prompts as commands.

When a call cannot proceed because something has not been decided yet, the tool returns a
**question** rather than an error: `needsInput: true`, what it needs, why, the real choices when the
server can list them (connectors ranked against what you asked for, a connector's operations, the
agents in an environment), and the tool that lists more. Nothing is written, and the calling agent
is told to ask you and call again. This works in every client, including those that do not support
the MCP elicitation feature.

## Setup and sync (pac)

| Tool | Purpose |
| --- | --- |
| `cs_init` | start a session: pac / .NET, the pac auth profiles and which is active, MSAL sign-in, environment variables, the write policy in force, the workspace it found, and the next steps for it |
| `cs_login`, `cs_login_status`, `cs_logout` | MSAL sign-in (interactive or device code) for the cloud tools |
| `cs_list_environments`, `cs_list_agents` | environments (BAP) and agents (pac or Dataverse) |
| `cs_create_agent` | `pac copilot init` (classic or cli-copilot): a local scaffold, or the live agent as well when given an environment, optionally inside a chosen or new solution |
| `cs_create_solution` | create an unmanaged solution (and publisher) as the container for new agents |
| `cs_generate_instructions` | draft or refine the agent instructions with an AI Builder prompt (`pac copilot model predict`) and write them into the workspace |
| `cs_clone_agent`, `cs_pull`, `cs_push`, `cs_status` | sync a live agent with the workspace; clone, pull and push record a sync stamp |
| `cs_check_drift` | changes made in Copilot Studio since the last clone, pull or push: quick (Dataverse component stamps: who, what, when) or full (temporary clone, three-way file diff); the `cs_push` dry run runs the quick check |
| `cs_pack`, `cs_import_solution`, `cs_publish` | package, import, publish |
| `cs_pac` | run any pac command (read-only ones immediately, others with `confirm`) |

## Solutions (pull everything, redeploy 1:1 into another environment)

| Tool | Purpose |
| --- | --- |
| `cs_list_solutions`, `cs_list_connections` | solutions in an environment; connections available in a target environment |
| `cs_describe_solution` | export + unpack + inventory: agents, bot components, flows, connection references, environment variables, custom connectors |
| `cs_pull_solution` | export (unmanaged and managed), unpack to `src/`, write `solution.json`, create `deployment-settings.json`, clone every agent into `agents/` |
| `cs_create_deployment_settings` | map connection references to target connection ids and set environment variable values |
| `cs_pack_solution`, `cs_deploy_solution` | pack an edited `src/`; import into the target with the settings file and publish each agent (`confirm`) |

## Environment comparison (DTAP)

| Tool | Purpose |
| --- | --- |
| `cs_snapshot_environment` | capture one environment into a folder: solution version, every agent cloned, flows, connection references, environment variables, publish state |
| `cs_compare_snapshots` | offline diff of two snapshots with a Markdown + JSON report; `failOnDrift` for pipeline gates |
| `cs_compare_environments` | snapshot an ordered chain (DEV, TEST, ACC, PROD) and compare each adjacent pair |

## Tenant administration (Power Platform admin centre; run as the admin profile)

| Tool | Purpose |
| --- | --- |
| `cs_backup_tenant` | write the whole tenant configuration to local files: settings, environments, DLP policies, groups, service principals, applications, templates, and per environment its details, solutions, agents, connections, roles and platform backups |
| `cs_admin_assign_users` | give a roster of users their security roles in one environment, from a CSV or an inline list, under a single approval; the dry run lists every user-and-role pair first (`confirm`) |
| `cs_list_auth_profiles` | the pac auth profiles on this machine, which is active, and the defaults for maker and admin |
| `cs_admin_list_environments`, `cs_admin_environment_status`, `cs_admin_list_backups` | environments, operations in progress, platform backups |
| `cs_admin_list_tenant_settings`, `cs_admin_update_tenant_settings` | read the tenant settings (optionally to a JSON file) or change one (`confirm`) |
| `cs_admin_list_dlp_policies`, `cs_admin_show_dlp_policy` | data loss prevention policies: which connectors may be combined |
| `cs_admin_list_environment_groups`, `cs_admin_add_environment_to_group` | environment groups (`confirm` to add) |
| `cs_admin_list_security_roles`, `cs_admin_assign_user`, `cs_admin_assign_group` | roles in an environment, and granting them (`confirm`) |
| `cs_admin_list_service_principals`, `cs_admin_create_service_principal`, `cs_admin_list_applications`, `cs_admin_register_application`, `cs_admin_unregister_application` | headless identities and registered applications (`confirm` to change) |
| `cs_admin_set_governance_config`, `cs_admin_set_runtime_state`, `cs_admin_set_backup_retention` | managed environments, administration mode, backup retention (`confirm`) |
| `cs_admin_create_environment`, `cs_admin_delete_environment`, `cs_admin_reset_environment`, `cs_admin_copy_environment`, `cs_admin_restore_environment`, `cs_admin_backup_environment` | environment lifecycle (`confirm`; reset and delete destroy everything in the environment, copy and restore overwrite the target) |
| `cs_admin_list_app_templates`, `cs_admin_query`, `cs_admin_self_elevate` | Dynamics 365 templates, tenant resource queries, self-elevation (`confirm`) |

## Remaining pac commands (declarative wrappers over `pac <group> <command>`; flags from pac 2.11.2)

| Tool | Purpose |
| --- | --- |
| `cs_extract_agent_template`, `cs_create_agent_from_template` | template an existing agent and create new agents from it |
| `cs_extract_translations`, `cs_merge_translations` | localisation round trip (.resx / .json), with `whatIf` |
| `cs_quarantine_agent` | quarantine or release an agent (`confirm`) |
| `cs_init_solution_project`, `cs_clone_solution`, `cs_sync_solution`, `cs_add_solution_reference`, `cs_add_solution_license` | source-controlled solution projects (.cdsproj) |
| `cs_check_solution` | Solution Checker as a quality gate before deploying |
| `cs_set_solution_version`, `cs_solution_online_version`, `cs_upgrade_solution`, `cs_publish_customizations`, `cs_add_solution_component` | release numbering, staged upgrades, publish all, add components (`confirm` where the environment changes) |
| `cs_list_pipelines`, `cs_deploy_pipeline` | Power Platform pipelines as the alternative to `cs_deploy_solution` (`confirm`) |
| `cs_create_connection`, `cs_update_connection`, `cs_delete_connection` | service-principal Dataverse connections, the only kind pac can create (`confirm`) |
| `cs_create_auth_profile`, `cs_select_auth_profile`, `cs_auth_who`, `cs_delete_auth_profile` | pac auth profiles, including service-principal, certificate, managed-identity and federated profiles for pipelines |
| `cs_env_list`, `cs_env_who`, `cs_env_fetch`, `cs_env_select` | environments through pac (no MSAL sign-in needed), including FetchXML queries |

Onboarding a team into a new environment is `cs_admin_create_environment` (async: pair it with
`background: true` and `cs_job_status`, since provisioning is slow) and then `cs_admin_assign_users`
with a CSV:

```csv
UPN,Security Roles,Business Unit
alice@contoso.com,"System Customizer,Basic User",Sales
bob@contoso.com,Environment Maker,
```

`pac admin assign-user` takes one user and one role per call, so that roster is five calls;
`cs_admin_assign_users` expands it and runs them under one approval, having first shown you every
pair. Rows are independent, so a mistyped UPN is reported and the rest still run.

**Prefer `cs_admin_assign_group` when the roster is really a group.** Binding an Entra group to a
role through a Dataverse team is one call per role however many people are in the group, and new
joiners inherit access without anyone touching Dataverse; Microsoft recommends it over per-user
assignment. Two things to check first either way: role names are per-environment
(`cs_admin_list_security_roles` against the new one), and a user who has not been provisioned into
the environment yet cannot hold a role there.

## The Microsoft 365 agent catalogue (Microsoft Graph; a separate sign-in, `cs_login scope='graph'`)

| Tool | Purpose |
| --- | --- |
| `cs_list_org_agents` | every agent in the organisation's Microsoft 365 catalogue, across environments, filtered by platform (Copilot Studio by default), host, element type or last-modified date; reports who each agent is available to, where it is deployed and whether it is blocked |
| `cs_get_org_agent` | one catalogue entry in full, with the raw body alongside the mapped fields |
| `cs_block_org_agent` | block an agent for everyone in the tenant, or lift the block (`confirm`) |
| `cs_reassign_org_agent` | hand a catalogue agent to a new owner, for when the old one leaves (`confirm`) |

This is the one view Power Platform cannot give you. `cs_list_agents` reads the `bots` table of a
single environment and stops at the Power Platform boundary; the catalogue is tenant-wide and adds
the question that follows `cs_publish`: **did the agent actually reach anyone?** `availableTo`,
`deployedTo` and `isBlocked` answer it. It needs a **Microsoft Agent 365** licence, is global-cloud
only, and is unverified against a live tenant; block and reassign exist only on Graph `beta`.

Every other pac group (application, canvas, catalog, code, data, managed-identity, model,
modelbuilder, package, pages, pcf, plugin, power-fx, telemetry, test, tool) is outside Copilot
Studio work and stays reachable through `cs_pac`; `pac copilot mcp` is pac's own MCP server and
is not wrapped. With that many tools, `CPS_TOOLS` / `CPS_TOOLS_EXCLUDE` (see Install) can hide the
ones a session does not need.

## Authoring (files, schema-validated)

| Tool | Purpose |
| --- | --- |
| `cs_describe_workspace` | inventory of settings, topics, knowledge, tools, flows, triggers, variables |
| `cs_validate` | structural + cross-file validation; `cs_push` runs it first |
| `cs_lookup_schema` | inspect the YAML schema (summaries, resolved definitions, kinds) |
| `cs_add_topic` | topic from a declarative spec: trigger phrases plus message, question, condition, set variable, redirect, HTTP, flow, generative answers (optionally scoped to named knowledge sources), adaptive card (display or input), transfer to agent or phone, end conversation, and raw nodes |
| `cs_add_knowledge_source` | public website, SharePoint, Graph connector, or files |
| `cs_add_tool` | connector action, MCP server, cloud flow, AI Builder prompt, connected agent, child agent, or any other TaskAction kind as raw (+ connection-reference stub) |
| `cs_list_connectors`, `cs_describe_connector`, `cs_list_prompts` | tool catalog: connectors available in the environment (with MCP detection), a connector's operations and parameters, AI Builder prompts |
| `cs_add_flow` | experimental cloud-flow scaffold (`workflows/<Name>/metadata.yaml` + `workflow.json`) |
| `cs_list_flows`, `cs_get_flow` | cloud flows in the environment: state, owner, connection references, and the full Power Automate definition |
| `cs_build_flow_definition` | compose a flow definition from steps (connector operations, HTTP, conditions, loops, variables, response) without touching an environment; returns the definition and the connection references it needs |
| `cs_set_flow_state`, `cs_update_flow`, `cs_create_flow`, `cs_delete_flow` | turn a flow on or off, rebuild or replace the definition of an unmanaged flow, create a new flow from steps or a definition in an environment or a solution, or delete one for good (`confirm`) |
| `cs_bind_flow_connection` | point a flow's connection reference at a real connection, the step that lets a flow be switched on; handles both a flow that names a connection directly and one whose `connectionreference` row a solution import left unbound, and can activate the flow in the same call (`confirm`) |
| `cs_list_flow_runs`, `cs_get_flow_run`, `cs_run_flow` | run history of a flow, one run in detail, and starting a manual run (`confirm`); these use the Power Automate service, a separate sign-in (`cs_login scope='flow'`) |
| `cs_explain_flow_run` | why one run failed: the real error of each failed action (a failed connector action carries none of its own, so it is read from the action's outputs), whether the fault is the connector, an expression or a timeout, the inputs the action was called with, and the outputs of the actions just before it |
| `cs_compare_flow_runs` | diff a failed run against a successful one: where the two part company, which actions changed status, which exist in only one of them (the definition changed), and optionally which trigger-payload keys differ (key names only) |
| `cs_analyze_flow_health` | reliability across recent runs: failure rate, duration median and 90th percentile, and which actions the failures concentrate on |
| `cs_add_trigger`, `cs_add_variable` | event trigger for a flow; global variable |
| `cs_update_agent`, `cs_update_settings` | the agent's own settings (instructions, response instructions and mode, history, capabilities, moderation, model, starters) and anything else in `settings.mcs.yml` by dot path; see "Agent settings this server can write" |
| `cs_edit_topic`, `cs_edit_tool`, `cs_edit_knowledge` | change existing components in place: trigger phrases, nodes, descriptions, inputs, sites |
| `cs_remove_component`, `cs_delete_agent`, `cs_delete_solution` | remove a component from the workspace; delete an agent or a solution in the environment (`confirm`) |
| `cs_review_agent` | rules-based review: instructions, escalation and fallback, phrase overlap, tool descriptions, connections, authentication versus private knowledge, secrets |

## Evaluation and testing (cloud)

| Tool | Purpose |
| --- | --- |
| `cs_create_test_set_csv` | CSV for the portal's Evaluation import, optionally suggested from the workspace |
| `cs_list_test_sets`, `cs_run_evaluation`, `cs_get_evaluation_run`, `cs_list_evaluation_runs` | Power Platform API evaluations with pass/fail summaries |
| `cs_chat` | one utterance to the published agent (DirectLine or SDK), multi-turn via `conversationId` |
| `cs_run_conversation_tests` | YAML test file of utterances + expectations, run through `cs_chat` |

## Background jobs

| Tool | Purpose |
| --- | --- |
| `cs_job_status` | state, phases and result of a tool started with `background: true`; reads the on-disk record when the server has restarted |

`cs_pull_solution` accepts `background: true`: a full pull (export, unpack, settings, a clone per
agent) runs for minutes and MCP clients cap how long a call may take, so it returns a `jobId`
immediately and writes its outcome to `pull-job.json` in the target directory. The confirm contract
is unaffected: a tool decides whether it may change anything before it starts a job.

## Production conversations (cloud, read-only)

| Tool | Purpose |
| --- | --- |
| `cs_list_transcripts` | sessions with the published agent: when, turns, first question, topics and tools that fired, how it ended |
| `cs_get_transcript` | one session's full turn list, with the topic and tool attributed to each turn |
| `cs_summarize_transcripts` | aggregate over a window: outcomes, escalation rate, sessions that matched no topic, top topics and tools, the questions behind the failures |
| `cs_test_set_from_transcripts` | the Evaluation import CSV built from questions people actually asked, failures first |

Transcripts read the Dataverse `conversationtranscript` table and need a published agent that people
have used. Session outcomes are this server's reading of the transcript, not something Copilot
Studio reports: `resolved` means nothing marked the session as failed, not that the user was
satisfied. Every result repeats that caveat, and `cs_guide` topic `transcripts` explains the loop
from a summary to one transcript to a regression test set. **Unverified against a live tenant.**


## What each tool does in Copilot Studio

Each row maps a tool to what a maker would do in the portal for the same result, and to how the
server does it.

| Tool | The same action in Copilot Studio | How the server does it |
| --- | --- | --- |
| `cs_init` | nothing in the portal; checks pac, .NET, the pac profiles and sign-in on your machine, and says what to do next | local checks |
| `cs_list_solutions`, `cs_create_solution` | Power Apps maker portal > Solutions: pick or create the unmanaged solution the agent lives in | `pac solution list`; empty manifest packed and imported |
| `cs_create_agent` (with `environment`, `solutionName`) | Copilot Studio > Create > New agent, saved into that solution; the agent appears with its default system topics | `pac copilot init`, `pack`, `pac solution import`, `pac copilot clone` |
| `cs_generate_instructions` | Overview > Instructions: the portal's "generate with AI" step, using your AI Builder prompt | `pac copilot model predict`, then `agent.mcs.yml` |
| `cs_update_agent` | Overview and Settings: instructions, response instructions and mode, conversation history, capability toggles, content moderation, model, conversation starters | edit `agent.mcs.yml` |
| `cs_add_topic` | Topics > Add a topic > From blank: trigger phrases and the message, question, condition, set variable, redirect, HTTP, generative answers, adaptive card, transfer and end conversation nodes | YAML in `topics/` |
| `cs_add_knowledge_source` | Knowledge > Add knowledge: public website, SharePoint, Graph connector, or file upload | YAML in `knowledge/`, files in `knowledge/files/` |
| `cs_list_connectors`, `cs_describe_connector` | Tools > Add a tool: the connector picker and its list of actions | Power Apps connector registry |
| `cs_add_tool` | Tools > Add a tool: connector action, MCP server, flow, prompt or agent, everything except the "Connect" sign-in | YAML in `actions/` plus `connectionreferences.mcs.yml` |
| `cs_add_flow`, `cs_add_trigger`, `cs_add_variable` | Tools > New agent flow; Triggers > Add trigger; Settings > Variables | files in `workflows/`, `trigger/`, `variables/` |
| `cs_edit_topic`, `cs_edit_tool`, `cs_edit_knowledge` | editing a topic's trigger phrases and nodes, a tool's description and inputs, or a knowledge source's URL in the portal | in-place YAML edits |
| `cs_remove_component` | deleting a topic, knowledge source, tool, trigger or variable from the agent | file removal, applied on push |
| `cs_delete_agent`, `cs_delete_solution` | Agents > delete the agent; Power Apps maker portal > Solutions > delete the solution (`confirm`) | `pac copilot delete`, `pac solution delete` |
| `cs_review_agent` | a maker's pre-publish walkthrough of the agent (no single portal page does this) | rules over the workspace |
| `cs_validate` | the errors the portal would show on save, before anything is sent | schema and cross-file checks |
| `cs_push` | Save: the draft agent in the portal now shows your topics, knowledge and tools; refused when a maker changed the same component in the portal since your last pull | `pac copilot push` after a quick drift check |
| `cs_check_drift` | opening each topic, tool and knowledge source to read its "modified by" line and see what colleagues changed since you last synced | Dataverse component rows against the sync stamp; or `pac copilot clone` plus a three-way file diff |
| (portal step) | Tools > the new tool > Connect: sign in once so the connection exists | manual, then `cs_pull` |
| `cs_pull` | refresh the local files from the draft agent | `pac copilot pull` |
| `cs_publish` | the Publish button | `pac copilot publish` or Dataverse `PvaPublish` |
| `cs_chat`, `cs_run_conversation_tests` | the Test pane, against the published agent | DirectLine or the Copilot Studio client SDK |
| `cs_create_test_set_csv` | Evaluation > New evaluation > Import (file) | CSV in the import format |
| `cs_list_test_sets`, `cs_run_evaluation`, `cs_get_evaluation_run` | Evaluation page: the test sets, Run, and the results view | Power Platform API |
| `cs_pull_solution` | Solutions > Export (unmanaged and managed), plus cloning each agent | `pac solution export`, `unpack`, `pac copilot clone` |
| `cs_create_deployment_settings` | the connection and environment variable mapping step of the import wizard | `pac solution create-settings` |
| `cs_deploy_solution` | Solutions > Import in the target environment, then Publish on each agent | `pac solution import`, `pac copilot publish` |
| `cs_snapshot_environment`, `cs_compare_*` | no portal equivalent: a side-by-side of what each environment holds | `pac copilot clone` per agent plus Dataverse reads |

