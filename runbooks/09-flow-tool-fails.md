# 09 A flow tool fails at runtime

"The agent says something went wrong", "the action failed", "the flow runs fine in Power
Automate but not from the agent". The agent only ever sees "failed"; the reason is in the flow:
its state, its owner's connections, the shape of what the agent passed in, or how long it took.
This runbook goes from the tool to the flow to the run.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then runbooks/09-flow-tool-fails.md
for agent "<agent>" in environment "<environment>". The failing tool is "<tool name>"; the
question that triggers it is "<utterance>". Find the flow, check its state, owner and
connections, read its recent failed runs, and say which of the causes in the diagnosis table
it is. Do not start a run or change a flow's state without showing me the dry run.
```

## What you need

- Intake done; `actions[]` in `intake.md` gives the tool's `flowId`.
- `cs_login` for the flow rows; `cs_login scope='flow'` for run history (a separate consent),
  and the signed-in account must own or co-own the flow to read runs.

## Steps

### 1. The tool and the flow (no writes)

From `intake.md`: the tool's `flowId`, its inputs, its description. Then:

```
cs_get_flow flowId=<flow id> environmentId=<environment id>
```

Record: `state`, owner, the trigger type, the trigger's input schema, the response action's
outputs, and the flow's connection references.

- IF the trigger is not the "when an agent calls the flow" kind -> the agent cannot call it as
  a tool; the maker rebuilt or re-pointed the flow. Fix note: recreate from Tools > New agent
  flow.
- IF the tool's inputs do not match the trigger's inputs by name and type -> the agent sends
  values the flow does not read, or omits required ones. Record the two lists side by side.

### 2. State and owner (no writes)

```
cs_list_flows environmentId=<environment id> search="<flow name>"
```

- IF `state` is `Draft` or `Suspended` -> it will not run. Suspended usually means a
  connection broke or a policy changed. Turn it on after step 3:
  `cs_set_flow_state flowId=<id> environmentId=<environment id> state=on` (dry run, then
  `confirm`), or the maker does it in Power Automate.
- IF the owner is not the maker -> the flow runs under the **owner's** connections; if the
  owner left or their connection expired, every call fails for everyone. Fix note: the owner
  re-authorises, or ownership moves (Power Automate > flow > Share / owner).

### 3. Connections (no writes)

```
cs_list_connections environment=<environment id>
```

For every connection reference the flow uses (step 1): is there a connection, is it the
owner's, and is its status healthy?

- IF a reference is unbound -> the flow cannot start; bind it in Power Automate (Edit >
  connection) or, for a solution flow, in the connection reference (Solutions > ... >
  Connection references).
- IF the connection exists but the connector is now Blocked or split by a policy -> runbook
  02; the flow will show as Suspended.

### 4. The runs (no writes; needs the flow scope)

```
cs_list_flow_runs flowId=<flow id> environmentId=<environment id>
cs_get_flow_run flowId=<flow id> runId=<run id> environmentId=<environment id>
```

The list gives status and start time per run; the detail names the action that failed and
its error code.

- IF the failed action is the trigger -> the flow never ran; the fault is the trigger's
  connection or the input shape (step 1), not the logic.
- IF the failed action is a connector step -> the connector's error is in that action's
  outputs, behind a link that expires after days; open the run in Power Automate while it is
  recent (Run history > the run > the red step) and copy the message into the note.
- IF there are no failed runs at all -> the agent never reached the flow: the tool was not
  chosen (runbook 01, tool description), the flow is off (step 2), or the reference is unbound
  (step 3).
- IF runs succeed but take longer than about a minute and a half -> the agent gave up
  waiting; the flow must answer faster (respond first, do the slow work after the response
  action) or be split.

### 5. Reproduce (dry run, then confirm; only for manual triggers)

```
cs_run_flow flowId=<flow id> environmentId=<environment id> triggerName=manual payload=<json matching the trigger>
```

Starts a run outside the agent with a known payload, which separates "the flow is broken"
from "the agent sends the wrong thing". Agent-trigger flows are started by the agent only;
for those, `cs_chat utterance="<the utterance>"` and read the run that appears in step 4.

### 6. Record

Flow id, state, owner, connection status, the failing action and its error, and the
tool-versus-trigger input comparison.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| every call fails at once | flow off, or unbound reference | step 2 state; step 3 | turn on; bind |
| fails since a date | owner's connection expired or owner left; policy change | step 2 owner; step 4 trigger failure; runbook 02 | re-authorise; reassign; policy |
| fails for one kind of question | input mismatch (missing required, wrong type) | step 1 comparison; step 4 trigger error | align tool inputs with the trigger; `cs_edit_tool` shows the input fields |
| "something went wrong" after a pause | timeout | step 4 duration | respond early; split the flow |
| works in Power Automate's test, not from the agent | the test used the maker's connection, the agent uses the owner's; or the agent never picked the tool | step 2; runbook 01 | ownership; tool description |
| fails only for some users | a connection that runs as the user (Dataverse, SharePoint) and the user lacks access | run detail user context | permissions on the data, not the flow |

## Fix note

Name the flow, the failing step and the error text verbatim, then the change with its place:
Power Automate (turn on, fix connection, owner) or Copilot Studio (tool inputs, description).
Add the two habits: keep agent flows owned by a service account or a co-owned group, not one
person; and make the flow respond within the agent's wait, doing slow work after the response.

## Verify

`cs_chat` with the utterance shows the tool as used; `cs_list_flow_runs` shows a new
succeeded run; runbook 04's behaviour test (`usedTool`) keeps it that way.

## Known gaps

- The connector's error message is not in the run summary the server reads; the next release
  adds tools that fetch it, diff a failed run against a successful one, and summarise failure
  rates. Until then the Power Automate run page is the place.
- Run history needs the flow-service consent (`cs_login scope='flow'`) and owner or co-owner
  rights; the endpoints are unverified against a tenant.
- Whether a flow's trigger is the agent kind is read from its definition by name; a renamed
  trigger looks like a different kind.
