# 02 DLP: a connector or knowledge source is blocked or refused

The maker cannot add a connector, a knowledge source is refused, a tool that used to work
stopped when they added another, or "Connect" fails with a policy message. A data loss
prevention policy is deciding this, and the maker cannot see which one. This runbook lists the
connectors the agent uses and the one the maker wants, reads every policy that applies to the
environment, and names the policy, the group and the rule that is refusing.

Two rules do all the refusing:

- A connector in the **Blocked** group cannot be used at all.
- Connectors in **Business** and **Non-business** cannot be combined in one agent or one flow.
  The agent's tools and knowledge sources count together, so adding a Non-business connector to
  an agent whose sources are Business is refused, and the message blames the newcomer.

When several policies apply to an environment, the strictest reading wins: a connector blocked
by any of them is blocked, and a combination must be allowed by every one of them.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then
runbooks/02-dlp-blocked-connector-or-knowledge.md for agent "<agent>" in environment
"<environment>". The maker reports: "<symptom, quoted>"; the connector or knowledge source they
want is "<name>". Build the connector table, read every DLP policy that applies to the
environment (save each cs_admin_show_dlp_policy output to outputs/dlp/<policy id>.txt), fill in
the group per connector and policy, and say which policy and rule refuses, or that none does.
```

## What you need

- Intake done. `intake.md` lists the knowledge sources, actions and connection references.
- The admin profile (`profile=admin` on every `cs_admin_*` call).
- `outputs/dlp/` in the case folder.

## Steps

### 1. What the agent uses, as connector ids (no writes)

**The question:** which connectors does this agent already combine, and which one is new?

From `intake.md` (or `cs_describe_workspace` again), fill the table. Connection references
carry the id directly (`connectorId`, `shared_...`). Knowledge sources and channels imply one:

| Agent feature | DLP connector to look for |
| --- | --- |
| tool with a connection reference | its `connectorId` |
| SharePoint knowledge | `shared_sharepointonline` |
| Dataverse knowledge or tool | `shared_commondataserviceforapps` |
| Graph connector knowledge | the Copilot Studio virtual connector for Graph / Microsoft 365 knowledge |
| public website knowledge | the Copilot Studio virtual connector for public-website knowledge |
| `authenticationMode: None` | the Copilot Studio virtual connector for chat without Entra authentication |
| a channel (web, Direct Line, Teams, Microsoft 365 Copilot) | the Copilot Studio virtual connector for that channel |
| an MCP server tool | the connector that fronts it (`connectorId` in the reference) |

Copilot Studio ships those virtual connectors into DLP; their display names contain
"Copilot Studio". The exact names are read from the policy output in step 3, not assumed.

For the connector the maker wants:

```
cs_list_connectors environmentId=<environment id> search="<name>"
```

Record its `shared_` id. IF it is not listed -> it is not enabled in this environment at all,
which is a different answer (custom connector not shared, or a preview connector); say so.

| Connector id | Used by (tool / knowledge / channel / wanted) | Group per policy (fill in step 4) |
| --- | --- | --- |
| | | |

### 2. The policies in the tenant (no writes)

```
cs_admin_list_dlp_policies profile=admin
```

Save the output as `outputs/dlp/list.txt`. Record every policy **name** and **id**.

### 3. Each policy in full (no writes)

For every policy id:

```
cs_admin_show_dlp_policy policyName=<policy id> profile=admin
```

Save each as `outputs/dlp/<policy id>.txt`. The output is pac's own text (no JSON option in
pac 2.11.2). Read four things from it and write them down:

1. **Scope**: does it apply to all environments, only to listed ones, or to all except listed
   ones - and is our environment id in the list? A policy that does not cover the environment
   is out; note it and move on.
2. **Groups**: which connectors are in Business, Non-business and Blocked. Search the text for
   each id from the step 1 table, and for "Copilot Studio" to find the virtual connectors.
3. **Default group**: where a connector goes when no policy lists it explicitly. A connector on
   the table that appears in no group takes this one.
4. **Connector-level rules**, if the policy has them: blocked actions on a connector, endpoint
   filtering (allowed URLs for HTTP or SQL connectors). A tool can be allowed at the connector
   level and still refused at the action or endpoint level.

**First time only:** copy one `show` output to `runbooks/samples/dlp-show.txt` and note below,
in this runbook, the headings pac uses for scope, groups and default group, so the next read is
a lookup rather than a search.

### 4. Apply the two rules (no writes)

Fill the group column of the step 1 table, one entry per policy that covers the environment.

- IF the wanted connector is **Blocked** in any covering policy -> that is the refusal. Record
  policy and group.
- IF the wanted connector is in a different group from any connector the agent already uses
  (Business vs Non-business), in any covering policy -> the combination is refused. Record the
  policy and the pair (wanted connector, existing connector).
- IF the wanted connector is unlisted and the default group differs from the agent's existing
  group -> same as above; say it is the default-group rule.
- IF a connector already in use has become Blocked -> that explains "it worked until ..."; a
  policy changed, not the agent. `cs_admin_list_dlp_policies` shows modified dates when pac
  prints them; otherwise the admin centre's policy history.
- IF no covering policy blocks or splits anything -> DLP is not the cause. Check, in order:
  the connector is not enabled in the environment (step 1); the tool has no connection yet
  (`connectionId: null` in the workspace, and `cs_list_connections environment=<environment id>`
  shows whether the maker owns a connection for that connector at all - if one exists it is a
  binding problem: Tools > tool > Connect); the maker lacks a licence or permission for that
  connector; a managed-environment rule (`cs_admin_list_environment_groups profile=admin` shows
  the group and its rules).

### 5. Record

In `intake.md` or a `dlp.md` next to it: the covering policies, the filled table, the refusing
rule in one sentence, and the two possible fixes from the next section.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| "cannot add connector X" | X is Blocked in policy P | `outputs/dlp/<P>.txt`, X under Blocked, P covers the environment | policy exception, or a different connector |
| "adding X breaks / is refused because of Y" | X and Y are in different groups | the table, two groups in one covering policy | move X or Y in the policy, or isolate X in a flow with its own connections |
| "public website knowledge refused" | the Copilot Studio public-website virtual connector is Blocked | the `show` text, the "Copilot Studio" entry | policy exception, or SharePoint / uploaded files instead |
| "cannot publish to channel Z" / "authentication None refused" | the matching Copilot Studio virtual connector is Blocked | same | policy exception, or switch the setting |
| the tool is there but says not connected | no DLP rule at all; nobody clicked Connect | `connectionId: null`, no refusing rule | maker: Tools > tool > Connect |
| connector absent from `cs_list_connectors` | not enabled or not shared into this environment | step 1 | enable / share the connector; not a DLP change |

## Fix note

The fix is a decision, and two of the three options are yours, not the maker's:

1. **Policy exception** (you): "move `<connector>` to `<group>` in policy `<name>`, scope
   `<environment>`", or a new policy for that environment only. Made in the Power Platform
   admin centre; there is no tool for it here, on purpose - DLP changes affect every maker in the
   scope. Say in the note whether you will do it, and when.
2. **Different design** (maker): a connector already in the agent's group that reaches the same
   data; SharePoint or uploaded files instead of a public site; a cloud flow that uses the
   Non-business connector on its own (a flow is its own DLP scope) and returns the result to
   the agent as a tool.
3. **Not DLP** (maker): connect the tool, or ask for the connector to be enabled.

Quote the policy name, the group, and the sentence from step 4 as the evidence.

## Verify after the change

- Policy changed: `cs_admin_show_dlp_policy policyName=<id> profile=admin` again and confirm
  the group; then the maker retries adding the connector or source.
- Design changed: clone again; `cs_describe_workspace` shows the new tool with a
  `connectionId` once the maker connected it; `cs_validate` clean.

## Known gaps

- The whole read is manual: pac prints the policy as text and the server has no parser or
  connector-to-group lookup. A `cs_admin_check_dlp` tool that takes connector ids and an
  environment and returns the refusing rule would replace steps 3-4.
- Knowledge sources and channels map to Copilot Studio's virtual DLP connectors by name; the
  names are read from the output, not from a list the server carries.
- `cs_backup_tenant` saves the same outputs for every policy (first 50) under
  `tenant/dlp-policies/`; when a backup is recent, read from there instead of re-running.
