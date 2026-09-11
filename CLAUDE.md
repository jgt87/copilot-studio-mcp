# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`copilot-studio-mcp` is a stdio MCP server for Microsoft Copilot Studio agent development. It wraps
the Power Platform CLI (`pac copilot`) for sync, writes the YAML workspace the Copilot Studio VS Code
extension uses, and calls Power Platform / Dataverse / BAP / DirectLine APIs for what the CLI does
not cover (evaluations, publish, chat). README.md describes the workflows and the feasibility limits, docs/tools.md has the tool table;
docs/flows.md has the diagrams; docs/STATUS.md tracks what is verified.

## Commands

```sh
npm run build                                   # tsc -> dist/ (ESM, NodeNext)
npm test                                        # build, then node --test test/*.test.js (offline, fixtures only)
node --test test/parsers.test.js                # one file (build first; tests import from dist/)
node --test --test-name-pattern "addTopic" test/authoring.test.js   # one test by name
node scripts/smoke.mjs [workspace]              # drive dist/index.js over stdio: initialize, tools/list, read-only calls
CPS_READ_ONLY=1 node scripts/smoke.mjs          # same, asserting the environment-changing tools are withheld
node scripts/oracle-pack.mjs [scratchDir]       # pac copilot init + every authoring tool + pac copilot pack (needs pac)
node scripts/routing-eval.mjs --dry-run         # free: does the tool list route natural language correctly?
node scripts/routing-eval.mjs --probe --yes     # just the confusable pairs; --yes because a run spends money
```

Tests run against the compiled `dist/`, never `src/`, so rebuild before testing after any change.
There is no linter configured.

## Architecture

Three layers behind one tool list, all registered in `src/index.ts`:

- **Sync** (`src/pacRun.ts`, `src/pac.ts`): `pacRun.ts` is the account-independent layer - it finds
  pac, spawns it with an argv array and no shell, strips ANSI, returns `{ok, code, stdout, stderr}`,
  terminates the process tree on a timeout, and parses `pac auth list` (the coordinator needs the
  profile list to choose a profile, so reading it must not itself require one).
  `dotnetRootDefault()` sets `DOTNET_ROOT` to `~/.dotnet` when the SDK lives there. `src/pac.ts` is
  the facade every other module imports: it re-exports all of `pacRun.ts`, adds the account-aware
  `runPac`, and holds `explainFailure` and the `pac copilot list` parser. Both parsers anchor on
  regexes (bracketed index, GUID columns), not column offsets. `pacRun.ts` must not import `pac.ts`
  or `pacProfile.ts`; that direction is the import cycle the split removed.
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
  be tested with recorded responses. `http.requestJson` retries only what is safe to repeat: a GET,
  or a non-GET that passes `idempotent: true`, and only on a transport failure or 408/429/500/502/
  503/504. A write is never retried, because a publish or an import that timed out may already have
  been applied. Backoff is exponential with jitter, honours `Retry-After` up to a 5s cap (the client
  cuts the call off at ~60s), and takes an injectable `sleep`. All permissions are delegated (no
  client-credential flow);
  the README section "Authentication and app registration" is the source of truth for which API
  and permission each tool needs. Keep it in sync when adding a cloud call. `ppapi.ts` is the evaluation API (list/run/get only; no
  create), `dataverse.ts` lists bots and publishes via the `PvaPublish` bound action polled on
  `publishedon`, and reads and writes cloud flows on the `workflow` table (category 5): `getFlow`
  parses `clientdata`, `setFlowState` PATCHes the documented statecode/statuscode pairs, and
  `updateFlow` swaps `properties.definition` inside the existing `clientdata` so connection
  references survive, `bap.ts` resolves environments, `chat.ts` speaks DirectLine v3 or the Copilot
  Studio client SDK, `flowruns.ts` is the Power Automate Process Simple API (run history and
  starting a run; its own scope, `CPS_FLOW_SCOPE` overrides, unverified live).

