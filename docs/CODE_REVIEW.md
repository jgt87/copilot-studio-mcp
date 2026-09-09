# Code and functionality review

Reviewed 2026-09-09. Source review covered the MCP registration and policy layers, PAC execution and profiles, cloud context, sync and drift, flow authoring and updates, solution deployment, background jobs, and supporting tests/documentation. No application code was changed and no live write operations were performed.

## Remediation, 2026-09-10

All eight findings below have been addressed in the working tree. They are retained as the original review record; their line numbers refer to the reviewed version.

- Explicit environment changes invalidate unrelated inherited URL, tenant, bot and schema context.
- All PAC calls use the profile coordinator, including direct sync calls and calls without a profile. Multi-command bootstrap, pull/deploy and snapshot workflows retain the lock across their PAC steps.
- Quick drift includes agent/settings conflicts and resolves deleted paths from the baseline, including older stamps. Matching deletions on both sides do not conflict.
- Flow rebuilding preserves existing bindings and persists new references. Explicit conflicting bindings require a `connectionReferences` override. The response uses the same reference set passed to persistence.
- Failed operation results produce failed background jobs and MCP errors while retaining diagnostic payloads.
- Publish failure detection is applied centrally to `copilot publish`; a failed agent publication makes deployment unsuccessful.
- Windows timeout handling terminates the process tree and bounds the wait. If termination cannot be confirmed, the returned failure states that the operation may still be running. Termination does not undo remote changes already submitted.
- The server reads its version from package metadata. The documented full tool count is 137, and verification documentation now distinguishes the historical build log from the current follow-up list.

New regression tests cover target routing, concurrent profile use and restoration, the actual MCP deployment handler with fake PAC, quick drift, persisted flow bindings, and failure reporting. The strengthened Windows timeout test checks both return time and absence of a delayed child-process write. Process-tree termination needs execution outside restricted sandboxes.

The profile lock coordinates this server process only; external PAC processes remain outside it. These fixes have not been tested through new live tenant writes.

Final verification: `npm.cmd test` passed all **209 tests** (none skipped), and
`node scripts/smoke.mjs` passed in both normal and `CPS_READ_ONLY=1` modes. The smoke checks
advertised version **0.1.1**, with **137 tools** normally and **96** in read-only mode.
The earlier authentication-listing stall did not recur outside the sandbox. The full test run
also ran outside the sandbox so Windows could terminate the fake process tree.

## Findings, in priority order

### 1. High: an explicit target environment can retain the source Dataverse URL

Location: `src/tools/shared.ts:88-104`, also used by `dataverseReadsFor` at line 248.

`environmentId` and `dataverseUrl` are resolved independently. Passing a target environment ID still inherits the current workspace's Dataverse URL, or `CPS_ENVIRONMENT_URL`. Because a URL exists, the target environment lookup is skipped. Dataverse tools consequently operate on the inherited source URL. This affects reads, writes and cross-environment snapshots.

Offline reproduction: with `CPS_ENVIRONMENT_URL=https://source.example`, `cloudContext({environmentId:'target-environment'}, {dataverse:true})` returned the target ID together with the source URL.

Suggested fix: resolve environment identity, URL and tenant together. An explicit environment override must invalidate inherited context unless it is known to refer to that same environment. Test a source workspace plus explicit target ID, including the snapshot path.

### 2. High: PAC account isolation is incomplete

Locations: `src/pacProfile.ts:72-73`, `src/tools/sync.ts:73`, `:135`, `:163`, `:228`.

`withPacProfile` serializes only calls with a profile argument. Calls without one run outside the queue. Several core operations additionally invoke `runPac` directly, bypassing both the queue and `CPS_PAC_PROFILE` selection.

If an admin operation temporarily switches the active profile while a maker operation starts, that maker operation can run using the admin account. Commands without an explicit environment can also inherit its environment. Configuring a maker profile does not fix the direct calls.

Suggested fix: route all account-dependent PAC work through one coordinator, including calls using the current profile. Hold the lock for an entire multi-command operation and restore the previous profile afterwards. Add concurrent admin/maker tests. This is established from control flow; no real profile switching was performed during review.

### 3. High: quick drift does not block conflicting agent-settings edits

Locations: `src/drift.ts:342-344`, `src/tools/sync.ts:160`.

The quick report detects changes to the bot row, but builds its conflict list only from component rows. `cs_push` checks that conflict list. Editing agent settings locally and in the portal therefore does not trigger the server's conflict gate.

Offline reproduction returned `settingsChanged:true`, `localChanges:['agent.mcs.yml']`, and `conflicts:[]`.

Suggested fix: represent conflicts involving agent/settings files explicitly and include them in push preflight. Whether PAC itself prevents an overwrite still requires live verification; the server's promised protection is absent here.

### 4. Medium: deleting a topic locally hides a remote-edit conflict

