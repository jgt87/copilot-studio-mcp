# CLAUDE.md

## What this is

`copilot-studio-mcp`: a stdio MCP server for Microsoft Copilot Studio agent development. Three
layers behind one tool list (see README for the tool table):

- **sync** (`src/pac.ts`): spawns the Power Platform CLI (`pac copilot ...`) with an argv array,
  no shell. Output parsing for `auth list` / `copilot list` lives there too.
- **authoring** (`src/authoring/*`, `src/workspace.ts`, `src/schema.ts`): writes and reads the
  YAML workspace. Pure file operations.
- **cloud** (`src/cloud/*`, `src/auth.ts`): Power Platform API (evaluations), Dataverse (agents,
  publish), BAP (environments), DirectLine + Copilot Studio client (chat). MSAL public client with
  the first-party VS Code client id by default.

`src/index.ts` registers the tools and holds the `confirm` contract: anything that mutates a live
environment returns a dry run unless `confirm: true`.

## Commands

```sh
npm run build                 # tsc -> dist/
npm test                      # build, then node --test test/*.test.js (offline)
node scripts/smoke.mjs        # stdio JSON-RPC smoke test against dist/
node scripts/oracle-pack.mjs  # pac copilot init + every authoring tool + pac copilot pack
```

Tests run against the compiled `dist/`, never the sources. stdout is the MCP transport: every
diagnostic goes through `log()` to stderr. Anything printed to stdout corrupts the protocol.

## Conventions learned from pac 2.11.2 (keep these)

- Workspace files: `agent.mcs.yml`, `settings.mcs.yml`, `icon.png`, `topics/<PascalName>.mcs.yml`.
  The file stem becomes the component schema suffix (`<agentSchema>.topic.<Stem>`); the display
  name lives in `mcs.metadata.componentName`. Authoring tools therefore write
  `<PascalName>.mcs.yml` and put the human name in `mcs.metadata`.
- `pac copilot pack` on an init-only workspace accepts settings + agent + topics and rejects every
  other folder ("Unsupported directory"). `knowledge/files`, `actions/`, `tools/`, `trigger/`,
  `variables/`, `workflows/`, `behaviors/`, `connectionreferences.mcs.yml` are names found in
  pac's Sync/McsCore assemblies and in the VS Code extension docs; they apply through
  `pac copilot push` from a sync-connected workspace. `layoutNote()` in `index.ts` tells callers.
- cli-copilot (GitHub Copilot harness) workspaces are `agent.sync.yaml` + `settings.mcs.yml` with
  `configuration.authoringModel: CliCopilot`; instructions live in
  `configuration.agentSettings.instructions.segments`.
- js-yaml 5 has no default export: `import * as yaml from "js-yaml"`.
- Heredocs in the Bash tool break on non-ASCII characters; keep source ASCII or use the Write tool.
- pac as a dotnet global tool needs `DOTNET_ROOT` when the SDK is in `~/.dotnet`; `runPac`
  defaults it (`dotnetRootDefault`).

## Validation policy

`cs_validate` blocks `cs_push` on errors, so false positives are worse than misses. Unknown
properties at the document root are warnings (the published schema lags the product, e.g.
`displayName` on `GptComponentMetadata`); unknown properties inside dialog actions are errors.

## Live verification checklist (needs a Power Platform environment)

Not yet run; everything below the unit tests and the pack oracle is unverified against a tenant.

1. `pac auth create --environment <id>` in a terminal; `cs_doctor` shows the profile.
2. `cs_init_agent` with `environment` + `confirm`; confirm `.mcs/` or sync metadata appears and
   `cs_describe_workspace` reports `sync.source != none`.
3. `cs_add_topic` + `cs_add_knowledge_source` (public site) + `cs_update_agent`; `cs_validate`;
   `cs_push confirm`; check the portal shows the topic and knowledge.
4. `cs_publish confirm`; `cs_chat` returns a grounded answer (DirectLine path; agent must have
   no-auth or manual auth, else pass `clientId` for the SDK path).
5. `cs_create_test_set_csv`; import in the portal; `cs_list_test_sets`; `cs_run_evaluation
   confirm wait`; `cs_get_evaluation_run` shows per-case results.
6. Clone an agent that has a portal-made connector tool and a flow; compare `actions/` and
   `workflows/` contents with what `cs_add_tool` / `cs_add_flow` generate; adjust and drop the
   experimental flag on `cs_add_flow`.
7. Check whether the clone contains evaluation test sets as YAML (`TestCaseComponent`,
   `EvaluationSet`, `EvaluationData` exist in the schema). If yes, add `cs_create_test_set` that
   writes them instead of a CSV.

## Layout

- `src/index.ts`: tool registration, confirm contract, cross-file validation, chat routing
- `src/pac.ts`: locate/run pac, parsers, failure explanations
- `src/workspace.ts`: find/read/describe a workspace (VS Code extension and pac layouts)
- `src/schema.ts`: schema lookup + structural validator
- `src/authoring/`: `topics`, `knowledge`, `tools`, `flows` (experimental), `triggers`,
  `variables`, `agent` (instructions/settings), `util`
- `src/cloud/`: `http` (injectable fetch), `bap`, `dataverse`, `ppapi`, `chat`
- `src/auth.ts`: MSAL (interactive, device code, persistent cache via msal-node-extensions)
- `src/evals.ts`: CSV builder, case suggestions, local conversation tests
- `reference/`: schema + templates (MIT, microsoft/skills-for-copilot-studio)
- `test/fixtures/`: `pac-default`, `pac-clicopilot` (from `pac copilot init`), `basic-agent`,
  `agent-with-mcp-action` (from Microsoft's plugin evals)
- `docs/STATUS.md`: build status and open questions