- **Solutions** (`src/solutions.ts`): the ALM path for "pull everything" and "redeploy 1:1":
  `pac solution list/export/unpack/pack/create-settings/import` wrappers, an inventory parser over an
  unpacked folder (`bots/`, `botcomponents/` with the `data` YAML `kind`, `<Workflow>` and
  `<connectionreference>` entries in `Other/Customizations.xml`, `environmentvariabledefinitions/`),
  and the deployment settings file. `cs_pull_solution` writes `solution.json` (a `PullManifest`) that
  `cs_deploy_solution` reads. Per-agent sync workspaces stay bound to their source environment; only
  solution import moves things between environments.

- **Flow builder** (`src/authoring/flowBuilder.ts`): `buildFlow` turns a step spec into a Logic
  Apps definition: triggers (agent/manual/http/recurrence/connector/raw), steps chained through
  `runAfter`, nested `condition`/`foreach`/`scope`, and one connection reference per connector
  collected by `ConnectionCollector`. `cs_build_flow_definition`, `cs_create_flow` and
  `cs_update_flow` all take the same spec. It emits the top-level `$connections` and
  `$authentication` parameters every connector flow needs; without them the service answers 400 and
  blames the trigger. Shapes come from the Logic Apps schema and exported
  solutions, never a live import, so keep the "unverified" note until one round-trips.

- **Flow diagnostics** (`src/flowDiagnostics.ts`): why a run failed, read-only, over the same
  Process Simple client. Three things it exists for: a failed *connector* action carries no `error`
  property, so `explainRun` follows the action's `outputsLink` SAS URI and digs the message out with
  `errorFromOutputs` (the connector shapes are tried in order and none is guaranteed); a failure is
  usually about what an earlier action produced, so each one is paired with the outputs of the
  successes before it; and `compareRuns` diffs a failure against the most recent success to separate
  a data problem from a logic one. `analyzeFlowHealth` attributes sampled failures to actions.
  `flowruns.ts` gained `listRunActions` and `readContentLink` for this. `readContentLink` sends no
  Authorization header: the URI is already SAS-signed and Azure Blob answers 400 when both are
  present. Content links expire after a few days, which is a note in the result, never an error.
  The pure helpers (`errorFromOutputs`, `classifyFailure`, `divergence`, `durationStats`,
  `healthVerdict`, `comparisonVerdict`) are what `test/flow-diagnostics.test.js` pins; the verdict
  strings are user-facing advice, so change them and the test together.
- **Connections** (`src/cloud/connections.ts`): the Power Apps connections API
  (`api.powerapps.com`, BAP scope, same as the connector registry in `catalog.ts`). A connection is
  one person's authorised instance of a connector; `isUsable` is the difference between a connection
  that can be bound and one whose owner has to sign in again. The per-connector route is the
  reliable one. `cs_list_connections` still goes through `pac connection list`; this exists because
  binding needs the connector id as the service spells it.
- **Connection binding** (`cs_bind_flow_connection`, helpers in `dataverseFlows.ts`): a flow names
  its connections in one of two shapes and the shape decides where the binding is written.
  `invoker` (the flow carries `connectionName` itself) is an edit to the flow's `clientdata`;
  `solution` (the flow points at a `connectionreference` logical name) is a PATCH of that row's
  `connectionid`, and the flow is not touched. `connectionReferenceShape` decides, and getting it
  wrong writes a binding nothing reads. `connectionid` on the row holds the connection's short
  name, not its resource id. This is the same write a deployment settings file performs at import
  time, done after the fact for a flow that arrived unbound.
- **Day-two authoring** (`src/authoring/edit.ts`): find a component by name, stem or path; edit
  topics (phrases, priority, nodes by position or id), tools (descriptions, inputs, connection),
  knowledge (site, trigger condition); remove components with connection-reference pruning and
  dangling-redirect notes. Headers are preserved through `loadWithHeader` / `saveWithHeader` in
  `authoring/util.ts`.
- **Review** (`src/review.ts`): rules-based `reviewWorkspace` with a 10-point score; each finding
  names a rule and a fix. Add rules as functions in the `rules` array; keep them conservative.
