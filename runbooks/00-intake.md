# 00 Intake: get the agent on disk and take the first read

Every case starts here. The maker names an agent and an environment (or just an agent, and you
find the environment); this runbook ends with the agent cloned into a case folder, the first
read recorded, and a decision about which of runbooks 01-04 applies. All of it is read-only.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md for agent "<agent>" in environment "<environment>" (name or id).
Clone into runbooks/cases/<today>-<agent>/clone. Record the intake facts in
runbooks/cases/<today>-<agent>/intake.md: environment id and type, the agent's id, schema name
and solutionId, authenticationMode, the knowledge sources with their kinds, the tools with their
connectors, connection references without a connection, the review score and every finding of
severity error or warning, validation errors, and the number of evaluation test sets. Then tell
me which of runbooks 01-04 applies and why, quoting the evidence.
```

## What you need

- The admin pac profile active (`cs_init` lists `pacProfiles`; see README setup).
- `cs_login` cached for step 8 (`cs_init` shows `cloudAccess.ready`); the rest is pac only.
- A case folder: `runbooks/cases/<yyyy-mm-dd>-<agent>/`.

## Steps

### 1. Check the session (no writes)

**The question:** is the right account active, and can the cloud tools run?

```
cs_init
```

- IF the active pac profile is not the admin account -> `cs_select_auth_profile name=admin`.
- IF `cloudAccess.ready` is false -> `cs_login` (step 8 needs it; the clone does not).

### 2. Resolve the environment (no writes)

**The question:** which environment, and what kind is it?

```
cs_admin_list_environments profile=admin name="<environment>"
```

Record the environment **id**, **type** and **state**.

- IF type is `Developer` -> the maker's personal environment. Note it: anything the agent needs
  in production must be moved by solution export, and the fix note should say so.
- IF the name matches more than one -> ask the maker for the URL of the agent; the environment
  id is the GUID after `/environments/` in `copilotstudio.microsoft.com/environments/<id>/bots/<bot>`.

### 3. Find the agent row (no writes)

**The question:** which agent, and which solution is it in?

```
cs_list_agents environmentId=<environment id> via=pac
```

Record the agent's **id**, **schema name**, **solutionId** and **componentState**.

- IF the agent is not listed -> it is in another environment, or it was deleted. Ask for the
  agent URL (step 2) and repeat.
- IF `solutionId` is `fd140aaf-4df4-11dd-bd17-0019b9312238` -> the agent is in the Default
  solution (that id is the same in every organisation; `Active`, the unmanaged layer, is
  `fd140aae-4df4-11dd-bd17-0019b9312238`; step 9 confirms it): runbook 03 applies whatever
  else is wrong.

### 4. Clone it (writes to disk only)

```
cs_clone_agent bot=<agent id> environment=<environment id> outputDir=runbooks/cases/<date>-<agent>/clone
```

- IF pac refuses with a permissions error -> the active profile has no role in that
  environment. `cs_admin_list_security_roles environment=<id> profile=admin` shows the roles;
  `cs_admin_assign_user` adds one (dry run, then confirm) - System Administrator is the one
  that reads every bot.
- IF the clone folder holds only `settings.mcs.yml` and `agent.sync.yaml` with
  `authoringModel: CliCopilot` -> a GitHub Copilot harness agent: no topics, no evaluations;
  runbooks 01 (instructions only) and 03 still apply.

### 5. Inventory (no writes)

```
cs_describe_workspace workspace=runbooks/cases/<date>-<agent>/clone
```

Record, in this order:

| Field | Why it matters | Value |
| --- | --- | --- |
| `authenticationMode` | `None` with SharePoint/Graph/Dataverse knowledge is an error (01); Entra SSO changes how `cs_chat` runs | |
| `knowledge[]` kind and site | which connectors are implied (02); which need a signed-in user (01) | |
| `actions[]` actionKind, operationId, connectionReference, flowId | which connectors and flows the agent depends on (02, 03) | |
| `connectionReferences[]` with `connectionId: null` | a tool that exists but cannot run: the maker never connected it, or DLP refused (02) | |
| `workflows[]` | flows the workspace carries; compare with the solution (03) | |
| `sync.environmentId`, `sync.agentId` | the ids the cloud tools will use | |

### 6. Review (no writes)

```
cs_review_agent workspace=runbooks/cases/<date>-<agent>/clone markdown=true reportPath=runbooks/cases/<date>-<agent>/outputs/review.md
```

Record the **score** and every **error** and **warning** by rule name. The rules that route to
a runbook: `instructions-*`, `tool-description`, `no-escalation`, `no-fallback`,
`topic-phrase-overlap` -> 01; `connection-unbound`, `auth-none-with-private-knowledge` -> 01 or
02 (see step 10); `pack-only-workspace` means the clone is not sync-connected - the clone step
went wrong, repeat it with `environment`.

### 7. Validate (no writes)

```
cs_validate workspace=runbooks/cases/<date>-<agent>/clone
```

A portal-made agent validates clean. Record any error: it is either a placeholder the maker
left (`<connection-reference>`, `<topic>`) or a component the schema does not know, and the fix
note should name the file.

### 8. Evaluations in place? (no writes, needs cs_login)

```
cs_list_test_sets workspace=runbooks/cases/<date>-<agent>/clone
```

Record the count. IF 0 -> runbook 04 applies in addition to whatever else.

### 9. The solutions in the environment (no writes)

```
cs_list_solutions environment=<environment id>
```

Match the agent's `solutionId` from step 3 to a unique name. Record it. The Default solution
has unique name `Default`.

### 10. Decide

| Evidence | Runbook |
| --- | --- |
| `instructions-missing/short/long`, `tool-description`, `no-escalation`, `no-fallback`, `topic-phrase-overlap`; or the maker's symptom is about answers | 01 |
| `connection-unbound` **and** the maker says they tried to connect; or "I cannot add X"; or a knowledge source refused | 02 |
| `connection-unbound` and the maker simply has not connected yet | not a triage: fix note says "Tools > tool > Connect" |
| `auth-none-with-private-knowledge` | 01 (the setting) - and check 02 if the maker says the knowledge source was refused |
| agent in `Default`; a `flowId` in `actions[]` that `cs_describe_solution` (03 step 2) does not list; `missingDependencies > 0` | 03 |
| test-set count 0 | 04, after the runbook that fixes the symptom |

Write `intake.md` with the recorded facts and the decision. Two runbooks can apply: 02 goes
first when it applies (a blocked connector makes the other findings moot), then the one that
explains the symptom, then 04.

## Known gaps

- `cs_clone_agent` cannot take a `profile`; the README setup makes the admin profile the default.
- `cs_list_agents via=pac` reports `solutionId` but not the solution name; step 9 resolves it.
- Uploaded knowledge files are cloned by name and size only; their content is not reviewed.
