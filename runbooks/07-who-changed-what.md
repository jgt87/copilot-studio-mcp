# 07 Who changed what

"Someone changed my agent", "my push is refused with a conflict", "the topic is different from
what I wrote", "we need a history of this agent". Every portal edit lands in Dataverse rows with
a modified-on stamp and the user who made it, and the server reads those rows: for the past,
straight from the tables; going forward, against a sync stamp so a change shows up as drift
before anyone pushes over it.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then runbooks/07-who-changed-what.md
for agent "<agent>" in environment "<environment>". The maker reports: "<symptom, quoted>",
concerning <component name> around <date>. List every component changed since <date> with who
and when, and, if the maker has their own workspace at <path>, run the drift check against it.
```

## What you need

- Intake done. For step 1, pac only. For steps 2-3 the maker's own workspace (a clone they
  have been pushing from) and `cs_login`.

## Steps

### 1. The record: who touched which component, when (no writes)

Copy `templates/bot-components-modified.fetch.xml` into the case folder, replace `BOT_ID` with
the agent id from intake, and run:

```
cs_env_fetch environment=<environment id> xmlFile=runbooks/cases/<date>-<agent>/outputs/modified.fetch.xml
```

One row per topic, knowledge source, tool, trigger and variable, newest first, with
`modifiedby` and `modifiedon`. The agent row itself (instructions, settings) comes from
`cs_list_agents environmentId=<environment id> via=dataverse` (`modifiedOn`, `publishedOn`,
owner).

- IF the change the maker describes has a `modifiedby` other than the maker -> that is the
  answer; record name, component and time.
- IF `modifiedby` is the maker at a time they did not edit -> a push from a workspace (theirs or
  a colleague's clone of the same agent), or a solution import. Step 2 tells which.
- IF the row is missing -> the component was deleted; the fetch does not see deleted rows. The
  maker's last clone or `cs_check_drift mode=full` (step 3) shows what is gone.

### 2. Going forward: drift against a stamp (no writes)

If the maker works from a workspace (`cs_clone_agent`, the VS Code extension or pac), it
carries `.mcs/cs-sync.json` from its last clone, pull or push. Against that:

```
cs_check_drift workspace=<the maker's workspace> mode=quick
```

Modified, added and removed components since their last sync, by whom and when, whether the
agent settings changed, and whether the live agent has unpublished changes. A component that
also changed locally is a **conflict**.

- IF the maker has no workspace -> the case clone from intake is the baseline from now on;
  the maker gets a clone of their own (fix note) and the next question has a stamp to answer
  against.
- IF the stamp has no per-component baseline (no Dataverse sign-in at sync time) -> the check
  falls back to the sync time with a two-minute margin; say so when the timings are close.

### 3. The exact content (no writes to the environment)

```
cs_check_drift workspace=<the maker's workspace> mode=full includeDiffs=true
```

Clones into a temporary folder and classifies every file: `local-modified`,
`remote-modified`, `both-modified`, added or deleted on either side, with unified diffs. Use
it when the maker wants to see the change, or when something was deleted.

### 4. The refused push (no writes)

`cs_push` runs the quick check in its dry run and is refused when a portal change and a local
edit touch the same component. The way through is in this order:

1. `cs_pull workspace=<the maker's workspace>` - pac's three-way merge brings the portal change
   into the files; conflicts are marked in the files.
2. Resolve, `cs_validate`, then `cs_push` again with `confirm`.
3. `force: true` overwrites the portal version; only when the maker has seen the diff from
   step 3 and means it.

### 5. Record

Who, what, when from step 1; the drift summary from step 2; and whether the change was a
person in the portal, a push from a workspace, or an import.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| "someone changed my topic" | a colleague edited in the portal | step 1 `modifiedby` | agree who owns the agent; git as the ledger (below) |
| "it changed by itself" | a push from another clone, or a solution import | step 1 timing; step 2 shows remote changes the maker did not make | one workspace per maker; imports announced |
| push refused | a portal change collides with a local edit | `cs_push` dry run | step 4 |
| "my knowledge source is gone" | deleted in the portal | step 1 row missing; step 3 `deleted` | restore from the maker's last clone (`cs_add_knowledge_source` from the file) and push |
| two makers overwrite each other | both push from stale clones | step 2 conflicts on both sides | pull before every push; the drift check in the push dry run does the reminding |

## Fix note

The list from step 1, plainly: component, who, when. Then the habit that ends the question:
keep the agent as a cloned workspace in a git repository, commit after every `cs_pull`, and
read `cs_check_drift` before pushing. Portal drift then shows up as a diff, accepting it is a
commit, and rejecting it is a push of the local version. If the maker does not use a
workspace, the case clone is the record from today, and the note says where it is.

## Verify

After the maker's next pull, `cs_check_drift mode=quick` on their workspace reports no drift
and no conflicts; after their next push, the portal shows their version and step 1 shows their
name on the row.

## Known gaps

- The quick check does not see connections, uploaded knowledge files, channel configuration or
  the security group; the full check covers uploaded files, not the rest.
- Deleted components are invisible to the fetch; only a clone or the full check shows them.
- Which solution import changed a row is not on the row; the import history in the maker
  portal (Solutions > History) is the place.