- **Attribution** (`src/attribution.ts`): which topic, tool and knowledge source an activity is
  attributed to, read from `channelData`. One module because the same activities arrive two ways -
  live from DirectLine (`cs_chat`) and stored in Dataverse (`conversationtranscripts`) - and both
  readers must agree. The key names are from documentation, not a live capture, so every accessor
  takes each casing and nesting the docs show; `docs/test-verification.md` phase 1 is what settles
  them, and `test/attribution.test.js` is the written record of which shapes are claimed. Add a key
  to both together. `evals.Expectation` builds `usedTool` / `notUsedTool` / `usedTopic` /
  `notUsedTopic` / `citedKnowledge` on it, so a conversation test can tell a real tool call from an
  answer that merely reads correctly. An expectation that cannot be judged says so rather than
  failing the agent.
- **Comparison** (`src/compare.ts`): DTAP snapshots and diffs. A snapshot is `snapshot.json` plus
  `agents/<Agent>/` clones; `compareSnapshots` normalises YAML (drops `DEFAULT_IGNORED_KEYS`, skips
  `.mcs/`, icons, sync markers), diffs with the `diff` package, and separates drift from expected
  per-stage differences (connection bindings, variable values, managed flag). Dataverse reads for
  flows / connection references / variables / publish state are optional and use a silent token only.

- **Drift** (`src/drift.ts`): portal changes since the last sync. `writeStamp` records
  `.mcs/cs-sync.json` (file fingerprints from `compare.workspaceFingerprints` plus the Dataverse
  component stamps when a silent token exists) after clone / pull / push / init; `quickDrift`
  compares `listBotComponents` rows with the stamp and maps them to files through
  `componentFileFor` (`<agent>.<kind>.<Stem>`); `compareWithClone` / `fullDrift` classify files
  three ways (`classifyFiles`). `cs_push` runs the quick check in its dry run and blocks on
  conflicts unless `force`. Dataverse access for all of this goes through `silentDataverse` in
  index.ts and must stay non-interactive.

- **pac wrappers** (`src/pacSpecs/*.ts`, one file per pac command group): every pac command without
  a bespoke tool is one entry in that group's `SPECS`, assembled into `PAC_COMMANDS` by
  `src/pacCommands.ts` (which also holds the builders; `src/pacParams.ts` holds the spec types and
  the shared parameter fragments, so the group files never import the assembled table). An entry is (tool name, `pac` argv, typed params with flags, `mutating` as a boolean or a
  per-input function, secrets). index.ts registers them in one loop: `zodShapeFor` builds the
  schema, `buildPacArgs` the argv, secrets are masked in logs (`runPac` `redact`), dry runs and
  results. Add a command by adding a spec and a `buildPacArgs` assertion in
  `test/pac-commands.test.js`; flags come from `pac <group> <command> help`. Groups outside Copilot
  Studio work are deliberately left to `cs_pac`.
- **Routing** (`scripts/routing-eval.mjs`, `reference/routing-cases.json`): every other check here is
  structural - the tool exists, it declares `confirm`, the preset count is honest. None of them catch a
  user saying "why did my flow fail" and the model calling `cs_get_flow_run`, which answers a different
  question. The eval puts the tool list in front of a model exactly as a client sees it, one utterance at
  a time, and scores the first tool it names: a hit, `acceptable` (a listed reasonable first step, usually
  the listing tool that finds an id), or a misroute. Misroutes are grouped by `expected -> chosen`,
  because that pair names the description that fails to say *when* to reach for the tool. Cases carrying
  `probe` exist to separate a specific confusable pair; keep them when editing descriptions, since they
  are what proves the edit worked. Two backends: the Messages API (the measurement - the tool list is a
  cached prefix, so a run costs cents) and the `claude` CLI (needs no API key, but Claude Code's own
  prompt shares the context, so it approximates). Not in `npm test`: it needs a model and a network and
  it spends money, so nothing runs without `--yes`.
- **Routing variance**: a single run proves nothing. Measured on Haiku 4.5 over three runs of an
  identical build, the exact score moved 46-48 of 62 by itself and twenty of the sixty-two cases
  answered differently between runs. So: quote the mean of `--repeat 3`, never one run; treat a
  difference of two cases or fewer as noise; and act only on what the report calls "always
  misrouted", because a case that flaps tells you nothing about the edit you just made. Two claims
  in this repo were made from single runs and were wrong - an 81% score that was really 76%, and a
  fix to `cs_publish` that had not worked at all.
