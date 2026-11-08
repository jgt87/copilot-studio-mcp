# Changelog

What changed in each release of `copilot-studio-mcp`, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/). Entries for 0.1.0 to 0.1.8 are the GitHub release
notes of those versions.

## [Unreleased]

### Fixed

- **Browser sign-in could disclose its parameters to an attacker-controlled endpoint.**
  `@azure/msal-node` moves from 6.0.1 to 7.2.1 for advisory GHSA-xcx6-jx8p-x3h5 (high). Version 7
  always returns the interactive sign-in answer as a form post to the local loopback page; this
  server never set `responseMode`, so `cs_login` needs no change.
- **Two denial-of-service advisories in transitive dependencies**: `body-parser` 2.4.0 and
  `fast-uri` 3.1.9, both through `@modelcontextprotocol/sdk`.

### Added

- **A changelog**, this file, shipped in the npm package. Earlier releases' notes are carried over
  from GitHub.

### Changed

- **Dependencies**: `@azure/msal-node-extensions` 5.6.1 (now shares `@azure/msal-common` 16.16.1
  with msal-node instead of carrying a second copy), `@microsoft/agents-activity` and
  `@microsoft/agents-copilotstudio-client` 1.10.1, `@modelcontextprotocol/sdk` 1.32.2.

Still open: `@microsoft/agents-activity` pins `zod` 3.25.75, which has advisory
GHSA-mrhx-c7xc-m3w5 (high); every version up to 1.11.0-beta carries it. Not verified live yet:
interactive and device-code sign-in on msal-node 7.

## [0.1.8] - 2026-10-17

A validation release. `cs_validate` now checks the YAML against what Copilot Studio and pac actually
accept, not only against the published schema, and one of those checks found that `cs_add_variable`
wrote a file the validator itself rejected. Upgrade if your agents use global variables (a push was
blocked unless forced), or if you or a model edit `.mcs.yml` files by hand. It also adds four Power
Platform API tools and two pac wrappers.

### Fixed

- **A workspace with a global variable could not be pushed.** `cs_add_variable` writes the flat file
  Microsoft's own template uses; the validator held it to the schema's Dataverse shape and reported
  "Missing required property 'variable'", which blocks `cs_push`. The file is now checked against
  its own rules: `aIVisibility` must be `UseInAIContext` or `Hidden`, the scope is `Conversation`,
  and `schemaName` ends in `.globalvariable.<name>`.
- **A leftover `<AGENT_SCHEMA>` placeholder could reach the service.** Outside redirects and
  connection references it was only a warning, so a variable's `schemaName` or a knowledge search's
  sources were pushed with the placeholder in them. It is now an error everywhere.
- **Redirects to a topic whose display name differs from its file name were reported as missing.**
  "order status" in `OrderStatus.mcs.yml`, or a renamed clone, no longer warns.
- **The knowledge guide named `kind` values the tool rejects.** It said `publicSite` /
  `sharePoint` / `graphConnector`; the tool takes `public-site` / `sharepoint` / `graph-connector`.
- **Server start-up no longer probes PATH for pac before answering `initialize`**, which stalled
  clients with a short start-up limit (Mistral Vibe: 10 seconds) on machines with network paths.

### Added

- **`cs_validate` blocks the mistakes a push accepts and then stores wrongly**, each with its source
  cited in the code:
  - merge-conflict markers left by `pac copilot pull` (a push keeps only the text before them);
  - file and schema names pac rejects (characters outside `A-Z a-z 0-9 _ - . { } !`, or over 100
    characters);
  - more than 200 trigger phrases on a topic;
  - `SendMessage` / `message:` from the Learn code-editor sample, with a pointer to `SendActivity`.
- **`cs_validate` warns about the likely ones**: text cut off by an unquoted ` #`, nodes after an end
  node, a `value` or `triggerCondition` that reads like a formula but has no `=`, adaptive cards with
  no submit action, `Action.Execute`, unlabelled required inputs or a version above 1.6, topic inputs
  and outputs without descriptions, a phrase listed twice, and a period in a topic name (the solution
  can no longer be exported). `settings.mcs.yml`, `connectionreferences.mcs.yml` and flow
  `metadata.yaml` are now parsed too.
