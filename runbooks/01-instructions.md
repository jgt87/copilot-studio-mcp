# 01 Instructions: the agent does not do what the maker told it

The maker says the agent answers wrong, ignores a rule, answers from general knowledge instead
of their sources, never calls a tool, or picks the wrong topic. Most of these trace back to the
instructions or to one of the settings next to them, not to knowledge or tools. This runbook
reads the instructions against what they must contain, checks the settings that change
behaviour without touching the text, reproduces the failure when the agent is published, and
drafts the replacement text for the maker.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then runbooks/01-instructions.md for
agent "<agent>" in environment "<environment>". The maker reports: "<symptom, quoted>". The
question that fails is: "<utterance>". Print the current instructions verbatim, fill in the
four-part check and the settings table, run the review, reproduce with cs_chat if the agent is
published, and draft the new instructions (do not apply them). Put the draft and the settings
to change in the fix note.
```

## What you need

- Intake done: `runbooks/cases/<date>-<agent>/clone` exists and `intake.md` is written.
- For step 5: the agent published, and `cs_login` cached. If `authenticationMode` is
  `Integrated` (Entra SSO) you also need an app registration with
  `CopilotStudio.Copilots.Invoke` (`clientId`); otherwise skip step 5 and use transcripts.

## Steps

### 1. Read what is there (no writes)

**The question:** what do the instructions say, word for word?

Print `clone/agent.mcs.yml`: `instructions`, `responseInstructions`, `conversationStarters`,
`gptCapabilities`, `aISettings`, `defaultResponseMode`, `historyType`. For a GitHub Copilot
harness agent the text is in `clone/settings.mcs.yml` under
`configuration.agentSettings.instructions.segments`.

From `intake.md`, list the **tool names** and **knowledge source names** the agent has. The
instructions are checked against those names, not against what the maker meant.

### 2. The four-part check (no writes)

**The question:** do the instructions contain what an agent needs to act on them?

| Part | Present? | Quote or gap |
| --- | --- | --- |
| Role and scope: what the agent is for, and what it is not for | | |
| How to answer: ground in the knowledge sources, cite, ask when unclear | | |
| When to use each tool, **by the tool's name** (every tool from intake should appear) | | |
| What to refuse, and how to escalate (a topic or a handoff, named) | | |

- IF a tool is never named -> the orchestrator has only the tool description to route on; check
  that description in step 4.
- IF there is no refuse/escalate line and the review reports `no-escalation` -> the agent will
  improvise refusals.
- IF the text is one paragraph -> rules are missed; one rule per line, second person.

### 3. Settings that change behaviour without changing the text (no writes)

**The question:** is a setting doing what the maker blames on the instructions?

| Symptom | Field (in `agent.mcs.yml`) | What to record |
| --- | --- | --- |
| answers from the model's own knowledge, ignores the sources | `aISettings.useModelKnowledge` | `true` means it may answer beyond the sources |
| too short, or too slow and long | `defaultResponseMode` (`Auto`, `ThinkDeeper`, `QuickResponse`), `responseInstructions` | |
| forgets earlier turns, or drags them in | `historyType`, history length | |
| mixes public web content into internal answers | `gptCapabilities` web browsing on, with SharePoint / Graph / Dataverse knowledge | review rule `web-browsing-with-private-knowledge` |
| refuses harmless questions | `aISettings.contentModeration` (`Minimum` .. `Maximum`) | |
| a tool exists but is never called and no topic calls it | `settings.mcs.yml` -> `configuration.settings.GenerativeActionsEnabled` | review rule `orchestration-off-with-tools` |
| the source is SharePoint / Graph / Dataverse and answers are empty | `settings.mcs.yml` -> `authenticationMode` is `None` | review rule `auth-none-with-private-knowledge` (error): the source needs a signed-in user |

### 4. Review findings that belong to this runbook (no writes)

Open `outputs/review.md` from intake (or run `cs_review_agent` again). The rules to act on:

- `instructions-missing`, `instructions-short`, `instructions-long`
- `tool-description` (error): the description is under 20 characters or absent; a good one
  says what the tool does **and when to use it** ("Look up an order by its number. Use when the
  user gives an order number.")
- `no-escalation`, `no-fallback`
- `topic-phrase-overlap`: two topics share a trigger phrase, so the wrong one fires; the
  finding names both

### 5. Reproduce (no writes, published agent only)

**The question:** what does the published agent actually do with the failing question?

```
cs_chat workspace=runbooks/cases/<date>-<agent>/clone utterance="<the maker's failing question>"
```

Record the reply and the **observed** topic, tool and citations the result reports.

- IF a topic fired that should not have -> step 4, phrase overlap; the fix is the topic's
  trigger phrases, not the instructions.
- IF no tool was used where one should have been -> the tool's description or the
  instructions' tool line (step 2).
- IF the answer has no citation with knowledge present -> `useModelKnowledge` (step 3), or the
  knowledge source is not reachable for that user (authentication, or runbook 02).
- IF the result says attribution could not be judged -> the transport returned no
  `channelData`; rely on the reply text and on transcripts:
  `cs_list_transcripts workspace=<clone> days=7` then `cs_get_transcript` for a session with
  that question.
- IF the agent is not published -> ask the maker to test in the portal's Test pane with the
  same question and send the answer; the draft agent is not reachable from here.

### 6. Draft the fix (writes to the case folder only)

Two ways; neither touches the maker's agent.

Option A, from the current text with a change request:

```
cs_generate_instructions workspace=runbooks/cases/<date>-<agent>/clone refine=true changeRequest="<what must change, one rule per line>" modelName="<the AI Builder prompt in this environment; cs_list_prompts shows them>"
```

Do **not** pass `apply`. Copy the draft into the fix note.

Option B, by hand, following the four parts of step 2: role and scope; how to answer (ground,
cite, ask); one line per tool, named; refuse and escalate. Keep every existing rule that was
right. One rule per line.

Either way, re-score the draft on the scratch clone before sending it:

```
cs_update_agent workspace=runbooks/cases/<date>-<agent>/clone instructions="<draft>"
cs_review_agent workspace=runbooks/cases/<date>-<agent>/clone
```

That is a local file write; the clone is never pushed. The `instructions-*` findings must be
gone. Record the score before and after.

Then the settings from step 3 that must flip, as a list of field and value.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| answers from general knowledge | `useModelKnowledge: true`, or no "ground in sources" rule | step 3; step 5 reply has no citation | set it to false; add the grounding rule |
| never calls tool X | instructions do not name X; or X's description does not say when | step 2 table; `tool-description` | add the "use X when ..." line; rewrite the description (maker: Tools > X > Description) |
| wrong topic answers | shared trigger phrase | `topic-phrase-overlap`; step 5 observed topic | remove the phrase from the topic that should not fire |
| refuses or escalates badly | no refuse/escalate rule; `no-escalation` | step 2, step 4 | add the rule and name the escalation topic |
| empty answers from SharePoint / Graph | `authenticationMode: None` | `auth-none-with-private-knowledge` | Settings > Security > Authentication: Authenticate with Microsoft |
| answers too long / too short | `defaultResponseMode`, `responseInstructions` | step 3 | set the mode; add response instructions |

## Fix note

Fill `templates/fix-note.md`. The "what to change" section holds:

1. The new instructions in full (the maker pastes them: agent > Overview > Instructions, or
   `agent.mcs.yml` -> `instructions` for makers on the VS Code extension).
2. Each setting to change, with the portal path: response mode and response instructions
   under Overview > Responses; general knowledge, moderation, web browsing and file analysis
   under Settings > Generative AI; authentication under Settings > Security.
3. Tool descriptions to rewrite (Tools > tool > Description) and trigger phrases to remove
   (Topics > topic > Trigger).
4. The reminder that nothing changes for users until they **Publish**.

## Verify after the maker applied it

1. Clone again into `runbooks/cases/<date>-<agent>/clone-after` and diff the instructions.
2. `cs_review_agent` on the new clone: the findings from step 4 should be gone.
3. `cs_chat` with the same utterance as step 5: the observed topic / tool / citation should be
   the intended one. Keep the utterance: runbook 04 turns it into a conversation test with
   `usedTool` / `citedKnowledge` so the fix stays fixed.

## Known gaps

- `cs_chat` reaches the published agent only; the draft needs the portal's Test pane.
- Attribution (which topic, tool, citation) is read from `channelData` and has not been seen
  from a live tenant yet; when it is absent the result says so, and transcripts are the fallback.
- `cs_generate_instructions` needs an AI Builder "write instructions" prompt in the environment;
  if the maker's environment has none, write the draft by hand.