- **Guidance** (`src/guide.ts`): `SERVER_INSTRUCTIONS` goes out in the MCP handshake,
  `GUIDES` backs the `cs_guide` tool and the six MCP prompts, and `nextSteps(ws)` is appended to
  `cs_init` and `cs_describe_workspace`. `test/guide.test.js` fails when a guide names a tool
  the server does not register, so update the guides together with the tool list.
- **Two accounts** (`src/pacProfile.ts`): pac's active auth profile is machine-wide state.
  `withPacProfile` selects a profile, runs the work and restores the previous one, serialised
  through a process-local promise queue, including calls without a named profile. `runPac`
  applies `CPS_ADMIN_PROFILE` for admin commands and `CPS_PAC_PROFILE` for maker commands;
  auth/session inspection uses the current profile. Declarative wrappers and `cs_pac` also
  accept an explicit `profile`. Bootstrap, solution pull/deploy and snapshots hold the lock
  across their PAC steps. Nested calls reuse the async context; only coordinator internals
  may call `runPacRaw`. External PAC processes are outside this lock.
- **Tenant backup** (`src/tenantBackup.ts`): `backupTenant` runs a fixed list of read-only pac
  commands into a folder, storing raw stdout plus parsed rows where a parser exists
  (`parseSolutionList`, `parseCopilotList`, `parseConnectionList`), and per environment optionally
  the Dataverse reads. The pac runner is injectable, so `test/tenant.test.js` drives the whole
  backup with a fake pac and asserts the files, the parsing and the isolation of a failed capture.
- **Question-shaped results** (`src/needs.ts`): `needsInput(tool, needs)` returns a non-error result
  describing what is missing, with `choices` when the server can enumerate them and `moreWith`
  naming the listing tool; `rankChoices` orders candidates (exact, prefix, substring, all words) and
  callers fall back to the full list when nothing matches. Used by `cs_add_tool`,
  `cs_add_knowledge_source` and `cs_clone_agent`; prefer it over `fail()` whenever the fix is a
  decision the user has to make.
- **Tool filter** (`src/toolFilter.ts`): `CPS_TOOLS` / `CPS_TOOLS_EXCLUDE` glob lists applied by a
  wrapper around `server.registerTool`; hidden tools are logged at startup. `TOOL_PRESETS` gives
  named subsets (`core`, `authoring`, `admin`, `solutions`, `full`) that `expandPresets` resolves
  before the globs, because the full list is ~50k tokens of schema and a smaller model chooses badly
  from 137 tools. The default (no `CPS_TOOLS`) still registers everything; keep it that way. When
  adding a tool to the core workflow, add it to the `core` preset too, and keep `cs_pac` in every
  preset that hides pac wrappers. `cs_set_tool_preset` switches presets during a session through the
  SDK handles kept by the registration wrapper (`applyToolPreset` in `tools/shared.ts`); the SDK
  sends `tools/list_changed` itself. `presetOptions` builds the menu `cs_init` shows, and a test
  asserts each advertised count equals what the preset admits, so the session controls must be
  members of every preset rather than only force-kept.

- **Catalog** (`src/catalog.ts`): connector registry and OpenAPI definitions from `api.powerapps.com`
  (PowerApps Service token), cached under `.cs-catalog/<environment>/`; `parseSwaggerOperations`
  flattens body schemas into parameters and detects MCP endpoints by `x-ms-agentic-protocol`;
  `reference/connectors-seed.json` is the offline name-to-id seed (regenerate from the public
  connector reference page when stale). `TOOL_KIND_SUPPORT` in `authoring/tools.ts` classifies every
  schema `TaskAction` kind; `test/catalog.test.js` fails when the schema and that table diverge.

- **Bootstrap** (`src/bootstrap.ts`): create a solution (empty manifest packed with `pac solution
  pack`, then imported), create an agent inside a chosen solution (init locally, pack with
  `--solution-name`, import, clone by schema name, swap the clone in for the scaffold), and generate
  instructions through `pac copilot model predict` (AI Builder). `cleanPredictOutput` strips pac's
  banner; the exact predict output format is unverified live.

