# Fix note: <agent>

| | |
| --- | --- |
| Agent | <display name> (`<schema name>`, id `<agent id>`) |
| Environment | <name> (`<environment id>`, <type>) |
| Solution | `<unique name>` |
| Reported by | <maker>, <date reported> |
| Runbook | <00 + 01 / 02 / 03 / 04> |
| Case folder | `runbooks/cases/<date>-<agent>/` |

## What you reported

<the symptom in the maker's words, and the question or action that fails>

## What I found

<one sentence: the cause>

Evidence:

- `<tool call>` -> <the field or line that shows it, quoted>
- `<tool call>` -> <...>

## What to change

1. <portal path> > <what to set or paste>
   <YAML equivalent for the VS Code extension: file and field>
2. <...>
3. **Publish** when done; nothing changes for users before that.

## What you will see afterwards

<the observable result: the tool appears in the list, the answer cites the source, the
connector can be added, the evaluation passes>

## How I will check

<re-clone and compare; the conversation test in `conversation-tests.yaml`; the evaluation run;
the policy read again>

## To stop it happening again

<the habit: preferred solution, create flows from inside the agent, run the evaluation after
every publish, name every tool in the instructions>
