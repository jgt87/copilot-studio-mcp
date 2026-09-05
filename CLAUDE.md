# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`copilot-studio-mcp` is a stdio MCP server for Microsoft Copilot Studio agent development. It wraps
the Power Platform CLI (`pac copilot`) for sync, writes the YAML workspace the Copilot Studio VS Code
extension uses, and calls Power Platform / Dataverse / BAP / DirectLine APIs for what the CLI does
not cover (evaluations, publish, chat). README.md has the tool table and the feasibility limits;
docs/flows.md has the diagrams; docs/STATUS.md tracks what is verified.

## Commands

```sh
npm run build                                   # tsc -> dist/ (ESM, NodeNext)
npm test                                        # build, then node --test test/*.test.js (offline, fixtures only)
node --test test/parsers.test.js                # one file (build first; tests import from dist/)
node --test --test-name-pattern "addTopic" test/authoring.test.js   # one test by name
node scripts/smoke.mjs [workspace]              # drive dist/index.js over stdio: initialize, tools/list, read-only calls
node scripts/oracle-pack.mjs [scratchDir]       # pac copilot init + every authoring tool + pac copilot pack (needs pac)
```

Tests run against the compiled `dist/`, never `src/`, so rebuild before testing after any change.
There is no linter configured.

## Architecture

Three layers behind one tool list, all registered in `src/index.ts`:

- **Sync** (`src/pac.ts`): spawns `pac` with an argv array and no shell, strips ANSI, returns
  `{ok, code, stdout, stderr}`; `explainFailure` maps known pac errors to hints. Parsers for
  `pac auth list` and `pac copilot list` anchor on regexes (bracketed index, GUID columns), not
  column offsets. `dotnetRootDefault()` sets `DOTNET_ROOT` to `~/.dotnet` when the SDK lives there.
- **Authoring** (`src/workspace.ts`, `src/schema.ts`, `src/authoring/*`): pure file operations.
  `workspace.ts` finds the root (marker files `agent.mcs.yml` / `settings.mcs.yml` /
  `agent.sync.yaml`, start dir, single child, or ancestor), reads sync metadata from `.mcs/conn.json`
  (VS Code extension) or `agent.sync.yaml` (pac), and inventories components. `schema.ts` loads
  `reference/bot.schema.yaml-authoring.json` (744 definitions) lazily, maps `kind` constants to
  definitions, and runs the structural validator. Each `authoring/*.ts` module builds one component
  kind from a small declarative spec and writes it through `util.writeComponentFile` (refuses to
  overwrite unless asked).
- **Cloud** (`src/auth.ts`, `src/cloud/*`): MSAL public client (first-party VS Code client id by
  default, `CPS_CLIENT_ID` overrides); every HTTP client takes an injectable `fetchImpl` so it can
  be tested with recorded responses. All permissions are delegated (no client-credential flow);
  the README section "Authentication and app registration" is the source of truth for which API
  and permission each tool needs. Keep it in sync when adding a cloud call. `ppapi.ts` is the evaluation API (list/run/get only; no
  create), `dataverse.ts` lists bots and publishes via the `PvaPublish` bound action polled on
  `publishedon`, `bap.ts` resolves environments, `chat.ts` speaks DirectLine v3 or the Copilot
  Studio client SDK.

- **Solutions** (`src/solutions.ts`): the ALM path for "pull everything" and "redeploy 1:1":
  `pac solution list/export/unpack/pack/create-settings/import` wrappers, an inventory parser over an
  unpacked folder (`bots/`, `botcomponents/` with the `data` YAML `kind`, `<Workflow>` and
  `<connectionreference>` entries in `Other/Customizations.xml`, `environmentvariabledefinitions/`),
  and the deployment settings file. `cs_pull_solution` writes `solution.json` (a `PullManifest`) that
  `cs_deploy_solution` reads. Per-agent sync workspaces stay bound to their source environment; only
  solution import moves things between environments.

Cross-cutting behaviour in `src/index.ts`:

- **Confirm contract**: every tool that mutates a live environment (`cs_push`, `cs_publish`,
  `cs_import_solution`, `cs_run_evaluation`, bootstrap `cs_init_agent`, non-read-only `cs_pac`)
  returns `dryRun()` unless `confirm: true`. Keep new mutating tools on this pattern.
- **Context resolution** (`cloudContext`): explicit args, then workspace sync metadata, then
  `CPS_*` env vars, then a BAP lookup for the Dataverse URL. Tenant falls back to `organizations`.
- **Validation gate**: `cs_push` runs `validateWorkspaceFiles` (schema checks plus cross-file
  checks for connection references and topic redirects) and blocks on errors unless `force`.
