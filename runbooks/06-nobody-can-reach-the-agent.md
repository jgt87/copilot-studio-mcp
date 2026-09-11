# 06 Nobody can reach the agent

"It works in the Test pane but users get nothing", "it is not in Teams", "my change is not
showing for users", "Microsoft 365 Copilot does not list it". Four different gates stand
between a draft agent and a user: publish, the channel, the access group, and the tenant
catalogue. This runbook checks them in that order, because each one only matters once the
previous one is open.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then
runbooks/06-nobody-can-reach-the-agent.md for agent "<agent>" in environment "<environment>".
The maker reports: "<symptom, quoted>"; the channel is <Teams / Microsoft 365 Copilot / web /
custom>; an affected user is <upn>. Check publish state, authentication, the access group and
the tenant catalogue, and say which gate is closed.
```

## What you need

- Intake done. `cs_login` cached (drift and Dataverse reads).
- For step 4: `cs_login scope='graph'` and a Microsoft Agent 365 licence (the catalogue is
  Graph, not Power Platform); skip the step without it.

## Steps

### 1. Is it published, and is the published version current? (no writes)

```
cs_check_drift workspace=runbooks/cases/<date>-<agent>/clone mode=quick
```

The result says whether the live agent has **unpublished changes** and when it was last
published. Also `cs_list_agents environmentId=<environment id> via=dataverse` for
`publishedOn`.

- IF never published -> that is the whole answer. Fix note: Publish.
- IF published but with unpublished changes -> the maker's change is in the draft only; the
  Test pane shows the draft, users get the published version. Fix note: Publish.
- IF `cs_status botId=<agent id> environmentId=<environment id>` reports the agent as
  quarantined -> users get a quarantine message by design; runbook 11 says who did it and why.

### 2. Does the channel accept this agent? (no writes; some of it is the portal)

From `clone/settings.mcs.yml`: `authenticationMode`, `accessControlPolicy`,
`configuration.isAgentConnectable`. Channels are environment configuration and are **not** in
the YAML; the maker's Channels page is the source.

| Channel | Requires | Where it goes wrong |
| --- | --- | --- |
| Teams and Microsoft 365 Copilot | `authenticationMode: Integrated`; the agent added to the Teams app store (Channels > Teams > Availability options), and, for "everyone", Teams admin approval of the app | not submitted; submitted but not approved in the Teams admin centre (Teams apps > Manage apps); blocked by a Teams app permission policy |
| web / custom (DirectLine) | published; `None` or `Manual` for anonymous sites, `Integrated` for signed-in ones | the site embeds an old token endpoint; DLP blocks the Direct Line channel (runbook 02) |
| another agent (connected agent) | `configuration.isAgentConnectable: true` | off by default |

- IF Teams and `authenticationMode` is `None` -> Teams will not show it. Fix note: Authenticate
  with Microsoft, republish, resubmit.
- IF the channel needs an admin approval -> that is you: Teams admin centre, or the M365
  admin centre for Microsoft 365 Copilot.

### 3. Who is allowed? (no writes)

`accessControlPolicy` in `settings.mcs.yml`, and the security group set in the portal
(Settings > Security > Access). The group id also appears as `AadGroupId` under
`CopilotAgents` when the solution's deployment settings are generated (runbook 08); an
all-zero id means no group.

- IF a group is set and the user is not in it -> no access, whatever the channel says. Fix
  note: add the user to the group, or remove the restriction.
- IF the agent was imported from another environment -> the group is per environment and may
  be the source environment's group, which means nobody here. Runbook 08 step 5.

### 4. The tenant catalogue (no writes; Graph)

```
cs_list_org_agents workspace=runbooks/cases/<date>-<agent>/clone filter="<agent name>"
cs_get_org_agent workspace=runbooks/cases/<date>-<agent>/clone id=<catalogue id>
```

Record `availableTo`, `deployedTo` and `isBlocked`.

- IF `isBlocked` -> an admin blocked it tenant-wide; nobody sees it in Microsoft 365 no matter
  what the maker does. `cs_block_org_agent id=<id> blocked=false` (dry run, then `confirm`)
  lifts it, after you know why it was blocked (runbook 11).
- IF `deployedTo` is empty -> the channel step (2) was never completed.
- IF the catalogue does not list it at all -> it was never published to a Microsoft 365
  channel; step 2.

### 5. Reproduce from outside (no writes)

```
cs_chat workspace=runbooks/cases/<date>-<agent>/clone utterance="hello"
```

- IF a reply arrives -> the published agent is alive; the closed gate is the channel or the
  group (steps 2-3), not the agent.
- IF a sign-in URL comes back -> Entra SSO; expected for Teams; a web site embedding it needs
  the SSO setup.
- IF nothing or an error -> step 1 (not published) or a quarantine.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| Test pane works, users get nothing / old answers | not published, or draft ahead of published | step 1 | Publish |
| not in Teams | not submitted, or not approved; `None` authentication | step 2 | submit; approve in Teams admin centre; Authenticate with Microsoft |
| not in Microsoft 365 Copilot | not deployed to that channel, or blocked in the catalogue | step 4 `deployedTo` / `isBlocked` | deploy; unblock (dry run, confirm) |
| some users yes, others no | security group | step 3 | group membership |
| every user gets a "this agent is unavailable" message | quarantine | `cs_status` | runbook 11 |
| web site stopped working | token endpoint / DLP on Direct Line | step 5; runbook 02 | re-embed; policy |

## Fix note

Say which gate is closed, who opens it (maker: publish, submit, group; you: Teams or M365
admin approval, catalogue unblock, group membership), and the order: publish first, then
channel, then access. Add that the Test pane always shows the draft, so "it works for me" is
not evidence that users have it.

## Verify

The affected user tries again; `cs_list_org_agents` shows the agent in `deployedTo` and
`isBlocked: false`; `cs_check_drift mode=quick` shows no unpublished changes.

## Known gaps

- Channel configuration is not in the cloned YAML; the maker's Channels page is the source.
- The catalogue tools need a Microsoft Agent 365 licence, are global-cloud only, and are
  unverified against a live tenant; block and unblock exist only on Graph beta.
- Teams admin approval and app permission policies are outside the server; the Teams admin
  centre is the place.
