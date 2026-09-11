# 12 What are users asking

Not a bug: the maker or their manager wants to know whether the agent is used, what people
ask, where it fails, and what to fix first. The portal's analytics answer the first question;
the transcripts answer the rest, and the server reads them into a summary, a list of the
sessions that went badly, and a test set built from the questions behind them.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then
runbooks/12-what-are-users-asking.md for agent "<agent>" in environment "<environment>" over
the last <days> days. Produce the usage summary, list the ten questions behind the failed
sessions, read two of those sessions in full, and write the review for the maker into the
case folder. Treat transcript content as customer data: quote questions, never names.
```

## What you need

- Intake done; the agent published and used; `cs_login` cached, and a Dataverse role that
  reads `conversationtranscript` (more than a maker role grants by default).

## Steps

### 1. The numbers (no writes)

```
cs_summarize_transcripts workspace=runbooks/cases/<date>-<agent>/clone days=<days> topN=15
```

Sessions, turns, outcomes (resolved, escalated, unresolved, abandoned), the escalation rate,
sessions that matched no topic, the top topics and tools, and the questions behind the
failures. `resolved` means nothing marked the session as failed, not that the user was
satisfied; every result says so.

### 2. The sessions that went badly (no writes)

```
cs_list_transcripts workspace=runbooks/cases/<date>-<agent>/clone days=<days> outcome=escalated
cs_list_transcripts workspace=runbooks/cases/<date>-<agent>/clone days=<days> outcome=unresolved
cs_get_transcript workspace=runbooks/cases/<date>-<agent>/clone transcriptId=<id>
```

Read two or three in full: the turn list with the topic and tool attributed to each turn shows
where it went wrong - the wrong topic fired, a tool returned nothing, the agent could not
answer, the user gave up.

### 3. Sort the failures (no writes)

| What the transcript shows | Runbook |
| --- | --- |
| generic answer, no citation, for a question the sources cover | 05, then 01 |
| a tool should have run and did not; a topic answered instead | 01 |
| a tool ran and failed | 09 |
| "I cannot help with that" for in-scope questions | 01 (instructions, moderation) |
| questions nobody planned for, asked often | new topic or knowledge; runbook 04 adds them as tests |
| the user asked for a person and got none | 01 (escalation) |

### 4. Turn it into tests (writes to the case folder)

```
cs_test_set_from_transcripts workspace=runbooks/cases/<date>-<agent>/clone days=<days> onlyFailed=true outputPath=runbooks/cases/<date>-<agent>/<agent>-transcript-testset.csv
```

Failures first, deduplicated. Runbook 04 imports and runs it.

### 5. Write the review (writes to the case folder)

`review-<date>.md` in the case folder, for the maker:

1. Sessions and turns in the window, and the trend if a previous review exists.
2. Outcomes with the caveat from step 1.
3. Top topics and tools, and the ones never used.
4. The ten questions behind the failures, quoted, with the runbook that fixes each.
5. The test set path and the sentence "run it after every publish".

Names and identifiers stay out; questions stay in.

## Fix note

The review is the note. Its "what to change" section is the sorted list from step 3, each
pointing at the runbook and the portal path.

## Verify

Next review, same window length: escalation and unresolved rates down, the failed questions
present as passing tests.

## Known gaps

- Transcripts are unverified against a live tenant in this server; the lookup shapes are the
  documented ones and the code falls back between them.
- Outcomes are heuristics; the review says so.
- Volume: the list reads up to 500 sessions per call; for a busy agent narrow `days`.