Location: `src/drift.ts:314-315` and `componentFileFor`.

Component-to-file mapping searches the current workspace inventory. A deleted file is no longer in that inventory, even though the stamp records its original path. A remotely edited topic that was deleted locally consequently has `file:null` and `conflict:false`.

Offline reproduction confirmed the deletion in `localChanges` while reporting no conflict for the remotely modified topic.

Suggested fix: preserve component-to-path mappings in the baseline or resolve missing components against baseline file paths. Cover deletion and renaming cases. Full drift already handles delete-versus-edit; quick preflight should agree.

### 5. Medium: rebuilding a flow drops newly required connection references

Location: `src/tools/flows.ts:173-174`, with persistence in `src/cloud/dataverseFlows.ts`.

`buildFlow` returns both a definition and connection references. `cs_update_flow` forwards only the rebuilt definition. `updateFlow` deliberately retains the old references. Adding a connector step to a flow therefore leaves its new connection absent from the saved document.

An offline mocked update generated a `shared_office365` reference but persisted an empty reference map.

Suggested fix: merge generated references with existing bindings when applying a step specification, and require a decision for conflicting mappings. Test adding a connector and changing an explicit connection reference.

### 6. Medium: failed PAC operations become successful background jobs

Locations: `src/jobs.ts:118`, `src/tools/pacWrappers.ts`, `src/tools/shared.ts:maybeBackground`.

PAC failures normally resolve to `{ok:false}` rather than rejecting. `startJob` marks every resolved result as `succeeded`. Background publish and PAC wrappers can thus report success even when their nested result reports failure.

Offline reproduction: a body returning `{ok:false,exitCode:1}` produced `state:'succeeded'`.

Suggested fix: use an explicit operation-result contract or throw on unsuccessful PAC results before completing the job. Preserve diagnostics in failed jobs and expose failures consistently through MCP results.

### 7. Medium: solution deployment omits the known publish-failure check

Location: `src/tools/solutions.ts:352`, compared with `src/tools/sync.ts:228`.

Standalone `cs_publish` passes `failOnOutput:[PUBLISH_FAILED]` because PAC can print a publish failure and exit zero. The publish loop in `cs_deploy_solution` omits this option and reports `ok` from the exit code alone. A deployment can therefore claim an agent was published when PAC explicitly reported failure.

Suggested fix: share the publish implementation across both paths and propagate failed publication to the deployment outcome. Existing fake-PAC tests already establish the zero-exit failure behavior; add coverage for the deployment caller.

### 8. Medium: Windows shim timeouts leave the child operation running

Location: `src/pac.ts:99-102`, `:134-137`; `test/pac.test.js` timeout test.

For `.cmd` installations, the spawned process is `cmd.exe`. The timeout kills that wrapper, without terminating its descendant process tree. The test requesting a 300 ms timeout on a 5-second fake command took approximately 5.3 seconds during this review. The child continued running and kept the inherited output pipes open.

Suggested fix: terminate the process tree on Windows and make timeout completion bounded. Strengthen the test to assert elapsed time and that the child cannot perform a delayed side effect. The detected installation uses `pac.exe`; this finding applies to the supported `.cmd` route.

## Validation and improvement suggestions

- `npm.cmd test`: build succeeded; all 201 tests passed, none skipped. The PowerShell `npm` invocation initially hit a local Python launcher error; using `npm.cmd` worked.
- `node scripts/smoke.mjs`: initialization, discovery of 137 tools, six prompts and the guide call passed. The run then failed at its 60-second tool-call timeout during `cs_init`; the last server log was `pac.exe auth list`. The remaining smoke checks were not reached. The underlying PAC stall was not diagnosed, so this is a functionality limitation observed on this machine, not an established additional code defect.
- Additional offline probes reproduced findings 1, 3, 4, 5 and 6 without contacting cloud services. Findings 2 and 7 follow from the relevant callers. Finding 8 was visible in the existing test's timing and process implementation.
- Add integration tests around tool handlers and shared context. The suite covers many helpers well, but the most consequential gaps occur where individually tested helpers are assembled.
- Generate server version from package metadata: `package.json` says `0.1.1`, while `src/tools/shared.ts:30` advertises `0.1.0`. The current server exposes 137 tools; parts of the README still describe 131.
- Consolidate verification status. `docs/verify.md` records completed live phases and remaining work, while older sections of `CLAUDE.md`, README and `docs/STATUS.md` still describe some completed areas as untested. Record a last verified version and date for each workflow.
- Complete the documented live verification for chat, transcripts, quick drift and solution ALM in a dedicated development environment. Passing fixture tests establishes internal consistency; it does not establish that every generated payload and external API path works end to end.

The architecture has useful separation of concerns, injectable HTTP clients, declarative PAC wrappers, and broad offline coverage. Address environment/account routing first, then conflict detection and truthful failure reporting before relying on unattended deployment workflows.