- **`cs_review_agent` flags single-word trigger phrases, phrases of ten words or more, and topics
  with the same description** (generative orchestration picks topics by description).
- **The topics guide covers hand-editing**: the `=` rule for values, what each end node does, the
  `answered` output, quoting, and line breaks.
- **`cs_reassign_agent_owner`** hands an agent to a new owner inside its environment
  (`pac copilot-studio reassign-copilot-agent`, `confirm`; in the `admin` preset), and
  **`cs_get_test_set`** shows one evaluation test set with its cases.
- **`cs_download_evaluation_snapshot`**, **`cs_get_connector_consent_bypass`** /
  **`cs_set_connector_consent_bypass`** and **`cs_download_channel_manifest`** (the Teams / Microsoft
  365 app package) from the Power Platform API, and `mcsConnectionId` / `toolsConnections` on
  `cs_run_evaluation`, for evaluations that call tools.

### Changed

- **The two "Reassign an agent's owner" tools now say which side they change**:
  `cs_reassign_agent_owner` is the environment, `cs_reassign_org_agent` the Microsoft 365 catalogue.
- **Checked against pac 2.13.1**, a dependency-only release: every command's help is identical to
  2.12.2.
- **Dependencies**: zod 4, diff 9, @azure/msal-node 6.0.1, js-yaml 5.4.2. Tool schemas now come from
  zod 4's JSON Schema generator (draft-07 marker, shared shapes as `definitions`); same tools, same
  required fields.

333 tests pass. Not verified live: the new checks have run against Microsoft's templates and the test
fixtures, not a real cloned agent; the four Power Platform API tools and the two `pac copilot-studio`
wrappers follow the published reference only. `docs/verify.md` lists what to check.

## [0.1.7] - 2026-09-14

A behaviour release, and the one change everybody notices: the tools that edit an agent no longer
write on the first call. They return the change - a new file in full, an edit as a diff, instructions
with their character count - and write it when you call again with `confirm: true`. Upgrade if you
let a model author agents for you; if you script these tools, add `confirm: true` to those calls.

### Added

- **You see the edit before it happens.** `cs_add_topic`, `cs_add_knowledge_source`, `cs_add_tool`,
  `cs_add_flow`, `cs_add_trigger`, `cs_add_variable`, `cs_edit_topic`, `cs_edit_tool`,
  `cs_edit_knowledge`, `cs_update_settings`, `cs_update_agent` and `cs_generate_instructions` now
  return the files they would write, diffed against what is there, and change nothing until the
  same call is repeated with `confirm: true`. The preview is built by running the tool with its
  writes captured, so it is what the tool actually produces rather than a second guess at it.
- **Instructions are counted against the limit that will reject them.** An edit to `instructions`
  reports the character count and what is left of Copilot Studio's 8000; the Settings > Responses
  "Response formatting" box (`responseInstructions`) gets the same treatment against its 500. An
  edit that would exceed either is refused while the text is still in front of you, instead of
  failing at push time. `cs_review_agent` flags an agent already over, or within 10% of, the 8000.
- **`cs_create_agent` asks instead of guessing.** `publisherPrefix` and `projectDir` are optional
  now: leave them out and the tool returns the questions, with the publishers it can read from the
  environment as choices and a folder named after the agent as a suggestion. Name a solution and it
  reads that solution's publisher and offers the one prefix that will import. The dry run says where
  the agent lands, and what the prefix commits you to - it becomes part of every component's schema
  name and cannot be changed afterwards.
- **`cs_create_agent` takes `background: true`.** Creating an agent inside a solution runs init,
  pack, import and clone, which routinely outlives the ~60 second budget MCP clients allow a single
  call; the work used to keep running with nobody listening. It now returns a `jobId` you poll with
  `cs_job_status`, like `cs_publish`.

### Changed

- **`cs_generate_instructions apply: true` needs `confirm: true` as well.** Without it the generated
  text comes back with the change it would make, and nothing is written - so the draft can be
  written with `cs_update_agent` rather than paying AI Builder to generate it a second time.
