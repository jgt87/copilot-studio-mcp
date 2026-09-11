# 03 Components outside the solution

The maker built a flow, a connection reference, an environment variable or the agent itself
outside their solution - usually in the Default solution, because that is where things land
when nothing else is selected. The agent's tool picker does not offer the flow, the export is
missing pieces, or the tool arrives unconnected in the next environment. This runbook finds
which components the agent depends on, proves which solution holds each one, and moves them
into the agent's solution.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then
runbooks/03-components-outside-the-solution.md for agent "<agent>" in environment
"<environment>". The maker reports: "<symptom, quoted>". Inventory the agent's solution, list
every flow, connection reference and environment variable the agent depends on, prove each
one's solution membership with cs_env_fetch and the FetchXML templates, and propose one
cs_add_solution_component call per missing component. Show me each dry run; I approve them one
at a time.
```

## What you need

- Intake done, with the agent's `solutionId` and the solution unique name from intake step 9.
- The admin pac profile (export and FetchXML run through pac).
- `runbooks/templates/*.fetch.xml`; copy the one you need into the case folder before editing
  the `OBJECT_ID` placeholder.

## Steps

### 1. Which solution is the agent in? (no writes)

From `intake.md`: the agent's solution unique name.

- IF it is `Default` -> the agent itself is outside a maker solution. Go to step 6 option A.
- IF the maker names a different solution than the one the agent is in -> they have two, and
  the components are split between them. Inventory both in step 2.

### 2. What the solution contains (no writes to the environment; exports to disk)

```
cs_describe_solution name=<solution unique name> environment=<environment id> workDir=runbooks/cases/<date>-<agent>/outputs/solution
```

Record: `agents[]`, `flows[]` (name, workflowId, state), `connectionReferences[]`
(logicalName, connectorId), `environmentVariables[]` (schemaName), and
**`missingDependencies`**. A count above zero means the solution references something it does
not contain; that is the export/import symptom.

### 3. What the agent depends on (no writes)

From `intake.md` / `cs_describe_workspace`:

| Dependency | Where it shows in the workspace | Must appear in step 2 as |
| --- | --- | --- |
| a flow used as a tool | `actions[]` with `flowId`; `workflows/` | `flows[]` with that `workflowId` |
| a connector / MCP / prompt tool's connection | `connectionReferences[]` logical names | `connectionReferences[]` with that `logicalName` |
| a variable a flow reads | `cs_get_flow flowId=<id> environmentId=<environment id>` shows the flow's connection references; environment variables appear in its definition as `parameters('<schema name> (<id>)')` | `environmentVariables[]` with that `schemaName` |

Fill a table: dependency, id or schema name, in the solution (yes / no).

- IF a flow the maker talks about is not in `actions[]` at all -> the agent never got it as a
  tool; the picker did not offer it because it is not in a solution (Copilot Studio offers
  solution-aware flows only). Find it in step 4 by name.

### 4. Find the ids (no writes)

Flows, by name, with owner and state:

```
cs_list_flows environmentId=<environment id> search="<flow name>"
```

- IF the owner is someone other than the maker -> the maker cannot add it to their solution
  either; the owner must share it or the fix note goes to the owner.
- IF state is `Draft` / not activated -> it will not run even once added; note it.

Connection references and environment variables, with their ids:

```
cs_env_fetch environment=<environment id> xmlFile=runbooks/templates/connection-references.fetch.xml
cs_env_fetch environment=<environment id> xmlFile=runbooks/templates/environment-variables.fetch.xml
```

### 5. Prove the membership (no writes)

For each dependency marked "no" in step 3, copy `templates/solution-membership.fetch.xml` to
the case folder, replace `OBJECT_ID` with the id, and run:

```
cs_env_fetch environment=<environment id> xmlFile=runbooks/cases/<date>-<agent>/outputs/membership-<name>.fetch.xml
```

Read the `sol.uniquename` rows. Every component is in `Active`; most are also in `Default`.

- IF only `Active` / `Default` -> not in any maker solution: add it (step 6).
- IF in another maker solution -> it belongs to a different solution; adding it to this one is
  still right (a component can be in several unmanaged solutions), but say so in the note.
- IF in a **managed** solution (`sol.ismanaged` true) -> it came from an import; it cannot be
  edited here, and adding it is rarely the fix. Stop and read the maker's symptom again.

### 6. The fix

**Option A - the agent is in Default.** Create a solution for the maker (dry run, then
confirm), then add the agent and its components to it:

```
cs_create_solution uniqueName=<prefix>_<Name> publisherPrefix=<prefix> environment=<environment id>
cs_create_solution uniqueName=<prefix>_<Name> publisherPrefix=<prefix> environment=<environment id> confirm=true
cs_add_solution_component environment=<environment id> solutionName=<prefix>_<Name> component=<agent schema name> componentType=bot addRequiredComponents=true
```

**Option B - components outside the agent's solution.** One call per component, dry run
first, then again with `confirm=true` after the user agrees. Never batch approvals.

```
cs_add_solution_component environment=<environment id> solutionName=<solution unique name> component=<workflowId or schema name> componentType=29 addRequiredComponents=true
```

| Component | `componentType` |
| --- | --- |
| cloud flow (workflow) | `29` |
| connection reference | `10088` |
| environment variable definition | `380` (its value is `381`; `addRequiredComponents` brings it) |
| the agent (bot) | the name `bot` - pac accepts the type name as well as the code |

`addRequiredComponents=true` pulls in what the component needs (a flow's connection
references, a variable's value), which is what leaves `missingDependencies` at zero.

Or the maker does it: Power Apps maker portal > Solutions > their solution > **Add existing** >
Automation > Cloud flow (or More > Connection reference / Environment variable) > tick > Add,
choosing "include required components".

### 7. Confirm (no writes to the environment)

Run step 2 again. The dependency table from step 3 should be all "yes" and
`missingDependencies` zero. IF a flow was the missing tool -> the maker can now add it under
Tools > Add a tool > Flow.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| "my flow is not in the tool list" | flow not solution-aware / not in a solution | step 5: only `Active`/`Default` | add to the solution (29), or maker re-creates it from Tools > New agent flow |
| "the flow is there but somebody else's" | owner is another user | step 4 owner | owner shares it or adds it |
| export / import fails or `missingDependencies > 0` | connection reference or variable outside the solution | step 2 count; step 5 | add (10088 / 380) with required components |
| tool arrives unconnected after deploy | connection reference missing from the solution, so the deployment settings could not map it | step 2, `cs_create_deployment_settings` output | add the reference, redeploy |
| agent in Default | created without selecting a solution | intake solutionId = Default | option A |
| everything is present but the picker still hides the flow | flow is Draft / off | step 4 state | maker turns it on (`cs_set_flow_state` if you do it: dry run, confirm) |
| the flow is not in `cs_list_flows` at all | a legacy non-solution flow: not a modern (category 5) `workflow` row, so it cannot be added to a solution | step 4 finds nothing by name; Power Automate shows it under My flows | maker recreates it inside the solution (Save as, into the solution) and re-adds the tool |

## Fix note

Say which components moved (or must move), into which solution, and who did it. Then the two
habits that stop it recurring, for the maker: set their solution as the **preferred solution**
in the maker portal (Solutions > the solution > ... > Set preferred solution) so new flows and
variables land there; and create agent flows from inside the agent (Tools > Add a tool > New
agent flow) rather than from Power Automate's home page. If the environment is the maker's
Developer environment, add that production needs a solution export
(`cs_pull_solution` / `cs_deploy_solution`, runbook solutions in `cs_guide`).

## Verify after the change

`cs_describe_solution` again (step 7). For a flow, the maker confirms it appears under Tools >
Add a tool. For an export problem, `cs_pull_solution` on the solution and read
`missingDependencies` in `solution.json`.

## Known gaps

- `cs_list_flows` has no solution column and nothing in the server answers "which solution
  holds this component"; the FetchXML templates are the lookup. A `cs_solution_membership
  component=` tool would replace steps 4-5.
- `componentType=bot` by name is what pac documents (code or name); if pac refuses the name,
  the dry run says so and the code can be read from `solutioncomponent.componenttype` in the
  step 5 output for an agent that is in a solution.
- The export in step 2 is unmanaged; a managed solution in a downstream environment cannot be
  exported - inventory it in its source environment instead.
- `cs_env_fetch` returns pac's text table, not JSON; read the `sol.uniquename` column by eye.
