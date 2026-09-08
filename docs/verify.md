# Verification follow-up: what the first run left open

Phases A to F ran against a real tenant on 2026-09-08 (`docs/STATUS.md` rows 26 to 28). Most of the
guesswork is now settled — the connector registry endpoint, the connection-list column layout, the
clone layout, a portal-made agent validating clean, drift detection, the push conflict refusal, and
the whole evaluation path including the CSV import format and the metric status strings.

Five things are still open. Four of them are read-only and take about fifteen minutes together.
This file is the short list; `docs/live-verification.md` is the full runbook if you want the context.

## Before you start

1. `git pull && npm install && npm run build`
2. **Restart your MCP client.** Most read the tool list once at startup. On the first run a stale
   client made four transcript tools look unimplemented when they were present in the commit under
   test. Check: `cs_guide` with `topic: "transcripts"` — if the topic is unknown, your server is stale.
3. `cs_login`, then `cs_init`. Read **`cloudAccess.ready`** in the result. If `dataverse` is not
   `"ok"`, items 1 to 3 below will not work yet, and that is the thing to fix first. On the first
   run `cs_init` listed a signed-in account while Dataverse was still unreachable, which is exactly
   what this field now catches.

Record everything in a copy of `docs/verification-template.md`, then run
`node scripts/redact-verification.mjs <your file>` before sharing it. The raw file is gitignored.

---

## 1. Transcripts (read-only) — the highest-value item

Never exercised at all. Needs a **published** agent that people have actually used; if none has real
traffic, say so and skip, that is a valid answer.

| Call | Capture |
| --- | --- |
| `cs_list_transcripts` `top: 5` | the full result. **If it errors, paste the error verbatim** — the agent lookup column is a guess with three fallbacks |
| `cs_get_transcript` for one id | the turn list, **message text redacted** |
| `cs_summarize_transcripts` `days: 30` | the full result minus question text |
| the portal's Analytics page, same agent and window | the headline numbers, to compare |
| `cs_test_set_from_transcripts` | the path and case count |

**The single question I most need answered:** in `cs_get_transcript`, are `topic` and `tool`
populated on the turns, or always `null`? If always null, the `channelData` field names in
`dataverseTranscripts.ts` are wrong — paste **one redacted raw activity object** and I can fix them.

## 2. Drift, quick mode (read-only)

The first run fell back to `mode: "full"`, so the `botcomponent` query was never exercised.

- `cs_check_drift` `mode: "quick"` on a cloned workspace.
- Capture the full result, and specifically: **are `modifiedBy` values names or GUIDs?** Names mean
  the formatted-value annotation request works; GUIDs mean it does not.
- Then edit one topic in the portal and run it again: the edited topic should appear as changed and
  map to the right local file.

## 3. `cs_list_agents` via Dataverse (read-only)

The first run used the pac route, which is the default when pac is installed, so `listBots` is
untested.

- `cs_list_agents` with `via: "dataverse"`.
- Pass if `publishedOn` and `authenticationMode` come back.

## 4. `cs_chat` — a diagnosis, not a retest (read-only)

E11 timed out and the record does not say how, so there is nothing to fix yet. Two calls separate
the two possible causes:

- `cs_chat` with an utterance, against a published agent. **Paste the whole result**, including which
  `transport` it chose and any endpoint in the error.
- The same call with `directLineSecret` set (Copilot Studio > Settings > Security > Web channel
  security). Treat the secret as a credential: it is long-lived and grants conversation access to
  anyone holding it, so keep it out of the results file.

If the secret path answers, the derived token endpoint is the bug. If both hang, the agent is not
reachable on the web channel and the tool is behaving correctly.

## 5. Phase G — solution ALM (WRITES)

Blocked on the first run because the whole pull ran inside one MCP call. Fixed since:

- `cs_pull_solution` with **`background: true`**, then poll `cs_job_status` with the returned `jobId`.
- `packagetype: "Unmanaged"` halves the work by skipping the second export.
- Then G2 to G6 from `docs/live-verification.md`.

Use a **development** environment for this one.

---

## Cleanup still outstanding from the first run

The first run created agents and the cleanup boxes were never ticked. Two of these are in a
production environment:

- `POC-IT-CopilotStudio-Dev`: `zzVerifyAgentDirect`, `zzVerifyAgent`
- `PROD-OPT`: `zzVerifyAgentE2E`, `zzVerifyAgent`

`cs_delete_agent` with `confirm: true`, or delete them in the portal. Worth doing before anything
else on this list.
