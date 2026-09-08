# Live verification runbook

> Phases A to F have already run once (2026-09-08). For only the items still open after
> that run, see [verify.md](verify.md) — four of the five are read-only.

Everything in this server below the unit tests and the pack oracle was built from documentation and
the published schema, never from a live tenant. `docs/STATUS.md` says "unverified live" on a dozen
rows. This runbook settles them.

Work through it on a machine that has Copilot Studio and a real environment, record what each step
returned, redact, and hand the result back.

## Before you start

**Use a development environment, not production.** Phases E to G create an agent, push, publish and
import a solution. Everything they create is named `zzVerify*` so it is easy to find and delete —
but deleting it is a manual step, and the first run of this runbook left `zzVerify` agents behind in
a production environment. Before you start, write down which environment each phase will touch, and
do the cleanup at the end in the same sitting.

**The phases are ordered by what they settle per unit of risk, not by the checklist order.**
Phases A to D are entirely read-only: they touch nothing in your tenant and they settle most of the
open questions. If you only have half an hour, do A to D and stop — that is still the majority of
the value. Phases E to G write, and each says so in its heading.

**The repo is public.** Do not commit raw results. Every phase asks you to paste tool output into a
results file; `scripts/redact-verification.mjs` replaces GUIDs, org URLs, email addresses and
tenant names with stable pseudonyms before you share it. See "Handing the results back".

Setup:

```sh
git clone https://github.com/jgt87/copilot-studio-mcp   # or pull the latest
cd copilot-studio-mcp
npm install
npm run build
npm test                      # 147 tests, offline; confirms the build is sound before you start
cp docs/verification-template.md verification-results.md
```

**Rebuild, then restart your MCP client.** `npm run build` writes `dist/`, which is what the server
runs, and most clients read the tool list once at startup. If you pull and do not do both, you will
be testing the previous build against the current runbook — on the first run this made four
transcript tools look "not implemented" when they were present in the very commit under test.
Confirm with `cs_guide` topic `transcripts`: if that topic is unknown, your server is stale.

Register the server in your MCP client (README "Install and register"), then sign in:

- `pac auth create --environment <environment id>` in a terminal, for the pac-backed tools.
- `cs_login` for the cloud tools. On a machine where the browser does not launch, it returns
  `status: pending` with a URL — open it manually; that is a known and supported path.

**Check what you can actually reach before you start.** `cs_init` now probes each cloud resource
with a silent token acquisition and reports `cloudAccess.ready`. A cached account is not the same as
a usable token: on the first run `cs_init` listed an account and Dataverse still could not be read,
which is what made three steps quietly do something else. If `cloudAccess.ready.dataverse` is not
`ok`, phases C (quick) and D will not work yet.

The same information, as a table:

| Needs | Steps |
| --- | --- |
| pac auth profile only | A1, A6, A8, B1, C4, C5, E1-E10, F1, G1-G5 |
| `cs_login` (MSAL) as well | A2, A3 with `via: "dataverse"`, C1/C3 (`mode: "quick"`), **all of phase D**, F3-F5 |

If `cs_login` has not completed, `cs_check_drift` quick and the transcript tools will not work, and
`cs_list_agents` quietly answers from pac instead of Dataverse. Do the sign-in before phase A.

Throughout: **paste the full JSON result** under the matching heading in `verification-results.md`,
and add a line saying whether it matched what the tool claimed. A result that disagrees with the
documentation is the most valuable thing you can bring back — do not tidy it up.

---

## Phase A — Read-only reconnaissance (no writes)

Settles: the pac profile plumbing, the BAP environment lookup, the Dataverse bot query, and the
connector registry endpoint (`api.powerapps.com` with `$expand=swagger`), which has never run.