- **`cs_remove_component`'s dry run names the files.** It used to name only the component.

### Fixed

- **A component file that is missing no longer breaks validation.** `cs_validate` reports it as a
  diagnostic instead of throwing.

311 tests and the stdio smoke run pass, including end-to-end checks that a previewed call writes
nothing and the confirmed one writes what the preview showed. Not verified live this release: the
Dataverse `publishers` read behind the new `cs_create_agent` choices, and the 500-character response
formatting limit, which is taken from the portal rather than the published schema.

## [0.1.6] - 2026-09-11

A feature release about cloud flows, and about whether your model picks the right tool at all.
Upgrade if you build Power Automate flows behind your agents, if you deploy solutions and keep
having to bind connections by hand, or if you run the server on a smaller model.

### Added

- **Find out why a flow run failed, not just that it did.** `cs_explain_flow_run` reads the run's
  actions, resolves the real error message of each failed one, and shows the inputs it was called
  with next to the outputs of the actions that ran just before it. This matters because a failed
  *connector* action carries no error of its own - the message sits in the action's outputs behind
  a link that expires after a few days - so the run list alone can only ever tell you that
  something broke.
- **"It worked yesterday" is now a diff.** `cs_compare_flow_runs` lines a failed run up against the
  most recent successful one, names the action where they part company, and with
  `compareTriggerData: true` reports which keys of the trigger payload differ - key names only,
  never the values. Actions present in one run but not the other mean the definition changed, not
  the data.
- **"It fails sometimes" is now a number.** `cs_analyze_flow_health` gives the failure rate, the
  duration median and 90th percentile, and which actions the failures land on, with a verdict that
  separates one broken step from failures spread across many.
- **Bind a flow's connection in one call.** `cs_bind_flow_connection` is the step that lets a flow
  be switched on. With one connection reference and one usable connection it needs nothing but the
  flow id; otherwise it asks. It writes whichever of the two shapes the flow uses - a flow built
  outside a solution names its connection directly, one that arrived in a solution points at a
  `connectionreference` row - and `activate: true` turns the flow on in the same call. This is the
  manual step a solution import has always left behind.
- **`cs_delete_flow`**, closing the gap where a flow could be read and created but not removed.
- **A routing eval, shipped in the package.** `npx copilot-studio-mcp-routing-eval` puts the tool
  list in front of a model exactly as your client sees it, one plain-English question at a time,
  and scores the first tool it names. `--cases` takes your own file, which is the point: the
  questions your users actually ask are better evidence than the sixty-two shipped here. Free with
  `--dry-run`; nothing calls a model without `--yes`.
- **A `flows` guide topic** covering build, bind, run and diagnose, and a flow lifecycle diagram in
  `docs/flows.md`.

### Changed

- **Tool descriptions now say when to reach for a tool, not what it is.** Measured with the new
  eval, misroutes fell from eighteen per cent of questions to eleven. Three causes, all of them
  self-inflicted: `cs_init` opened with "Run this first in a new session" and became the answer to
  eleven unrelated questions, because every session is a new one; `cs_guide` said "read this before
  planning a sequence of calls" and absorbed requests to build things; `cs_validate` said "run
  before cs_push" and won "send my changes up". Funnel instructions have moved out of descriptions
  and into the handshake, where they are read once.
- The triage runbooks are published rather than gitignored. Their `cases/` and `samples/` working
  folders stay ignored, because those hold clones of other people's agents.
- `cs_set_tool_preset` was advertising a stale tool count.

### Fixed

- **`cs_guide` topic list drifted out of the handshake instructions**, so a topic could exist
  without any client being told about it.

### Notes

278 tests pass, offline against recorded responses and fixtures. The flow diagnostics and the
connection binding have **not** been exercised against a live tenant: the Power Automate service
shapes they read - the per-run actions route, the SAS-signed content links, the trigger's own
output link - come from documentation rather than a capture, and the solution-shaped binding
writes to a different table than the direct one. `docs/verify.md` section 6 is the checklist for
settling them, and it is worth doing before trusting any of it in production.

