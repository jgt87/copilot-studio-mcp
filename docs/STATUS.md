# Build status

Plan: `~/.claude/plans/twinkly-inventing-hopper.md` (approved 2026-09-05).

| Step | Status | Notes |
| --- | --- | --- |
| 1 Bootstrap (git, package, deps, pac install) | done | .NET 10 SDK user-scope in `~/.dotnet` (winget needed elevation and hung); pac 2.11.2 as dotnet global tool; `DOTNET_ROOT` user env var set; `runPac` defaults it |
| 2 Workspace oracle (`pac copilot init` / `pack`) | done | scaffolds committed as `test/fixtures/pac-default` and `pac-clicopilot`; `scripts/oracle-pack.mjs` re-runs init + authoring + pack |
| 3 Workspace + schema (`workspace.ts`, `schema.ts`) | done | validator ported from Microsoft's schema-lookup and extended; root unknown props are warnings, action-level are errors |
| 4 Sync layer (`pac.ts` + tools) | done (code) | init/clone/pull/push/pack/import/publish/status/list + `cs_pac`; only `init`, `pack`, `auth list` exercised (no environment) |
| 5 Authoring tools | done | topics, knowledge (3 kinds + files), tools (connector/mcp/flow), flows (experimental), triggers, variables, agent/settings edits; naming aligned to pac (`<PascalName>.mcs.yml`, `mcs.metadata`) |
| 6 Cloud: auth, environments, publish, chat | done (code) | MSAL device-code + interactive; BAP; Dataverse; DirectLine + SDK chat; untested live |
| 7 Evaluations | done (code) | PPAPI list/run/get/summarize; CSV builder; local conversation tests |
| 8 Packaging + registration | done | README, CLAUDE.md, `.vscode/mcp.json`; stdio smoke test; registered in Claude Code (user scope, connected) and in the `C:\Files\Apps` workspace `.vscode/mcp.json`; public repo https://github.com/jgt87/copilot-studio-mcp |
| 9 Solution ALM (added 2026-09-05 on request) | done (code) | `cs_list_solutions`, `cs_list_connections`, `cs_describe_solution`, `cs_pull_solution`, `cs_create_deployment_settings`, `cs_pack_solution`, `cs_deploy_solution`; inventory parser + settings file verified offline |
| 10 DTAP comparison (added 2026-09-05 on request) | done (code) | `cs_snapshot_environment`, `cs_compare_snapshots`, `cs_compare_environments`; comparison logic unit-tested on synthetic snapshots; capture path (clone per agent, Dataverse reads) untested live |
| 12 Getting started (added 2026-09-05 on request) | done (code) | `cs_create_solution`, `cs_init_agent solutionName/createSolution` (init, pack, import, clone), `cs_generate_instructions` via `pac copilot model predict`; empty-solution manifest packs offline; import/clone/predict unverified live |
| 13 Day-two authoring + review (added 2026-09-06 on request) | done (code) | `cs_edit_topic`, `cs_edit_tool`, `cs_edit_knowledge`, `cs_remove_component`, `cs_delete_agent`, `cs_delete_solution`, `cs_review_agent`; new topic nodes: adaptive card (display and input), transfer, end conversation, scoped generative answers; node shapes from the schema, unverified live |
| 14 Portal drift (added 2026-09-06 on request) | done (code) | `cs_check_drift` quick (Dataverse component stamps) and full (temporary clone, three-way file diff); sync stamp `.mcs/cs-sync.json` written by clone / pull / push / init; drift preflight in `cs_push`; stamp placement verified with `pac copilot pack`; `botcomponent` query and formatted-value annotations unverified live |
| 15 Remaining pac commands (added 2026-09-07 on request) | done (code) | 29 declarative wrappers in `pacCommands.ts` (copilot create / extract-template / translations / quarantine, solution project + checker + versioning + upgrade + publish + add-component, pipeline list / deploy, service-principal connections, auth profiles, env list / who / fetch / select) plus `CPS_TOOLS` filter; flags read from pac 2.11.2 help, no command exercised live |
| 16 In-product guidance (added 2026-09-07 on request) | done | `cs_guide` with 10 walkthroughs, handshake instructions, 6 MCP prompts, next steps in `cs_doctor` / `cs_describe_workspace`; guides are checked against the registered tool names by `test/guide.test.js` |
| 17 Write policy (added 2026-09-07 on request) | done | `CPS_READ_ONLY` hides every environment-changing tool; `cs_pac` refuses non-read-only commands; `cs_doctor` reports the policy; `test/policy.test.js` keeps the list in step with the tools that declare `confirm` |
| 18 Cloud flows (added 2026-09-07 on request) | done (code) | `cs_list_flows`, `cs_get_flow`, `cs_set_flow_state`, `cs_update_flow` over Dataverse `workflow` rows (category 5); state pairs statecode 1/statuscode 2 and 0/1 from the documented option sets, definition swapped inside `clientdata`; unit-tested against recorded responses, never run against a tenant |
| 19 Flow creation and runs (added 2026-09-07 on request) | done (code) | `cs_create_flow` (workflow row: category 5, type 1, primaryentity none, `MSCRM.SolutionUniqueName` header, created switched off) and `cs_list_flow_runs` / `cs_get_flow_run` / `cs_run_flow` over the Power Automate Process Simple API (`api.flow.microsoft.com`, api-version 2016-11-01, Flow service scope). Both the create body and the run API are unit-tested against recorded shapes only; the run endpoints and their scope come from the service the portal calls, not from documented API reference |
| 11 Tool catalog (added 2026-09-05 on request) | done (code) | `cs_list_connectors`, `cs_describe_connector`, `cs_list_prompts`; `cs_add_tool` covers all 10 schema TaskAction kinds (6 typed, 4 raw) with catalog-backed operation checks and input filling; offline seed of public connectors; registry endpoint (`api.powerapps.com` apis + `$expand=swagger`) unverified live |

