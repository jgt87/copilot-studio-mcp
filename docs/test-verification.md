# Verifying the feedback loop against a live environment

The loop is: edit the workspace, check it statically, push and publish, test the
published agent's behaviour, read what real conversations did, and turn the
failures back into tests.

Most of it is built. One link rests on an assumption that has never been checked
against a tenant: **that a Copilot Studio activity says which topic, tool and
knowledge source it came from, and that it says so the same way over DirectLine
as it does in a stored transcript.** `src/attribution.ts` accepts every shape the
documentation describes, because none has been observed here.

This runbook settles that, then walks the whole loop. Phase 1 is the one that
gates the rest; if the attribution is not there, phases 2 and 3 still work on
wording alone and phase 4 tells you what production actually did.

Record results in a copy of `docs/verification-template.md`. Nothing below needs
a production tenant, and phases 1, 4 and 5 make no writes.

## What you need

- An agent published to an environment you can break, with **at least one tool**
  (a connector action or a flow) and **at least one knowledge source**. An agent
  with neither cannot answer the question this runbook exists to answer.
- A pac auth profile (`pac auth create --environment <id>`) and a cached
  `cs_login`.
- `CPS_READ_ONLY` unset for phases 3 and 6; set it for the read-only phases if
  you want the write tools withheld entirely.

Note which authentication mode the agent uses, because it decides the transport
and the transports may differ in what they attribute:

```
cs_list_agents                     # find the agent
cs_chat utterance="hello"          # 'protocol' in the result says directline or sdk
```

---

## Phase 1 - does an activity say what the agent did?

**The question:** over DirectLine, does an activity carry `channelData` naming
the topic and the tool, and do generative answers carry citations?

**Why it gates everything:** `usedTool`, `usedTopic` and `citedKnowledge` in
`cs_run_conversation_tests` read exactly this. If it is absent, those
expectations report "cannot be judged" rather than failing the agent - correct
behaviour, but it means behavioural tests are not available on that transport.

1. Ask something that **must** invoke a tool. Use a question only the tool can
   answer, not one the model could improvise:

   ```
   cs_chat utterance="<the question that forces your tool to run>"
   ```

2. Read `observed` in the result. It is `{topics, tools, citations}`, collected
   across every activity. Then read the per-activity `topic` / `tool` /
   `citations` fields.

3. Record, for the tool question:

   | Claim | Confirmed? | The name as it actually appears |
   | --- | --- | --- |
   | `observed.tools` is non-empty | | |
   | `observed.topics` is non-empty | | |
   | The tool name matches what the workspace calls it | | |

4. Repeat with a question that must be answered from **knowledge**, and record
   whether `observed.citations` is non-empty and what the entries look like.

5. If `observed` is empty everywhere, dump one raw activity and look for where
   the attribution actually lives:

   ```
   cs_chat utterance="<the tool question>"    # then read the full activities array
   ```

   The shapes `src/attribution.ts` already tries are `channelData.topicName`,
   `.TopicName`, `.enclosingScope.topicName`, `.actionName`, `.ActionName`,
   `.toolName`, `.ToolName`, `entities[].citation[]` and `channelData.citations`.
   **If you find a different key, add it to that module and to
   `test/attribution.test.js` in the same change** - that test file is the
   written record of which shapes are claimed, so a new shape belongs in both.

**Outcome to record:** one of

- *attributed live* - behavioural expectations work over this transport, continue;
- *not attributed live* - phases 2 and 3 assert wording only, and behaviour is
  checked after the fact in phase 4 instead;
- *attributed differently* - the extractor needs the key you found before the
  rest of this runbook means anything.

## Phase 2 - static checks catch what they claim to (no writes)

```
cs_validate                # schema, plus connection references, catalog operations, topic redirects
cs_review_agent            # rules-based score out of 10, each finding names a rule and a fix
```

Then break one thing on purpose and confirm it is caught: point a tool at a
connection reference that does not exist, or redirect a topic at a topic you
deleted. `cs_validate` should report it as an **error**, not a warning, because
errors block `cs_push`.

Record: the score before, what you broke, whether it was caught, and at what
severity. A break that passes validation is a missing rule worth adding to
`src/review.ts`.