| # | Call | Record | Pass if |
| --- | --- | --- | --- |
| A1 | `cs_init` | full JSON | pac version, the auth profile and the signed-in user all appear |
| A2 | `cs_list_environments` | count + one row, no names | your environments are listed with ids and URLs |
| A3 | `cs_list_agents` | count + one row, and the `via` field | agents are listed. `via: "pac"` returns componentState/statusCode/stateCode/solutionId; that is correct, not a gap |
| A3b | `cs_list_agents` with `via: "dataverse"` | count + one row | the Dataverse `bots` query works and returns `publishedOn` and `authenticationMode`. Needs `cs_login` |
| A4 | `cs_list_connectors` with `search: "Office 365 Outlook"` | the `source` field | `source` says the live registry, not `seed`. **If it says `seed`, the registry call failed — paste the error.** |
| A5 | `cs_describe_connector` for `shared_office365` | first 3 operations | operations come back with parameters |
| A6 | `cs_list_solutions` | count | your unmanaged solutions are listed |
| A7 | `cs_list_flows` | count + one row | cloud flows with state and owner |
| A8 | `cs_list_connections` | full JSON | **column layout matters**: `parseConnectionList` was written from documentation. Paste the raw `pac` output tail too. |

## Phase B — Clone a real agent (no writes to the tenant)

Cloning downloads; it changes nothing. This is the highest-value phase in the runbook, because the
generated-YAML shapes for tools and flows have never been compared against something the portal made.

Pick an existing agent that has **a connector tool and, if possible, a cloud flow**.

| # | Call | Record | Pass if |
| --- | --- | --- | --- |
| B1 | `cs_clone_agent` with `bot` and `outputDir` | full JSON | a workspace appears on disk |
| B2 | `cs_describe_workspace` on it | full JSON | `sync.source` is not `none`; counts look right |
| B3 | `ls -R` the workspace (or `dir /s`) | the folder listing | which of `actions/ tools/ workflows/ knowledge/ trigger/ variables/` actually exist |
| B4 | Copy `actions/*.mcs.yml` (one connector tool) | the whole file | compare with what `cs_add_tool` writes |
| B5 | Copy `workflows/<name>/*` if present | both files | this decides whether `cs_add_flow` can drop its experimental flag |
| B6 | Does the clone contain evaluation test sets as YAML? Search for `TestCaseComponent`, `EvaluationSet`, `EvaluationData` | yes/no + filenames | if yes, the server should write those instead of a CSV |
| B7 | `cs_validate` on the cloned workspace | full JSON | **a portal-made agent should validate clean.** Any error here is a false positive in our validator — the most useful bug this runbook can find. |

## Phase C — Drift detection (no writes)

Settles the `bot_botcomponent` query, the `_parentbotid_value` fallback, the schema-name shape
`<agent>.<kind>.<Stem>`, and whether the formatted-value annotations arrive.

| # | Call | Record | Pass if |
| --- | --- | --- | --- |
| C1 | `cs_check_drift` `mode: "quick"` on the Phase B workspace. **Quick needs `cs_login`; if it refuses, sign in rather than falling back to `full`** | full JSON | it returns components, not an error; `modifiedBy` shows **names**, not GUIDs (that is the formatted-value annotation working) |
| C2 | Edit one topic in the Copilot Studio portal, save | what you changed | — |
| C3 | `cs_check_drift` `mode: "quick"` again | full JSON | the edited topic is listed as changed, mapped to the right local file |
| C4 | `cs_check_drift` `mode: "full"` | full JSON | files classified local/remote/conflict with diffs |
| C5 | `cs_push` **without** `confirm` on that workspace | full JSON | the dry run reports the conflict and refuses. **Do not pass `confirm`.** |

## Phase D — Conversation transcripts (no writes)

The newest module, and the least verified. Needs a **published** agent that people have actually
used. If no agent in the environment has real traffic, say so and skip — that is a valid result.

| # | Call | Record | Pass if |
| --- | --- | --- | --- |
| D1 | `cs_list_transcripts` with `top: 5` | full JSON, **redact the message text** | sessions come back at all. **If it errors, paste the error verbatim** — the agent lookup column is a guess with three fallbacks |
| D2 | `cs_get_transcript` for one id | the turn list, message text redacted | do `topic` and `tool` come out populated, or always null? |
| D3 | `cs_summarize_transcripts` with `days: 30` | full JSON minus question text | do the numbers look plausible against what the portal's own Analytics page says? |
| D4 | Open the portal's Analytics page for the same agent | the headline numbers | compare with D3 and note any disagreement |
| D5 | `cs_test_set_from_transcripts` | the CSV path, case count, questions redacted | a CSV is written |

D2 is the one that matters most: if `topic` and `tool` are always null, the `channelData` field
names in `dataverseTranscripts.ts` are wrong and I need a sample activity (redacted) to fix them.

---

## Phase E — Authoring round trip (WRITES to the environment)