## Verified offline (2026-09-05)

- `npm test`: 63 unit tests over dist/ (parsers, CSV, schema validation, every authoring tool on fixtures, solution inventory and settings, comparison, catalog, bootstrap, validation, day-two edits and review, drift).
- `pac copilot init` (default, minimal, cli-copilot) and `pac copilot pack` on the classic scaffold.
- `pac copilot pack` accepts settings + agent + topics only on an init workspace; every other folder
  is "Unsupported directory". Authoring tools report this via `layoutNote`.
- pac assemblies (`Microsoft.CopilotStudio.McsCore.dll`, `Microsoft.CopilotStudio.Sync.dll`) contain the
  sync layout names: `topics/`, `actions/`, `tools/`, `trigger/`, `knowledge/files`, `behaviors/`,
  `variables/`, `workflows`, `connectionreferences.mcs.yml`, `.mcs/conn.json`, `agent.sync.yaml`.
- `pac copilot pack` accepts extra files inside `.mcs/` and rejects a dotfile at the workspace root
  (`Unsupported file: .cs-sync.json`), 2026-09-06.
- `pac solution unpack` of the packed oracle solution (fixture `test/fixtures/unpacked-solution`, with
  synthetic flow, connection reference, environment variable and connector entries), `pac solution pack`
  of that fixture, and `pac solution create-settings` on the result (shape includes `CopilotAgents.AadGroupId`).

## Open questions to verify against a real environment

- Whether `pac copilot push` from a cloned workspace accepts the generated `knowledge/`, `actions/`,
  `trigger/`, `variables/` and `workflows/` files as written.
- Whether `pac copilot clone` projects evaluation test sets as YAML (`TestCaseComponent` / `EvaluationSet`
  exist in the schema). If so, `cs_create_test_set` can write them instead of a CSV.
- Exact `workflows/<name>/` format after a real clone.
- Evaluation API response field names for the summary buckets.
- `pac connection list` column layout (parser anchors on the GUID and connector name only).
- Whether `pac solution import` proceeds with the all-zero `AadGroupId` placeholder (treated as informational, not blocking).
- Whether `createFlow` needs more than category 5 / type 1 / primaryentity "none" (an `ownerid` or a
  `workflowidunique`, for instance) and whether the Power Automate run endpoints and the
  `service.flow.microsoft.com` scope work with the first-party client id.
- Which component query an environment accepts (`bots({id})/bot_botcomponent` navigation or the
  `_parentbotid_value` filter), whether `schemaname` follows `<agent>.<kind>.<Stem>` for every
  component kind (the drift-to-file mapping relies on it), and whether `pac copilot push` refuses
  when the server changed since the last pull.
