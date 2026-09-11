# 11 Take an agent offline now

An incident: an agent is answering with data it should not, behaving in a way that has to stop,
or was built by someone who should not have. The order is stop, then evidence, then contain,
then investigate; every stop is reversible and every step that changes the environment is a
dry run first. The incident is also the one time the transcripts are read in full, and they are
customer data.

## Prompt

```
<preamble from README.md>

Run runbooks/11-take-an-agent-offline.md for agent "<agent>" in environment "<environment>".
The reason: "<what was reported, quoted>". Find the agent, show me the quarantine dry run
first, and only after I confirm continue with the evidence steps. Do not delete anything.
```

## What you need

- The admin profile active. For step 3 (tenant catalogue), `cs_login scope='graph'` and an
  Agent 365 licence; for step 4, `cs_login` (Dataverse).
- A case folder; everything from this runbook stays in it, and it holds customer data from
  step 4 onwards.

## Steps

### 1. Identify (no writes)

Intake steps 2 and 3 only: environment id, agent id, schema name, owner. Then the reach:

```
cs_list_org_agents workspace=runbooks/cases/<date>-<agent>/clone filter="<agent name>"
```

`deployedTo` and `availableTo` say who could be affected; record them before anything
changes.

### 2. Stop it (changes the environment: dry run, then confirm)

```
cs_quarantine_agent botId=<agent id> environment=<environment id> quarantine=true
cs_quarantine_agent botId=<agent id> environment=<environment id> quarantine=true confirm=true
```

A quarantined agent stops answering in every channel and tells users it is unavailable; the
maker can still open it. Reversible with `quarantine=false`. This is the fastest stop and the
first one.

- IF the agent is in the Microsoft 365 catalogue and must vanish from Microsoft 365 Copilot
  and Teams discovery as well:

```
cs_block_org_agent workspace=runbooks/cases/<date>-<agent>/clone id=<catalogue id> blocked=true
cs_block_org_agent workspace=runbooks/cases/<date>-<agent>/clone id=<catalogue id> blocked=true confirm=true
```

Tenant-wide, every user at once; reversible with `blocked=false`.

### 3. Evidence (writes to disk only)

Before anyone edits the agent, keep what it is:

```
cs_clone_agent bot=<agent id> environment=<environment id> outputDir=runbooks/cases/<date>-<agent>/clone
cs_describe_workspace workspace=runbooks/cases/<date>-<agent>/clone
```

Instructions, knowledge sources (which sites, which files), tools (which connectors, which
flows), authentication mode and access group, as they were. Then who built and changed it:
runbook 07 step 1 (`templates/bot-components-modified.fetch.xml`) and
`cs_list_agents environmentId=<environment id> via=dataverse` for owner and publish dates.

### 4. What it said (no writes; customer data)

```
cs_summarize_transcripts workspace=runbooks/cases/<date>-<agent>/clone days=30
cs_list_transcripts workspace=runbooks/cases/<date>-<agent>/clone days=30 search="<term from the report>"
cs_get_transcript workspace=runbooks/cases/<date>-<agent>/clone transcriptId=<id>
```

How many sessions, what was asked, which tools fired, and the sessions that match the
report. Copy only what the investigation needs into the notes; the rest stays in Dataverse.

### 5. Contain (portal, and one optional tool)

- Channels: remove the agent from Teams / web / Microsoft 365 Copilot in the maker's Channels
  page if the quarantine must outlast the investigation.
- Connections: a connector connection the agent used can be revoked by its owner in Power
  Automate > Connections; `cs_delete_connection` covers service-principal Dataverse
  connections only (dry run, confirm).
- Access: narrow the security group (Settings > Security > Access) if the agent will come back
  for a smaller audience.
- Deleting the agent (`cs_delete_agent`, dry run then confirm) is irreversible and destroys
  the evidence; not during the incident.

### 6. Investigate, then decide

The evidence usually lands in one of the other runbooks: instructions that allowed it (01),
a knowledge source that exposed more than intended (05, and the source's own permissions), a
tool that should not exist or a connector that policy should have blocked (02), an agent
outside any solution or governance (03, 10).

### 7. Restore (changes the environment: dry run, then confirm)

After the fix is applied and verified (the runbook's own verify step, on a clone):

```
cs_quarantine_agent botId=<agent id> environment=<environment id> quarantine=false
cs_block_org_agent workspace=runbooks/cases/<date>-<agent>/clone id=<catalogue id> blocked=false
```

Each as a dry run first.

## Decision table

| Situation | Use | Reach | Reversible |
| --- | --- | --- | --- |
| stop it answering, now | quarantine | every channel of this agent | yes |
| hide it from Microsoft 365 discovery | catalogue block | tenant-wide | yes |
| stop one data path | revoke that connection / remove the knowledge source | that tool or source | yes (re-authorise) |
| stop it for a subset of users | access group | the group | yes |
| remove it for good | delete | everything, including evidence | no |

## Fix note

This one is for the record, not the maker: what was reported, when it was stopped and how,
what the evidence showed (with the case folder path), what changed before it came back, and
who approved each step. The maker's part, if any, comes from the runbook the investigation
pointed at.

## Verify

`cs_chat` returns the unavailable message while quarantined and a normal reply after step 7;
`cs_list_org_agents` shows `isBlocked` matching the intended state.

## Known gaps

- Quarantine is a pac command and unverified in this server against a live tenant; read the
  output text, pac can report failure and exit zero.
- The catalogue block needs the Agent 365 licence and Graph beta; without it, quarantine is
  the whole stop.
- Channel removal and connection revocation are portal steps; the server does not do them.
- Transcript outcomes are this server's reading of the sessions, not a platform verdict.
