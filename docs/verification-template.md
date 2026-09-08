# Live verification results

- Date:
- Environment type (dev / test / prod):
- pac version:
- Server commit (`git rev-parse --short HEAD`):
- Phases attempted:

Paste the full JSON result under each heading. For each, add one line: **matched** / **differed**
/ **not run**, and if it differed, what actually happened. Leave a heading empty if you skipped it;
empty is a result too.

---

## Phase A — Read-only reconnaissance

### A1 cs_init
```json
```
Verdict:

### A2 cs_list_environments
```json
```
Verdict:

### A3 cs_list_agents
```json
```
Verdict:

### A4 cs_list_connectors (source: live registry or seed?)
```json
```
Verdict:

### A5 cs_describe_connector
```json
```
Verdict:

### A6 cs_list_solutions
```json
```
Verdict:

### A7 cs_list_flows
```json
```
Verdict:

### A8 cs_list_connections (paste the raw pac output tail as well)
```json
```
```text
```
Verdict:

---

## Phase B — Clone a real agent

### B1 cs_clone_agent
```json
```
Verdict:

### B2 cs_describe_workspace
```json
```
Verdict:

### B3 Workspace folder listing
```text
```
Which of actions/ tools/ workflows/ knowledge/ trigger/ variables/ exist:

### B4 A portal-made connector tool (actions/*.mcs.yml)
```yaml
```

### B5 A portal-made flow (workflows/<name>/*)
```json
```

### B6 Evaluation test sets present as YAML?
Yes / No. Filenames and kinds found:

### B7 cs_validate on the cloned workspace
```json
```
Verdict (any error here is a validator false positive):

---

## Phase C — Drift detection

### C1 cs_check_drift quick (baseline)
```json
```
Are modifiedBy values names or GUIDs:

### C2 What I changed in the portal
```text
```

### C3 cs_check_drift quick (after the portal edit)
```json
```
Verdict:

### C4 cs_check_drift full
```json
```
Verdict:

### C5 cs_push dry run with a conflict present
```json
```
Did it refuse:

---

## Phase D — Conversation transcripts

### D1 cs_list_transcripts (redact message text)
```json
```
Verdict (if it errored, paste the error verbatim):

### D2 cs_get_transcript — are topic and tool populated?
```json
```
topic populated: yes / no / sometimes
tool populated: yes / no / sometimes
If both are always null, paste one redacted raw activity object here:
```json
```

### D3 cs_summarize_transcripts
```json
```
Verdict:

### D4 Portal Analytics page, same agent and window
```text
```
Agreement with D3:

### D5 cs_test_set_from_transcripts
```json
```
Verdict:

---

## Phase E — Authoring round trip (writes)

### E1 cs_create_agent dry run
```json
```
### E2 cs_create_agent with confirm
```json
```
### E3 cs_describe_workspace
```json
```
### E4 cs_add_topic
```json
```
### E5 cs_add_knowledge_source
```json
```
### E6 cs_update_agent
```json
```
### E7 cs_validate
```json
```
### E8 cs_push with confirm
```json
```
### E9 Portal check — is the topic and knowledge actually there?
```text
```
### E10 cs_publish with confirm (how long did the poll take?)
```json
```
### E11 cs_chat (which transport was chosen?)
```json
```

---

## Phase F — Evaluations (writes)

### F1 cs_create_test_set_csv
```csv
```
### F2 Portal import — did the CSV format import cleanly?
```text
```
### F3 cs_list_test_sets
```json
```
### F4 cs_run_evaluation with confirm
```json
```
### F5 cs_get_evaluation_run — paste the raw metric status values
```json
```

---

## Phase G — Solution ALM (writes)

### G1 cs_pull_solution
```json
```
### G2 cs_describe_solution
```json
```
### G3 cs_create_deployment_settings
```json
```
### G4 cs_list_connections (target environment)
```json
```
### G5 cs_deploy_solution with confirm
```json
```
### G6 Target portal check — flows off? tools connected?
```text
```

---

## Anything that surprised me

Errors, wrong hints, confusing tool descriptions, anything that took longer than it should have.
This section is worth as much as the JSON above.

```text
```

## Cleanup done

- [ ] zzVerifyAgent deleted
- [ ] verification solution deleted (source)
- [ ] verification solution deleted (target)