Cross-cutting behaviour in `src/index.ts`:

- **Write policy** (`src/policy.ts`): `ENVIRONMENT_WRITE_TOOLS` is the single list of tools that
  can change an environment (bespoke names plus every `PAC_COMMANDS` spec whose `mutating` is not
  `false`). `CPS_READ_ONLY` makes the registration wrapper in index.ts skip them entirely;
  `cs_pac` stays registered and refuses non-read-only commands itself. `test/policy.test.js`
  cross-checks the list against the tools that declare `confirm` in `dist/index.js`, so adding a
  mutating tool without listing it fails the build.
- **Confirm contract**: every tool that mutates a live environment (`cs_push`, `cs_publish`,
  `cs_import_solution`, `cs_run_evaluation`, bootstrap `cs_create_agent`, non-read-only `cs_pac`)
  returns `dryRun()` unless `confirm: true`. Keep new mutating tools on this pattern.
- **Context resolution** (`cloudContext`): explicit args, then workspace sync metadata, then
  `CPS_*` env vars, then a BAP lookup for the Dataverse URL. Tenant falls back to `organizations`.
- **Validation gate**: `cs_push` runs `validateWorkspace` from `src/validate.ts` (schema checks
  plus cross-file checks for connection references, catalog operations and topic redirects) and
  blocks on errors unless `force`. index.ts is the registration hub only: handlers resolve context,
  call a module function and shape the result; put logic in modules with unit tests, not in handlers.
- **Chat routing** (`runChat`): `transport: auto` reads the bot's `authenticationmode` from
  Dataverse; 1 or 3 goes to DirectLine (token endpoint derived from environment id + schema name,
  no app needed), 2 requires the caller's own app id and the `CopilotStudio.Copilots.Invoke` scope.
- **Logins are non-blocking**: `startDeviceCodeLogin` returns the code and `startInteractiveLogin`
  returns the authorize URL as soon as MSAL has it; both register one pending login that
  `waitForPendingLogin`, `getToken` and `cs_login_status` pick up later. `cs_login` waits at most
  `waitSeconds` (default 15) and otherwise returns `status: pending` with the URL, because MCP
  clients cap tool-call duration and cannot always open a browser from the server.

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
- `pac copilot pack` (2.11.2) tolerates extra files inside `.mcs/` but rejects unknown files at the
  workspace root (`Unsupported file: .cs-sync.json`); that is why the sync stamp lives in
  `.mcs/cs-sync.json`.
- js-yaml 5 has no default export: `import * as yaml from "js-yaml"`.
- Never open a URL with `cmd /c start <url>`: cmd splits the command at every `&`, so the browser
  receives the authorize request without `scope` (AADSTS900144). `auth.browserLaunchSpec` uses
  PowerShell `Start-Process` with an encoded command on Windows; reuse it for any future launch.
- Never spawn a Windows `.cmd` shim with `shell: true`: node concatenates argv without escaping, so
  `--project-dir "C: b\ws"` arrives as three arguments with the backslashes eaten, and everything
  after an `&` is dropped because cmd reads it as a command separator. `pac.spawnSpec` builds the
  command line and hands it to `cmd /d /s /c` verbatim instead. Found live on 2026-09-09; latent
  wherever pac resolves to `pac.exe`.
- pac can report failure and still exit 0 (`pac copilot publish` prints "Failed to publish"), so a
  `runPacRaw` applies the publish-failure pattern to every `copilot publish` call, including
  deployment. Other commands can opt into `PacRunOptions.failOnOutput`; never match "failed"
  globally, because unrelated log lines can contain it.
- Fire-and-forget processes go through `auth.launchDetached`: a child process emits `error`
  asynchronously (ENOENT when the command is missing) and an unlistened `error` event kills the
  server, which clients report only as a broken pipe. index.ts also logs `uncaughtException` /
  `unhandledRejection` instead of exiting.
