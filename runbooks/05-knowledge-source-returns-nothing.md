# 05 Knowledge source returns nothing

The maker added SharePoint, a public website, uploaded files, Dataverse or a Graph connector,
and the agent still says it cannot find anything, answers generically, or answers without a
citation. Nine times in ten the source is fine and something in front of it is not: the
authentication mode, the user's own access, the URL shape, or a setting that lets the model
answer from its own knowledge instead. This runbook works from the agent outwards.

## Prompt

```
<preamble from README.md>

Run runbooks/00-intake.md if it has not run for this case, then
runbooks/05-knowledge-source-returns-nothing.md for agent "<agent>" in environment
"<environment>". The source that returns nothing is "<name or URL>"; a question it should
answer is "<question>". Fill the authentication table, reproduce if the agent is published,
and say which of the causes in the diagnosis table it is.
```

## What you need

- Intake done; `intake.md` lists the knowledge sources with kind and site, and
  `authenticationMode`.
- For step 3: the agent published; for an Entra-SSO agent, a `clientId`.

## Steps

### 1. What kind of source, and does the agent sign users in? (no writes)

**The question:** can this agent reach this source for the person asking?

| Source kind | Needs a signed-in user? | Works with `authenticationMode` |
| --- | --- | --- |
| SharePoint site or folder | yes - the search runs as the user, with their permissions | `Integrated` only |
| Graph connector, Dataverse, Teams, email, meetings | yes | `Integrated` only |
| public website | no | any |
| uploaded files | no (the agent owns the copy) | any |

Fill it for every source from `intake.md`. IF a "yes" source sits on an agent whose
`authenticationMode` is `None` or `Manual` -> the source is skipped for every user. The review
already said so: `auth-none-with-private-knowledge` (error). That is the fix, before anything
else; go to the fix note.

### 2. Settings that hide the source (no writes)

From `clone/agent.mcs.yml` and `clone/settings.mcs.yml`:

- `aISettings.useModelKnowledge: true` -> the model may answer from its own knowledge and
  will, when the source is slow or thin; the answer then has no citation. Record it.
- `gptCapabilities` web browsing on, with private sources -> answers may come from the web
  instead (`web-browsing-with-private-knowledge`).
- instructions with no "answer from the knowledge sources and cite" rule -> runbook 01.
- a topic that answers the question with a plain message before generative answers run
  (`cs_describe_workspace` lists topics and phrases; `topic-phrase-overlap`) -> the source is
  never consulted for that phrasing.
- `configuration.settings.GenerativeActionsEnabled: false` with sources scoped in a topic ->
  the topic's own search node decides; check its knowledge scope.

### 3. Reproduce (no writes, published agent only)

```
cs_chat workspace=runbooks/cases/<date>-<agent>/clone utterance="<question the source answers>"
```

Read the reply and the observed **citations**.

- IF citations name the source -> the source works for this account; the maker's user lacks
  access to the content (step 4), or asked differently (step 2, topics).
- IF no citation and a generic answer -> step 2 (`useModelKnowledge`) or step 4.
- IF "I cannot help with that" -> content moderation, or nothing indexed yet (step 4).
- IF the agent is not published or is Entra-SSO without a `clientId` -> ask the maker to try
  in the Test pane signed in as themselves, and read a recent session instead:
  `cs_list_transcripts workspace=<clone> days=7 search="<a word from the question>"`, then
  `cs_get_transcript workspace=<clone> transcriptId=<id>`.

### 4. The source itself (no writes; some of it is in the portal)

Per kind, what to check and where:

| Kind | Check | Where |
| --- | --- | --- |
| SharePoint | the `site` is a site or folder URL (`https://<tenant>.sharepoint.com/sites/<name>` or a library path), not a page or a document; the asking user has read access; files are supported types and under the size limit; the source status in the portal is Ready, not Error or In progress | `intake.md` site; the maker's Knowledge page |
| public website | the URL is a domain or a path under it; the pages are indexed by Bing (a brand-new intranet-only site is not); the Copilot Studio public-website DLP connector is not Blocked | runbook 02 for the last |
| uploaded files | indexing finished (minutes after upload); the file is a supported type; the content is text, not scanned images | Knowledge page status |
| Dataverse | the table has Dataverse search enabled and the columns to search are in its quick-find view; the user has read on the table | Power Apps > Tables > settings |
| Graph connector | the connector is enabled for Copilot in the Microsoft 365 admin centre (Search & intelligence) and the agent's user is in its audience | M365 admin centre |

The server cannot read the portal's per-source status column; the maker sends a screenshot
of the Knowledge page, or you open it as admin.

### 5. Record

The filled table from step 1, the settings from step 2, the observed citations from step 3,
and the source checks from step 4, each with a verdict.

## Diagnosis

| Symptom | Cause | Evidence | Fix |
| --- | --- | --- | --- |
| private source, empty for everyone | `authenticationMode` not `Integrated` | step 1; `auth-none-with-private-knowledge` | Settings > Security > Authentication > Authenticate with Microsoft, then Publish |
| works for the maker, empty for a colleague | the colleague has no access to the site / table | step 3 citations present for you | grant access on the source, not in the agent |
| generic answer, no citation | `useModelKnowledge: true`; no grounding rule | step 2 | Settings > Generative AI: general knowledge off; runbook 01 for the rule |
| source status Error / In progress | wrong URL shape, unsupported files, indexing not done | step 4 | fix the URL (`cs_edit_knowledge` shows the fields; the maker edits in Knowledge), wait, re-check |
| public site "refused" | DLP virtual connector | runbook 02 | policy or a different source |
| the right answer never comes for one phrasing | a topic catches the phrase first | `topic-phrase-overlap`; observed topic in step 3 | remove the phrase from the topic |

## Fix note

Name the source, the cause in one sentence, and the change with its portal path (Settings >
Security > Authentication; Knowledge > source > edit; Settings > Generative AI). Add the two
things that cost the most time later: private sources need **Authenticate with Microsoft**
before they return anything, and answers are only as reachable as the asking user's own
permissions on the content.

## Verify after the maker applied it

`cs_chat` with the same question: a citation naming the source. Turn it into a conversation
test with `citedKnowledge: true` (runbook 04, step 8) so the next change cannot silently break
it.

## Known gaps

- The portal's per-source indexing status is not readable from here.
- `cs_chat` runs as your account; a colleague's access problem needs a transcript or the
  colleague trying it.
- Size and file-type limits change; the portal's Knowledge page is the authority, this runbook
  only says where to look.
