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

## Verified offline (2026-09-05)

- `npm test`: 28 unit tests over dist/ (parsers, CSV, schema validation, every authoring tool on fixtures, solution inventory and settings).
- `pac copilot init` (default, minimal, cli-copilot) and `pac copilot pack` on the classic scaffold.
- `pac copilot pack` accepts settings + agent + topics only on an init workspace; every other folder
  is "Unsupported directory". Authoring tools report this via `layoutNote`.
- pac assemblies (`Microsoft.CopilotStudio.McsCore.dll`, `Microsoft.CopilotStudio.Sync.dll`) contain the
  sync layout names: `topics/`, `actions/`, `tools/`, `trigger/`, `knowledge/files`, `behaviors/`,
  `variables/`, `workflows`, `connectionreferences.mcs.yml`, `.mcs/conn.json`, `agent.sync.yaml`.
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
