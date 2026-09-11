# 04 No evaluations: the agent has no tests

The agent has no test set, so every change is checked by users. This runbook stands up the two
checks the server supports: an Evaluation test set in the portal (Copilot Studio's own, needs
one manual import) and a conversation-test file that runs from here after every publish. Run
it after the runbook that fixed the symptom, so the first test set already covers the case
that brought the maker in.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then runbooks/04-no-evaluations.md
for agent "<agent>" in environment "<environment>". Build the evaluation CSV (from transcripts
if the agent is published and used, otherwise from the workspace), write the conversation-test
file with three kinds of test including the question from this case, and give me the import
steps. Run the evaluation only after I confirm the import is done.
```

## What you need

- Intake done; `cs_login` cached (`cs_list_test_sets`, `cs_run_evaluation` and transcripts use
  the MSAL token).
- For transcripts: the agent published and used.
- The failing question from the case, if there was one, with the intended answer, topic or tool.

## Steps

### 1. Confirm there is nothing (no writes)

```
cs_list_test_sets workspace=runbooks/cases/<date>-<agent>/clone
```

- IF a test set exists -> `cs_list_evaluation_runs workspace=runbooks/cases/<date>-<agent>/clone`.
  IF runs exist, read the last one with `cs_get_evaluation_run` (step 7); the maker may not
  know it is there. IF none, skip to step 6 and run it.

### 2. Review first (no writes)

The evaluations guide's rule: a wrong answer is almost always instructions that do not say how
to answer, a knowledge source the signed-in user cannot reach, a tool description that does not
say when to use it, or two topics sharing a phrase. `cs_review_agent` (intake step 6) finds all
four without running anything. Fix those through runbook 01 before measuring, or the first run
only counts them.

### 3. Build the test set (writes to the case folder only)

**The question:** what should the agent be asked, and what is the right answer?

IF the agent is published and people use it:

```
cs_summarize_transcripts workspace=runbooks/cases/<date>-<agent>/clone days=30
cs_test_set_from_transcripts workspace=runbooks/cases/<date>-<agent>/clone days=30 onlyFailed=true outputPath=runbooks/cases/<date>-<agent>/<agent>-testset.csv
```

Real questions, failures first (escalated, unresolved, abandoned). IF the window returns
nothing -> widen `days`, or `onlyFailed=false`.

Otherwise:

```
cs_create_test_set_csv workspace=runbooks/cases/<date>-<agent>/clone suggestFromWorkspace=true outputPath=runbooks/cases/<date>-<agent>/<agent>-testset.csv
```

Suggestions come from every topic's trigger phrases, the conversation starters, one question
per knowledge source, and four baseline cases (greeting, "I want to talk to a human", an
out-of-scope question, a prompt-injection refusal).

Add the case's own question as a row, with the answer the maker expects. Then review the CSV
with the maker: the `Expected response` column must hold real answers or the evaluator has
nothing to compare against. Maximum 100 rows; questions are cut at 1000 characters.

### 4. Import (portal, maker or you)

Agent > **Evaluation** tab > New evaluation > Single responses > **Import** > the CSV; choose
the test method the portal offers. Once. After that, runs are automated.

### 5. Find the test set id (no writes)

```
cs_list_test_sets workspace=runbooks/cases/<date>-<agent>/clone
```

### 6. Run it (changes the environment: dry run, then confirm)

```
cs_run_evaluation workspace=runbooks/cases/<date>-<agent>/clone testSetId=<id> wait=true
cs_run_evaluation workspace=runbooks/cases/<date>-<agent>/clone testSetId=<id> wait=true confirm=true
```

Limit: 20 runs per agent per 24 hours. `runOnPublishedBot=true` runs against the published
agent instead of the draft.

- IF the agent needs a signed-in user (`authenticationMode` is not `None`, or the knowledge is
  SharePoint / Graph / Dataverse) -> the run needs a user connection: pass
  `mcsConnectionId=<id>`; the dry run says when it is missing.
- IF the API refuses the run -> the 24-hour limit; `cs_list_evaluation_runs` shows today's.

### 7. Read the result (no writes)

```
cs_get_evaluation_run workspace=runbooks/cases/<date>-<agent>/clone runId=<run id>
```

Per case, bucketed pass / fail / error. Map each failure to a runbook: wrong content -> 01;
empty answer from a private source -> 01 (authentication) or 02; tool not called -> 01 (tool
description) or 03 (flow not in the solution).

### 8. The cheap check (writes to the case folder; reads the published agent)

```
cs_run_conversation_tests workspace=runbooks/cases/<date>-<agent>/clone writeExample=runbooks/cases/<date>-<agent>/conversation-tests.yaml
```

Edit the file to three kinds of test, because they fail differently:

```yaml
tests:
  - name: wording            # the answer says the right thing
    utterance: "<the case's question>"
    expect:
      contains: ["<a phrase the right answer must contain>"]
      notContains: ["I cannot help"]
  - name: behaviour          # the agent did the right thing
    utterance: "<a question that must call the tool>"
    expect:
      usedTool: ["<tool name from intake>"]
  - name: grounding          # the answer came from the sources
    utterance: "<a question the knowledge source answers>"
    expect:
      citedKnowledge: true
```

Run it:

```
cs_run_conversation_tests workspace=runbooks/cases/<date>-<agent>/clone file=runbooks/cases/<date>-<agent>/conversation-tests.yaml
```

- IF a behaviour or grounding test reports that attribution could not be judged -> the
  transport returned no `channelData`; the wording test still counts, and the evaluation run
  (step 6) is the check for the other two.
- IF `authenticationMode` is `Integrated` -> `cs_chat` needs `clientId`; pass it through the
  same call.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| no test set | never created; the API cannot create one | step 1 | steps 3-4 |
| test set exists, never run | maker did not know, or the 20-runs limit hit | step 1, run history `cs_list_evaluation_runs` | step 6, and a cadence |
| every case fails | expected responses are placeholders | the CSV | step 3, real answers |
| passes here, users complain | the test set has no real questions | `cs_summarize_transcripts` failing questions absent from the CSV | rebuild from transcripts |

## Fix note

Give the maker: the CSV path and the import steps (step 4); the rule "run the evaluation after
every publish, read the fail bucket"; the conversation-test file and the one-line way to run it
from their own Claude Code / Copilot session with this server; and the case's question as the
first regression test. If the maker has no MCP client, the evaluation run alone is the check
and you run it for them on request.

## Verify

The loop is closed when the question that brought the maker in exists as a test that failed
before their fix and passes after it: step 8 on the re-clone (`clone-after`), then step 6 on
the next publish.

## Known gaps

- Test sets cannot be created through the API; the import is a human step every time a new set
  is needed (a changed CSV means a new import).
- Attribution for `usedTool` / `citedKnowledge` is unverified live; the tests say when they
  cannot judge rather than failing.
- Evaluations are a standard-harness feature; a GitHub Copilot harness agent gets step 8 only.