The routing numbers above are means of three runs on Haiku 4.5. Read them that way: on an
identical build the score moves by two cases between runs and a third of the questions answer
differently each time, so a single run will tell you a change helped when it did not.

## [0.1.5] - 2026-09-11

Distribution release. Nothing in the server changed; upgrade only if you want the install path that does not involve a clone, or you found the package through a registry.

### Added

- **Install from npm, without a clone.** `npx -y copilot-studio-mcp` is now the documented way to run the server: an "Install in VS Code" badge, a `code --add-mcp` one-liner and a `claude mcp add-json` line replace the git clone in the README's setup section. The clone is still how you develop it and has moved to "Development".
- **Listed in the MCP Registry** as `io.github.jgt87/copilot-studio-mcp`, through `server.json` and `mcpName` in `package.json`. The GitHub MCP Registry and VS Code's MCP gallery (Extensions view, search `@mcp`) take their entries from there; when this entry shows up in the gallery is GitHub's sync, not this release.

### Changed

- `test/registry.test.js` fails when `server.json` and `package.json` disagree on name or version, and the release procedure in `CLAUDE.md` now ends with `mcp-publisher validate` and `mcp-publisher publish`, after `npm publish` because the registry reads `mcpName` from the tarball.

252 tests, offline. No file under `src/` changed in this release.

## [0.1.4] - 2026-09-11

Testing and documentation release. Upgrade if you use `cs_run_conversation_tests` or `cs_chat` and want to know whether the agent actually called its tool, or if you read the README to find your way around.

### Added

- **A conversation test can now assert what the agent did, not only what it said.** A test that checks wording passes whether the agent called its tool or improvised an answer that reads correctly; that is the failure worth catching, and the data to catch it was being thrown away - `cs_run_conversation_tests` passed only the reply text to the evaluator, and `cs_chat` dropped `channelData` before the caller saw it. `expect` gains `usedTool`, `notUsedTool`, `usedTopic`, `notUsedTopic` and `citedKnowledge`. Names match loosely, so a transcript reporting `contoso_orderLookup.Run` satisfies `orderLookup`. Every test result and every `cs_chat` reply now reports the observed topic, tool and citations whether or not anything asserted on them. An expectation that cannot be judged says so once - "no tool, topic or citation attribution in the N activities returned" - rather than reporting every name as missing, because cannot-be-judged and the-agent-misbehaved are different problems with different fixes.

  One module, `src/attribution.ts`, reads the attribution for both the live DirectLine path and the stored Dataverse transcripts, so the two readers agree; the transcript tools use it instead of their own copy.

- **`docs/test-verification.md`**, the runbook for the feedback loop: static checks, behavioural tests, push and publish, transcripts, and turning a real failure back into a test. Its phase 1 is the gate for the item above.

### Changed

- **The README is organised by workflow instead of by tool.** It opens with the ten jobs the server does and has a section per job, written as the steps a person takes with the tool named as the how; the per-tool tables moved to `docs/tools.md`. Preset counts that had drifted (33/23/36/20) now read what the server offers (34/25/44/21). The page title is "Copilot Studio MCP".
- `CLAUDE.md` gains the release procedure and the list of documents that go stale when code changes.

251 tests, offline, including `test/attribution.test.js`, the written record of which `channelData` shapes are claimed. The attribution key names come from the channel documentation and none has been seen from a live tenant yet: every accessor takes each documented casing and nesting, the extractor returns null rather than guessing, and phase 1 of the runbook is what settles it.

## [0.1.3] - 2026-09-11

Resilience release, for the two ways a long chat used to fail and the one way any cloud call did. Found by comparing this server's chat path against [bradcstevens/copilot-studio-agent-direct-line-mcp](https://github.com/bradcstevens/copilot-studio-agent-direct-line-mcp), which handles both.

### Fixed