- Heredocs in the Bash tool break on non-ASCII characters; keep sources ASCII or use the Write tool.
- `repowise update` rewrites the `repowise` entry in `.vscode/mcp.json` with an absolute path. The
  committed form uses `${workspaceFolder}`; restore it before committing (`git diff .vscode/mcp.json`).
- Mermaid on GitHub: no edges to subgraph ids, no `<-->`, no cylinder `[( )]` shapes, no labelled
  self-loops; the "How it fits together" diagram failed to render with those.

- `cs_update_agent` writes the whole agent definition, not only instructions: `responseInstructions`,
  `defaultResponseMode`, `historyType`, `gptCapabilities` (merged, not replaced) and the
  `aISettings` block (model knowledge, content moderation, file analysis, semantic search). Enum
  values are checked in `authoring/agent.ts` against the schema's `DefaultResponseMode` and
  `ContentModerationLevel`. The README table "Agent settings this server can write" is the
  user-facing map; keep it in step when adding a field.

## Releasing

Version, tag, GitHub release and npm are one step, not four. A bump that stops at
`package.json` leaves the release page describing an older build, which is how `v0.1.2`
came to be tagged with nothing behind it.

```sh
npm version 0.1.4 --no-git-tag-version   # package.json + package-lock.json together; then server.json by hand (twice)
npm run build                            # VERSION is read from package.json, so rebuild
npm test && node scripts/smoke.mjs       # prepublishOnly runs the tests again; fail here, not at the registry
git commit -m "0.1.4"                    # bare version number: matches v0.1.0 .. v0.1.3
git tag -a v0.1.4 -m "v0.1.4"
git push origin main --follow-tags
gh release create v0.1.4 --title "v0.1.4 - <one word>" --notes-file <file>
npm publish                              # needs npm login; the registry is the only place users get it
mcp-publisher validate                   # server.json against the schema (binary: github.com/modelcontextprotocol/registry releases)
mcp-publisher publish                    # MCP Registry entry io.github.jgt87/copilot-studio-mcp; after npm publish, needs `mcp-publisher login github` once
```

- `src/tools/shared.ts` reads `VERSION` from `package.json`, so never write a version anywhere
  else. `docs/CODE_REVIEW.md` names 0.1.1 on purpose: it is a dated record, not a live reference.
- Write the notes from `git log <previous tag>..<tag>`. House style, set by `v0.1.1`: a lede
  saying what kind of release it is and who should upgrade, then `## Fixed` / `## Added` /
  `## Changed` with each bullet leading on the user-visible symptom in bold rather than the
  commit subject, and a closing line with the test count and what was *not* verified live.
- npm serves the readme from the published tarball, so a README change reaches the package page
  only through a release. That is the whole reason `v0.1.1` exists.
- `npm publish` failing with `E404` on the PUT means the credentials expired, not that the name
  is taken. `npm whoami` returns 401 in that state; `npm login` fixes it. A failed publish
  consumes nothing, so retry the same version rather than bumping again.
- `server.json` names the version twice (server and package entry) and `test/registry.test.js`
  fails when either differs from `package.json`. The MCP Registry checks `mcpName` in the npm
  tarball, so `npm publish` must precede `mcp-publisher publish`. The registry entry is what
  the GitHub MCP Registry and VS Code's MCP gallery pick up.

## Keeping the docs in step

Several files describe the code and go stale silently. When a change touches one of these,
update it in the same commit:

- **Tool list**: `test/guide.test.js` fails when a guide in `src/guide.ts` names a tool the server
  does not register, and `test/presets.test.js` checks each preset's advertised count. The
  tool tables in `docs/tools.md` and the preset counts in the README ("Running on a smaller model")
  have no test - check them by hand (`CPS_TOOLS=<preset> node scripts/smoke.mjs` prints the count).
- **Agent settings**: the README table "Agent settings this server can write" is the user-facing
  map of what `cs_update_agent` writes.
- **Registry**: `server.json` mirrors `package.json` (`test/registry.test.js` guards it).
- **Docs ship in the tarball**: `docs/` is in the package `files`, and the README links to
  `docs/tools.md` and `docs/flows.md` through `cdn.jsdelivr.net/npm/copilot-studio-mcp/...`, which
  mirrors npm, so the package page does not depend on the GitHub repo being public. A docs change
  reaches readers of the package page only through a release, like the README.
