# 08 Promote an agent to another environment

The maker wants the agent in test or production, or tried and the import failed, or it
imported and the tools arrived disconnected and the flows switched off. A per-agent workspace
cannot move an agent: it is bound to the environment it came from. The vehicle is the
solution, and the server makes that a pull, a settings file and a deploy, with a comparison
afterwards that proves the two environments hold the same thing.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then
runbooks/08-promote-agent-to-another-environment.md for agent "<agent>" from environment
"<source>" to environment "<target>". The maker reports: "<symptom or request, quoted>".
Inventory the solution, pull it in the background, list the target's connections, draft the
deployment settings, and show me the deploy dry run. Deploy only after I confirm.
```

## What you need

- Intake done in the **source** environment; the solution unique name.
- The target environment id (`cs_admin_list_environments profile=admin name=<target>`).
- Connections in the target, owned by the account that will deploy (yours, or a service
  account): SharePoint, Outlook, Dataverse, MCP servers. Only a service-principal Dataverse
  connection can be made from here (`cs_create_connection`); the rest is portal work by
  whoever owns them.

## Steps

### 1. Is the solution complete? (no writes to the environment)

```
cs_describe_solution name=<solution unique name> environment=<source id> workDir=runbooks/cases/<date>-<agent>/outputs/solution
```

- IF `missingDependencies > 0`, or a flow or connection reference the agent uses is not in the
  inventory -> runbook 03 first. An import of an incomplete solution fails or arrives broken.
- IF the solution is managed in the source -> it came from somewhere else; promote from
  there, not from here.

### 2. Pull it (writes to disk; minutes)

```
cs_pull_solution name=<solution unique name> environment=<source id> targetDir=runbooks/cases/<date>-<agent>/promote background=true
cs_job_status jobId=<id>
```

Exports unmanaged and managed, unpacks to `src/`, writes `solution.json` and
`deployment-settings.json`, clones every agent into `agents/`.

### 3. What the target has (no writes)

```
cs_list_connections environment=<target id>
```

Record the connection ids per connector. Compare with the connection references in the pull
(`solution.json`).

- IF a connector has no connection in the target -> someone makes one there first (portal:
  Power Automate > Connections > New), or the deploy runs with `allowUnmapped: true` and the
  tool stays unbound until it is done.

### 4. The settings file (writes to disk)

```
cs_create_deployment_settings solutionDir=runbooks/cases/<date>-<agent>/promote connectionReferences=<logical name -> connection id map> environmentVariables=<name -> value map> copilotAgents=<agent schema name -> Entra group id map>
```

Three things go in: each connection reference to a target connection id; each environment
variable's target value (an empty value inherits the solution default, usually a dev value);
each agent's access group in the target (`AadGroupId`; the source group means nothing here).

### 5. Deploy (changes the target: dry run, then confirm)

```
cs_deploy_solution targetEnvironment=<target id> solutionDir=runbooks/cases/<date>-<agent>/promote settingsFile=runbooks/cases/<date>-<agent>/promote/deployment-settings.json
cs_deploy_solution targetEnvironment=<target id> solutionDir=runbooks/cases/<date>-<agent>/promote settingsFile=runbooks/cases/<date>-<agent>/promote/deployment-settings.json confirm=true
```

Managed for test and production, unmanaged only for a development target (`unmanaged: true`).
The deploy imports and then publishes every agent (`publishAgents`, default on). It refuses an
unmapped connection reference unless `allowUnmapped: true`. `skipLowerVersion` and
`forceOverwrite` are the answers to "a newer version exists" and "unmanaged customisations in
the target".

### 6. After the import (some writes: each is a dry run, then confirm)

| Check | How | If not |
| --- | --- | --- |
| flows are on | `cs_list_flows environmentId=<target id>` | `cs_set_flow_state flowId=<id> state=on` per flow, after its connections are bound |
| tools are connected | `cs_clone_agent bot=<schema> environment=<target id> outputDir=<case>/target` then `cs_describe_workspace`: no `connectionId: null` | bind in the target portal (Tools > tool > Connect) |
| uploaded knowledge files | present in the clone's `knowledge/files/` | re-upload in the target; files are not in the solution |
| channels | the maker's Channels page in the target | re-publish to Teams / web there |
| access group | step 4 `copilotAgents` | Settings > Security > Access in the target |
| published | `cs_check_drift workspace=<case>/target mode=quick` shows no unpublished changes | `cs_publish` from the target clone (dry run, confirm) |

### 7. Prove it (no writes; disk only)

```
cs_snapshot_environment label=SOURCE environment=<source id> dir=runbooks/cases/<date>-<agent>/snapshots/SOURCE solution=<solution unique name>
cs_snapshot_environment label=TARGET environment=<target id> dir=runbooks/cases/<date>-<agent>/snapshots/TARGET solution=<solution unique name>
cs_compare_snapshots a=runbooks/cases/<date>-<agent>/snapshots/SOURCE b=runbooks/cases/<date>-<agent>/snapshots/TARGET
```

The report starts with `DRIFT` or `no drift`; connection bindings, variable values and the
managed flag are expected differences, not drift.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| import fails: missing dependency | component outside the solution | step 1 | runbook 03 |
| import fails: connection reference | no connection in the target for that connector | step 3 | create the connection there; or `allowUnmapped` and bind later |
| tools arrive disconnected | references imported unmapped | step 6 clone, `connectionId: null` | bind in the target portal |
| flows arrive switched off | connection references unresolved at import | step 6 `cs_list_flows` | bind, then `cs_set_flow_state` |
| nobody in the target can use it | access group is the source's | step 4 | `copilotAgents` map, or Settings > Security > Access |
| knowledge empty in the target | uploaded files are not in the solution | step 6 | re-upload |
| "a newer version exists" / "customisations would be lost" | version or layering | deploy output | `skipLowerVersion` / `forceOverwrite`, knowingly |
| the maker keeps editing in the target | managed solution edited in place | later `cs_compare_snapshots` drift | edit in the source, promote again |

## Fix note

For the maker: what was deployed, what they must finish in the target portal (connect, upload,
channels, group), and the rule that the source is where edits happen. For yourself: the
`promote/` folder is the artefact; keep `deployment-settings.json` for the next promotion and
run step 7 before every one.

## Verify

Step 7 reports `no drift`; the maker's test user gets an answer through the target's channel.

## Known gaps

- Connections are the one thing the platform will not let a tool create (except
  service-principal Dataverse); every promotion has a portal step for them.
- Moving a solution between environments is unverified against a live tenant in this server;
  read every dry run.
- Pipelines (`cs_list_pipelines`, `cs_deploy_pipeline`) are the alternative when the tenant
  uses them; the settings file work is the same.