- **DirectLine sessions were never released.** The session map was written and never swept, so every conversation held its token, domain and watermark for the life of the process. Sessions now carry a last-used stamp and are swept on the next call: idle ones after 30 minutes, matching DirectLine's own abandonment window, then the least recently used above a cap of 100. A conversation the bot closes with `endOfConversation` is released at once, and `endDirectLineSession` releases one on request.
- **A DirectLine token was never refreshed.** The conversation token minted at the start was kept forever, though DirectLine retires one after about 30 minutes, so continuing a conversation past that window failed with an authorisation error the caller could do nothing with. A token within five minutes of expiry is now traded for a fresh one. A session running on a DirectLine secret has no expiry and is never sent to the refresh endpoint. When the refresh itself fails the session is dropped and the error says the thread is gone and to call again without `conversationId`, rather than letting the next request return a bare 403.

### Added

- **Retries, scoped to what is safe to repeat.** Every cloud call was single-shot, so one throttled or briefly broken response failed a whole tool call. A GET is idempotent by contract and is now retried; a non-GET is not, because a publish or a solution import that timed out may already have been applied. A non-GET that only reads opts in with `idempotent: true`; any call opts out with `retry: false`.

  Only a transport failure or 408, 429, 500, 502, 503, 504 is retried - 401, 403, 404 and the other 4xx are the caller's to fix, and a body that will not parse is the server's answer rather than a blip. Three tries, exponential backoff from 400ms with 50-100% jitter. `Retry-After` wins over the computed delay but is capped at 5s: an MCP client cuts a tool call off at about 60s, so obeying a minute-long `Retry-After` would lose the call the wait was meant to save.

  A transport failure now surfaces as `NetworkError` naming the host instead of a bare "fetch failed". `HttpError.status` is unchanged.

### Changed

- `.vscode/mcp.json` no longer carries a `description` key on the server entry; VS Code's schema does not allow one. Note that `repowise init` writes it and `repowise update` puts it back.

239 tests, offline, including two new files: `test/chat.test.js` (which had none) drives the session lifecycle against a controlled clock, and `test/http-retry.test.js` pins the retry boundary. Both were checked by breaking each behaviour in the build and confirming a distinct test fails.

## [0.1.2] - 2026-09-10

Correctness release. A code review of the previous build found eight places where the server reported something other than what it did; all eight are fixed, with regression tests. Upgrading from 0.1.1 is recommended if you use cross-environment snapshots, two pac accounts, background jobs or solution deployment.

### Fixed

- **An explicit target environment kept the source's Dataverse URL.** `cloudContext` resolved environment identity and its URL independently, so passing a target environment id while inside a workspace silently read the *source* environment and labelled the result as the target. `cs_snapshot_environment` and `cs_compare_environments` were the ones that hurt: a DTAP diff could compare an environment against itself. Identity, URL, tenant and agent now move together.
- **pac account isolation was incomplete.** `withPacProfile` returned before the serialisation queue when no profile was named, and the core sync tools called `runPac` directly, so `CPS_PAC_PROFILE` never reached them and a concurrent admin operation could run a maker command as the admin. All pac work now shares one queue; multi-command operations hold it for their whole run.
- **`cs_push` did not block on conflicting agent-settings edits.** The quick drift check built its conflict list from component rows only, so editing agent settings locally and in the portal passed the gate. Deleted components also lost their file mapping, hiding a delete-versus-remote-edit conflict; the sync stamp now records each component's path.
- **`cs_update_flow` dropped new connection references.** Rebuilding a flow forwarded only the definition, so a newly added connector's binding was never saved - while the result reported it as if it were.
- **Failed pac runs became successful background jobs.** `startJob` marked every resolved body `succeeded`, including the `{ok: false}` a failed pac run resolves to.
- **`cs_deploy_solution` reported failed publishes as successful.** The publish loop omitted the zero-exit failure check that standalone `cs_publish` had. `pac copilot publish` prints "Failed to publish" and still exits 0; that check now lives in the runner and applies to every publish.
- **A timeout did not bound a call on a `.cmd` install.** Killing the `cmd.exe` wrapper left its descendants running with the pipes open, so a 300ms timeout returned after 5115ms with the child still alive. Now ~570ms, whole process tree terminated.

### Changed