- **Permissions**: the README section "Authentication and app registration" is the source of truth
  for which API and permission each cloud tool needs.
- **Architecture**: the module bullets above. A new module, a moved symbol or a changed
  cross-cutting rule (the write policy, the confirm contract, the retry policy) belongs here.
- **Status**: `docs/STATUS.md` is a historical build log and `docs/verify.md` the live follow-up
  list; later dated entries supersede earlier "untested" notes rather than replacing them in place.
- **Decisions**: a churn hotspot with no governing decision is a finding in its own right. Record
  the reasoning with `repowise decision add` rather than in a comment, and confirm it - a
  `proposed` decision does not count as governing. `get_why` before diverging from one.
- **After `repowise update`**: it rewrites `.vscode/mcp.json`, swapping `${workspaceFolder}` for an
  absolute path and re-adding a `description` key VS Code's schema rejects. `git checkout
  .vscode/mcp.json` before staging anything.

## Writing a tool description

The description is the only thing a client's model reads when it decides which of 142 tools to
call, so it is routing code, not documentation. `scripts/routing-eval.mjs` measures it; these
rules came out of what that eval actually caught, and each one is worth a re-measure before it is
changed.

- **Lead with the job, not the mechanism.** "Answer 'which flows are there?'" routes; "Cloud flows
  in the environment with their state, owner and last change" does not, because nothing in it
  matches what a user says.
- **Never put a funnel instruction in a description.** `cs_init` opened with "Run this first in a
  new session" and became the answer to eleven unrelated questions, because every session is a new
  one; `cs_guide` said "read this before planning a sequence of calls" and absorbed requests to
  build things; `cs_validate` said "run before cs_push" and won "send my changes up". The funnel
  belongs in `SERVER_INSTRUCTIONS`, where it is read once, not in a tool that then competes for
  every utterance. Bound it instead: say what the tool does *not* answer and name the tool that does.
- **A cross-reference must name the other tool without restating its trigger.** This is the one
  that bites twice: a clause added to `cs_push` reading "making those changes visible to real users
  afterwards is cs_publish" made `cs_push` win "make my changes live", and "when it last ran
  (cs_list_flow_runs)" inside `cs_list_flows` made it win "show me the last ten runs". The words
  that pull traffic to a tool pull it just as hard from inside a neighbour's description. Write
  "cs_publish is the separate step afterwards", not "cs_publish makes it visible to real users".
- **The echo rule bites more than once.** After the cross-reference fix, `cs_push` still won "make
  my changes live", because its own first sentence said "up to the **live** agent" and its last said
  "Mutates the **live** agent". A neighbour's trigger word anywhere in a description is enough; it
  does not have to be in the clause that mentions the neighbour. Grep a description for the trigger
  words of the tools it sits next to before calling an edit done.
- **Keep the confirm sentence.** `test/policy.test.js` checks that every environment-write tool
  says `confirm: true` in its description.

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

Phases A to F were exercised against a tenant on 2026-09-08. `docs/verify.md` is the current
follow-up list; the checklist below describes the original acceptance workflow.
`docs/test-verification.md` is the runbook for the feedback loop (static checks, behavioural tests,
transcripts, closing the loop); its phase 1 settles whether live DirectLine activities carry the
topic/tool/citation attribution that `src/attribution.ts` assumes, which nothing has yet confirmed. The code-review
fixes recorded in `docs/CODE_REVIEW.md` were verified offline, not through new live writes.

1. `pac auth create --environment <id>` in a terminal; `cs_init` shows the profile.
2. `cs_create_agent` with `environment` + `confirm`; `cs_describe_workspace` reports `sync.source != none`.
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
9. Edit a topic in the portal, then `cs_check_drift` (quick and full): confirm that
   `bots({id})/bot_botcomponent` (or the `_parentbotid_value` fallback) returns rows whose
   `schemaname` has the `<agent>.<kind>.<Stem>` form for every component kind, that the
   formatted-value annotations arrive, and that `pac copilot push` refuses when the server changed
   (the `explainFailure` regex for that message is a guess).