## Phase 3 - the loop's write half

```
cs_push                    # dry run first: read the validation and drift summary
cs_push confirm=true
cs_publish confirm=true
```

Confirm in the portal that the change is live before continuing. `cs_publish`
via pac can print a failure and still exit zero; the runner now treats that as a
failure, so a green result here is also a check on that.

## Phase 4 - behavioural tests

```
cs_run_conversation_tests writeExample="tests/agent.tests.yaml"
```

Edit the file for your agent. Write **three kinds** of test, because they fail
differently:

```yaml
tests:
  # 1. Wording only. Passes whether or not the agent did the right thing.
  - name: greeting
    utterance: Hello
    expect:
      containsAny: ["help", "assist"]

  # 2. Behaviour. This is the one phase 1 was for.
  - name: order lookup really calls the tool
    utterance: <the question that forces your tool to run>
    expect:
      usedTool: [<your tool>]
      notUsedTopic: [Fallback]

  # 3. Grounding. Fails when the agent improvises instead of citing.
  - name: policy answer is grounded
    utterance: <a question only your knowledge source can answer>
    expect:
      citedKnowledge: true
```

```
cs_run_conversation_tests file="tests/agent.tests.yaml"
```

Every result carries `observed` whether or not it asserted on attribution, so
the run doubles as a second reading of phase 1.

**The check that matters:** make test 2 fail *on purpose* by pointing `usedTool`
at a tool the agent does not have. It must fail with `tool "X" was not used
(used: ...)`, naming what was used. If instead it says "no tool, topic or
citation attribution", phase 1's answer was *not attributed live* and these
expectations are inert on this transport - say so in the results file rather
than deleting the tests.

## Phase 5 - what production actually did (no writes)

```
cs_list_transcripts
cs_get_transcript transcriptId=<one with several turns>
cs_summarize_transcripts
```

`cs_get_transcript` returns turns carrying `topic` and `tool`. This is the same
extractor phase 1 exercised, against stored transcripts rather than live
activities, so **compare the two**: if live attributes nothing but transcripts
do, the loop still closes, one conversation later.

From `cs_summarize_transcripts`, check each number against the portal's own
analytics before trusting it:

| Field | Check |
| --- | --- |
| `sessions`, `window` | matches the transcripts you can see |
| `outcomes`, `escalationRate` | the heuristic in `outcomeOf` is a guess from wording; sample five sessions and judge whether you agree |
| `topTopics`, `topTools` | non-empty, and the names match the workspace |
| `sessionsWithoutTopic` | sessions where the agent matched nothing |
| `unansweredQuestions` | real questions, and worth fixing |

`outcome` is explicitly a heuristic and labels itself with `outcomeReason`.
Record whether you agree with it on your sample; if you do not, the regexes in
`outcomeOf` are the thing to change.

## Phase 6 - closing the loop

```
cs_test_set_from_transcripts        # failed conversations become test cases
```

Then either run them locally, or take them to the portal:

```
cs_create_test_set_csv
# import the CSV on the Evaluation page, then
cs_list_test_sets
cs_run_evaluation confirm=true wait=true
cs_get_evaluation_run
```

Record whether the generated cases are ones you would have written. If they are
generic, `questionsFromTranscripts` needs better selection, not more cases.

The loop is closed when a question that failed in production exists as a test
that fails before your fix and passes after it. **Write down one such question
and its test** - that single round trip is the thing this runbook is trying to
establish, and everything above is scaffolding for it.

## What is still assumed after this

Note in the results file anything you could not check, so the next person does
not read silence as confirmation. Known gaps as of writing:

- The Copilot Studio client SDK transport (`sdk`, for Entra-SSO agents) has not
  been checked for attribution at all. Phase 1 over DirectLine says nothing
  about it.
- `citedKnowledge` is the least certain of the three. Citations have moved
  between schema.org entities and a channelData array across releases, and
  neither has been seen here.
- The idle sweep and token refresh in `src/cloud/chat.ts` are covered by unit
  tests against a controlled clock, not by a real conversation left open for
  half an hour. A conversation resumed after 35 minutes is the direct test.