- The advertised server version is read from `package.json` instead of being restated in the source, where it had drifted to `0.1.0`.
- `src/pac.ts` split: `src/pacRun.ts` is the account-independent runner, `pac.ts` the facade every other module imports. This removed an import cycle between `pac.ts` and `pacProfile.ts`. No import surface changed.
- `cs_create_agent`'s pre-action decision is now one pure function, `createAgentGate`, tested across all 72 input combinations rather than inline in the handler.
- README tool count corrected to 137.

217 tests, offline. Nothing here was verified against a live tenant beyond what 0.1.1 already covered.

## [0.1.1] - 2026-09-09

Documentation only. Every file under `dist/` is byte-identical to `v0.1.0`; npm serves the readme from the published tarball, so a release was the only way to get the new **Status** section onto the package page.

### Changed

- **README**: a Status section directly under the intro, separating what is verified offline (171 tests plus the pack oracle), what was verified against a real tenant on 2026-09-08 (phases A to F), and what is still untried - the transcript tools, `cs_check_drift` quick mode, `cs_chat`, the Dataverse `listBots` path, cross-environment solution moves, and any generated flow actually imported.
- **docs/STATUS.md**: row 25 (long-running tools blocking the MCP client) corrected from `open` to `fixed` - the background job mode it asked for shipped in 7a7c762.

No behaviour change. Upgrading from 0.1.0 is optional.

## [0.1.0] - 2026-09-09

First release, published to npm as [`copilot-studio-mcp@0.1.0`](https://www.npmjs.com/package/copilot-studio-mcp).

An MCP server for building Microsoft Copilot Studio agents from files: it wraps the Power Platform CLI for workspace sync, writes the YAML the Copilot Studio VS Code extension uses, and calls the Power Platform, Dataverse, BAP and DirectLine APIs for what the CLI does not cover.


### What is in it

132 tools across five areas:

- **Sync** - clone, pull, push and pack an agent workspace through `pac copilot`
- **Authoring** - topics, knowledge sources, tools, triggers, variables and flows written as YAML, validated against the published authoring schema
- **Cloud** - publish, chat-test over DirectLine or the Copilot Studio client SDK, evaluations, transcripts and flow runs
- **Solutions** - the ALM path: export, unpack, deployment settings and import for moving work between environments
- **Day two** - drift detection against the portal, DTAP snapshots and diffs, a rules-based agent review

Every tool that changes a live environment returns a dry run and does nothing until it is called again with `confirm: true`. `CPS_READ_ONLY=1` withholds them entirely.

### Requirements

- Node.js >= 20
- [Power Platform CLI](https://learn.microsoft.com/power-platform/developer/cli/introduction) (`pac`) for the sync and solution commands
- A Power Platform environment; all permissions are delegated, there is no client-credential flow

### Status

Verified offline: 171 tests, plus a pack oracle that round-trips generated YAML through `pac copilot pack`.

Verified against a real tenant on 2026-09-08 (phases A to F of the verification runbook): the connector registry endpoint, the `pac connection list` column layout, the `pac copilot clone` layout and sync metadata, drift detection and the `cs_push` conflict refusal, and the whole evaluation path end to end including the portal CSV import format and the metric status strings. A portal-made agent validates clean, so `cs_validate` has no false positives against real content. That run also caught and fixed a real bug: `pac copilot publish` exits 0 while printing "Failed to publish", so a failed publish was reported as a success.

Still unverified live: the transcript tools, `cs_check_drift` quick mode, `cs_chat`, the Dataverse `listBots` path, and moving a solution between environments. No flow produced by the flow builder has been imported into an environment yet, so the flow tools are the least-proven area. See `docs/verify.md`.

Treat this as an early release and check the dry run before confirming anything that writes.

MIT licensed.

[Unreleased]: https://github.com/jgt87/copilot-studio-mcp/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.8
[0.1.7]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.7
[0.1.6]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.6
[0.1.5]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.5
[0.1.4]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.4
[0.1.3]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.3
[0.1.2]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.2
[0.1.1]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.1
[0.1.0]: https://github.com/jgt87/copilot-studio-mcp/releases/tag/v0.1.0