- **Chat routing** (`runChat`): `transport: auto` reads the bot's `authenticationmode` from
  Dataverse; 1 or 3 goes to DirectLine (token endpoint derived from environment id + schema name,
  no app needed), 2 requires the caller's own app id and the `CopilotStudio.Copilots.Invoke` scope.
- **Device-code login** is non-blocking: `startDeviceCodeLogin` returns the code immediately and
  `getToken` awaits the pending promise later.

stdout is the MCP transport. All diagnostics go through `log()` to stderr.

## Conventions verified against pac 2.11.2

- Workspace files: `agent.mcs.yml`, `settings.mcs.yml`, `icon.png`, `topics/<PascalName>.mcs.yml`.
  The file stem becomes the component schema suffix (`<agentSchema>.topic.<Stem>`); the display
  name lives in `mcs.metadata.componentName`. Authoring tools write `<PascalName>.mcs.yml` for
  every component kind and reference topics as `<agentSchema>.topic.<Pascal>`.
- `pac copilot pack` on an init-only workspace accepts settings + agent + topics and rejects every
  other folder ("Unsupported directory"). `knowledge/files`, `actions/`, `tools/`, `trigger/`,
  `variables/`, `workflows/`, `behaviors/`, `connectionreferences.mcs.yml` are names found in pac's
  `Microsoft.CopilotStudio.Sync` / `McsCore` assemblies and the VS Code extension docs; they apply
  through `pac copilot push` from a sync-connected workspace. `layoutNote()` tells callers.
- cli-copilot (GitHub Copilot harness) workspaces are `agent.sync.yaml` + `settings.mcs.yml` with
  `configuration.authoringModel: CliCopilot`; instructions live in
  `configuration.agentSettings.instructions.segments`. Never change `authoringModel`,
  `recognizer.kind` or `template` (`cs_update_settings` refuses).
- `pac solution create-settings` (2.11.2) emits `EnvironmentVariables` (with DefaultValue, Name,
  TypeId, IsRequired), `ConnectionReferences`, and a `CopilotAgents` section with `AadGroupId` per
  agent. `readDeploymentSettings` keeps the raw object so a rewrite never drops fields.
- js-yaml 5 has no default export: `import * as yaml from "js-yaml"`.
- Heredocs in the Bash tool break on non-ASCII characters; keep sources ASCII or use the Write tool.

## Validation policy

`cs_validate` blocks `cs_push` on errors, so false positives cost more than misses. Unknown
properties at the document root are warnings (the published schema lags the product, for example
`displayName` on `GptComponentMetadata`); unknown properties inside dialog actions are errors.

## Fixtures and reference material

- `test/fixtures/pac-default` and `pac-clicopilot` were generated by `pac copilot init` and are the
  source of truth for layout; `basic-agent` and `agent-with-mcp-action` come from Microsoft's
  skills-for-copilot-studio evals (MIT), as do `reference/bot.schema.yaml-authoring.json` and
  `reference/templates`.
- `scripts/oracle-pack.mjs` is the acceptance check for anything that changes generated YAML.

## Live verification checklist (needs a Power Platform environment)

Nothing below the unit tests and the pack oracle has been run against a tenant.

1. `pac auth create --environment <id>` in a terminal; `cs_doctor` shows the profile.
2. `cs_init_agent` with `environment` + `confirm`; `cs_describe_workspace` reports `sync.source != none`.
3. `cs_add_topic` + `cs_add_knowledge_source` (public site) + `cs_update_agent`; `cs_validate`;
   `cs_push confirm`; the portal shows the topic and knowledge.
4. `cs_publish confirm`; `cs_chat` returns a grounded answer.
5. `cs_create_test_set_csv`; import in the portal; `cs_list_test_sets`; `cs_run_evaluation confirm
   wait`; `cs_get_evaluation_run` shows per-case results (check the metric `status` values against
   the buckets in `summarizeRun`).
6. Clone an agent with a portal-made connector tool and a flow; diff `actions/` and `workflows/`
   against `cs_add_tool` / `cs_add_flow` output; then drop the experimental flag on `cs_add_flow`.
7. Check whether the clone contains evaluation test sets as YAML (`TestCaseComponent`,
   `EvaluationSet`, `EvaluationData` exist in the schema); if yes, write them instead of a CSV.
8. `cs_pull_solution` on a solution with two agents, a flow and a connector tool; then
   `cs_list_connections` on a second environment, `cs_create_deployment_settings`,
   `cs_deploy_solution confirm`; confirm agents publish and tools show as connected. Check the
   `pac connection list` column layout against `parseConnectionList` (built from documentation,
   not a live run).
