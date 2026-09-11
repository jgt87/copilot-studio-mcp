# Triage runbooks

Personal working notes for helping app makers fix their Copilot Studio agents. Makers build in
their own environments; they come with a symptom; these runbooks get the agent onto disk, find
the cause with the copilot-studio MCP server, and produce a fix note the maker applies in their
own portal. The runbooks themselves are published here. Their working folders are not: `cases/` and
`samples/` stay gitignored, because they hold clones of other people's agents. Keep every
maker-specific artefact inside those two folders.

| Maker says | Runbook |
| --- | --- |
| anything, first | [00 Intake](00-intake.md): get the agent on disk, first read, pick the runbook |
| "it answers wrong / ignores what I told it / never uses the tool" | [01 Instructions](01-instructions.md) |
| "I cannot add connector X", "the knowledge source is refused", "it worked until I added Y" | [02 DLP](02-dlp-blocked-connector-or-knowledge.md) |
| "my flow is not in the tool list", "the export is missing things", "the tool arrived unconnected" | [03 Components outside the solution](03-components-outside-the-solution.md) |
| "it broke after a change and nobody noticed", "how do I test this" | [04 No evaluations](04-no-evaluations.md) |
| "it cannot find anything in SharePoint", "no citations", "generic answers" | [05 Knowledge source returns nothing](05-knowledge-source-returns-nothing.md) |
| "works in the Test pane, users get nothing", "not in Teams", "not in Microsoft 365 Copilot" | [06 Nobody can reach the agent](06-nobody-can-reach-the-agent.md) |
| "someone changed my agent", "my push is refused", "we need a history" | [07 Who changed what](07-who-changed-what.md) |
| "how do I get this to test / production", "the import failed", "tools arrived disconnected" | [08 Promote an agent to another environment](08-promote-agent-to-another-environment.md) |
| "the agent says something went wrong", "the flow works in Power Automate but not from the agent" | [09 A flow tool fails at runtime](09-flow-tool-fails.md) |
| "I cannot see the environment", "Create is greyed out", "no permission" (from a maker) | [10 A maker cannot create or open an agent](10-maker-cannot-create-or-open.md) |
| "this agent has to stop now" (an incident) | [11 Take an agent offline now](11-take-an-agent-offline.md) |
| "is anyone using it, what do they ask, what should we fix first" | [12 What are users asking](12-what-are-users-asking.md) |

## One-time setup

1. **One pac profile for the admin account.** `cs_clone_agent` has no `profile` argument (it runs
   under `CPS_PAC_PROFILE` or the active pac profile), so the account that clones must be the
   default. With admin rights everywhere that is the admin account:

   ```sh
   pac auth create --name admin --environment <any environment id>
   ```

   `cs_list_auth_profiles` shows it. If a maker profile exists too, `cs_select_auth_profile
   name=admin` at the start of a session, or set the two variables below.
2. **Server environment** (in `.vscode/mcp.json` or the Claude Code server entry):
   `CPS_PAC_PROFILE=admin` and `CPS_ADMIN_PROFILE=admin`. Both, because sync tools read the
   first and `cs_admin_*` tools read the second.
3. **`cs_login` once per machine.** The Dataverse-backed tools (`cs_list_test_sets`,
   `cs_run_evaluation`, `cs_list_flows`, `cs_get_flow`, transcripts, `cs_check_drift` quick
   mode) use the MSAL token, not pac. `cs_init` shows `cloudAccess.ready`.
4. **Tool preset**: `full`, or `core,solutions,cs_admin_*` if the client struggles with 137
   tools (`cs_set_tool_preset`).

## Case workflow

One folder per case: `runbooks/cases/<yyyy-mm-dd>-<agent>/`. In it:

```
clone/               the agent as pac copilot clone wrote it (never pushed from here)
outputs/             raw tool outputs worth keeping (review.md, dlp/*.txt, solution inventory)
fix-note.md          what goes to the maker (templates/fix-note.md filled in)
```

Conventions that every runbook assumes:

- **Prompt first.** Each runbook opens with a prompt to paste into Claude Code or Copilot; the
  steps below it are the same procedure for a human, with the decision points spelled out.
- **Read-only by default.** The runbooks read the maker's environment. Nothing pushes,
  publishes or edits their agent; the fix goes to them as a note. The exceptions are named
  (`cs_add_solution_component` in 03, `cs_run_evaluation` in 04) and always run as a dry run
  first, then once more with `confirm` after you agree. One approval per call.
- **Re-clone to verify.** After the maker applied the fix, clone again into the same case
  folder and compare (`cs_check_drift mode=full` against the first clone's stamp, or a fresh
  `cs_review_agent` / `cs_run_conversation_tests`).
- **Record what you saw.** Each step says what to note; the fix note quotes it as evidence.

## Prompt preamble

Every runbook prompt starts with this; the runbook adds the specifics.

```
You are helping me triage a Copilot Studio agent that belongs to an app maker. Use the
copilot-studio MCP server. Work in runbooks/cases/<date>-<agent>/ (create it). Read-only calls
run immediately. Any call that changes an environment must be shown to me as its dry run first
and run again with confirm only after I say so, one call per approval. Never push, publish or
edit the maker's agent: I hand them a fix note. Finish by filling runbooks/templates/fix-note.md
into the case folder as fix-note.md.
```

## Gaps in the server these runbooks work around

Kept here so they can become tools later.

- **DLP is raw text.** `cs_admin_list_dlp_policies` / `cs_admin_show_dlp_policy` return pac's
  output unparsed (pac 2.11.2 has no JSON option for them), and nothing maps a connector id to
  its group. Runbook 02 reads it by hand; a `cs_admin_check_dlp connectors=[...] environment=`
  tool would close this.
- **Solution membership.** Nothing answers "which solution holds this flow / connection
  reference / variable"; `cs_list_flows` has no solution column. Runbook 03 uses
  `cs_env_fetch` with `templates/solution-membership.fetch.xml`.
- **`cs_clone_agent` takes no `profile`.** The default-profile setup above is the workaround.
- **Test sets cannot be created through the API.** Runbook 04 stops at the CSV and the portal
  import is a human step.