Creates one agent named `zzVerifyAgent`. Delete it afterwards with `cs_delete_agent`.

| # | Call | Record | Pass if |
| --- | --- | --- | --- |
| E1 | `cs_create_agent` with `name: "zzVerifyAgent"`, `publisherPrefix`, `projectDir`, `environment`, **no `confirm`** | the dry run | it refuses and describes what it would do |
| E2 | Same call **with `confirm: true`** | full JSON | the agent is created and the workspace is sync-connected |
| E3 | `cs_describe_workspace` | full JSON | `sync.source` is not `none` |
| E4 | `cs_add_topic` (name `zzVerifyTopic`, a couple of `triggerPhrases`, one message action) | file path | file written |
| E5 | `cs_add_knowledge_source` `kind: "publicSite"` with a public `site` | file path + portal step | file written |
| E6 | `cs_update_agent` with `instructions` and `defaultResponseMode` | `changed` list | fields written |
| E7 | `cs_validate` | full JSON | 0 errors |
| E8 | `cs_push` **with `confirm: true`** | full JSON | push succeeds |
| E9 | Open the agent in the portal | screenshot or notes | **the topic and the knowledge source are actually there** |
| E10 | `cs_publish` with `confirm: true` | full JSON | publish completes; note how long the poll took |
| E11 | `cs_chat` with an utterance the knowledge should answer | the reply | a grounded answer, and note which `transport` it chose |

## Phase F — Evaluations (WRITES: runs an evaluation)

| # | Call | Record | Pass if |
| --- | --- | --- | --- |
| F1 | `cs_create_test_set_csv` with `suggestFromWorkspace: true` | the CSV | sensible cases |
| F2 | Import it in the portal (Evaluation tab > New > Single responses > Import) | did the format import cleanly? | **the CSV column format is a documentation guess** |
| F3 | `cs_list_test_sets` | full JSON | the imported set appears with an id |
| F4 | `cs_run_evaluation` with `confirm: true` | full JSON | a run starts |
| F5 | `cs_get_evaluation_run` | full JSON | **paste the raw metric `status` values** — `summarizeRun`'s pass/fail buckets are regex guesses |

## Phase G — Solution ALM (WRITES: imports a solution)

Only if you have a second environment to deploy into. Heaviest phase, least surprising.

| # | Call | Record | Pass if |
| --- | --- | --- | --- |
| G1 | `cs_pull_solution` with `background: true` (a full pull runs for minutes and will otherwise outlive the client's call timeout), then poll `cs_job_status` with the returned `jobId` | the final job result + `solution.json` | export, unpack and per-agent clone all succeed. `packagetype: "Unmanaged"` halves the work by skipping the second export |
| G2 | `cs_describe_solution` | full JSON | the inventory matches what the portal shows |
| G3 | `cs_create_deployment_settings` | the file | environment variables and connection references listed |
| G4 | `cs_list_connections` in the **target** environment | full JSON | connection ids to bind |
| G5 | `cs_deploy_solution` with `confirm: true` | full JSON | import succeeds |
| G6 | Check the target portal | notes | agents present; are the flows switched **off**? Are the tools connected? |

## Cleanup

```
cs_delete_agent    (zzVerifyAgent, confirm: true)
cs_delete_solution (any zzVerify solution, confirm: true)
```
Delete the imported verification solution in the target environment by hand if Phase G ran.

---

## Handing the results back

```sh
node scripts/redact-verification.mjs verification-results.md
```

That writes `verification-results.redacted.md`, replacing every GUID, `*.crm*.dynamics.com` URL,
email address and UPN with a stable pseudonym (`<env-1>`, `<bot-1>`, `<user-1>`), so the same id
stays the same symbol and the report is still readable. It prints what it replaced. **Read the
output before sharing it** — it cannot know that a topic name or a transcript message is sensitive.

Then either:

- paste `verification-results.redacted.md` back into the chat, or
- `git switch -c verify/<yyyy-mm-dd>`, commit **only the redacted file**, and push.

The raw `verification-results.md` is in `.gitignore` and should stay on your machine.

## What I will do with it

Each phase maps onto rows in `docs/STATUS.md` that currently say "unverified live". I will turn
the ones that passed into "verified", fix whatever disagreed, and note anything that could not be
tested. Partial results are useful: a runbook that stops after Phase D still retires most of the
open questions.
