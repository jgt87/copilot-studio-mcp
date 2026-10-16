# API and dependency versions

What this server calls, the version it pins, and what the vendor currently publishes.
Checked against the public documentation and registries on 2026-09-21. "Current" means the
newest version the documentation shows for that surface; "preview" is the vendor's own label.

## REST APIs

| Surface | Host | Used by | Pinned in code | Current (2026-09-21) | Status |
| --- | --- | --- | --- | --- | --- |
| Power Platform API, `copilotstudio` maker evaluation and agent settings | `api.powerplatform.com` | `cs_list_test_sets`, `cs_run_evaluation`, `cs_get_evaluation_run`, `cs_list_evaluation_runs`, `cs_download_evaluation_snapshot`, `cs_get_connector_consent_bypass`, `cs_set_connector_consent_bypass`, `cs_download_channel_manifest` (`src/cloud/ppapi.ts`) | `2024-10-01` | `2024-10-01` (stable) | Up to date. Wrapped since 2026-09-21: Download Maker Evaluation Snapshot (Apr 2026), `mcsConnectionId` and `toolsConnections` on the run body, Get/Set Connector Consent Bypass (Jun 2026), Download Agent Channel Manifest (Jul 2026). Release 2026.6.3 announces create/update/list/get/delete agent and agent-component endpoints, but they are not in the REST reference yet. |
| Power Platform API, `environmentmanagement` | `api.powerplatform.com` | not used | n/a | `2024-10-01` (List Environments For User, Get Environment By Id For User: preview) | Documented replacement for the BAP call below. |
| Business Application Platform (BAP) environments | `api.bap.microsoft.com` | `cs_list_environments`, Dataverse URL lookup (`src/cloud/bap.ts`) | `2024-05-01` | Documented GA version is `2020-10-01`; Microsoft says its functionality "is made available in the newer versions of Power Platform API" | Undocumented version string. Works, but the documented path forward is `environmentmanagement` above. |
| Power Apps connector registry | `api.powerapps.com` | `cs_list_connectors`, `cs_describe_connector` (`src/catalog.ts`) | `2016-11-01` | `2016-11-01` (portal API, unversioned since) | Working but legacy. Power Platform API `connectivity` has List Connectors and Get Connector by ID (Jul 2025) at `2024-10-01`. |
| Power Apps connections | `api.powerapps.com` | `cs_bind_flow_connection` connection lookup (`src/cloud/connections.ts`) | `2016-11-01` | `2016-11-01` | Same as above. Power Platform API `connectivity` List Connections (Feb 2026, `2024-10-01`) is the documented successor. |
| Power Automate Process Simple | `api.flow.microsoft.com` | `cs_list_flow_runs`, `cs_get_flow_run`, `cs_run_flow`, `cs_explain_flow_run`, `cs_compare_flow_runs`, `cs_analyze_flow_health` (`src/cloud/flowruns.ts`) | `2016-11-01` | `2016-11-01` (portal API) | Working but undocumented. Power Platform API `powerautomate` has List Cloud Flows, List Flow Runs and List Flow Actions (Jun 2025, `2024-10-01`); no run-trigger or content-link equivalent yet, so the diagnostics still need this one. |
| Dataverse Web API | `<org>.crm.dynamics.com` | bots, components, publish, flows, connection references, transcripts (`src/cloud/dataverse*.ts`) | `v9.2` | `v9.2` | Up to date. |
| Copilot Studio DirectLine token | `<env>.environment.api.powerplatform.com/powervirtualagents/botsbyschema/...` | `cs_chat` (`src/cloud/chat.ts`) | `2022-03-01-preview` | `2022-03-01-preview` | Only version ever published for this route; still what the product docs show. The `powervirtualagents` namespace on `api.powerplatform.com` is deprecated in favour of `copilotstudio`, but that notice is about the admin API host, not this per-environment route. |
| Bot Framework DirectLine | `directline.botframework.com` | `cs_chat` conversations, activities, token refresh | `v3` | `v3` (3.0) | Up to date. |
| Microsoft Graph, Copilot Package Management (list, get) | `graph.microsoft.com` | `cs_list_org_agents`, `cs_get_org_agent` (`src/cloud/graphPackages.ts`) | `v1.0` | `v1.0` and `beta` | Up to date. Needs a Microsoft Agent 365 licence; global cloud only. |
| Microsoft Graph, Copilot Package Management (block, unblock, reassign) | `graph.microsoft.com` | `cs_block_org_agent`, `cs_reassign_org_agent` (`src/tools/m365.ts`) | `beta` | `beta` only | Still beta as of the 2026-07-01 page; no v1.0 route exists. |
| Logic Apps workflow definition schema | `schema.management.azure.com` | `cs_build_flow_definition`, `cs_create_flow`, `cs_add_flow` (`src/authoring/flowBuilder.ts`, `flows.ts`) | `2016-06-01` | `2016-06-01` | Up to date; the only published definition schema. |

## Power Platform API operations not wrapped by this server

All at `api-version=2024-10-01` unless noted. The `copilotstudio` how-to pages still show
`api-version=1` for quarantine and `2022-03-01-preview` for delete; the reference pages say `2024-10-01`.

| Operation | Added | Notes |
| --- | --- | --- |
| Get / Set Bot As Quarantined / Unquarantined | Apr 2025 | Server uses `pac copilot quarantine` (`cs_quarantine_agent`) instead. |
| Delete Copilot Agent | Jan 2026 | Server uses pac (`cs_delete_agent`). |
| Reassign Copilot Agent | Feb 2026 | `cs_reassign_agent_owner` through `pac copilot-studio reassign-copilot-agent` (2.13.1); `cs_reassign_org_agent` does the Microsoft 365 catalogue side through Graph. |
| Download Maker Evaluation Snapshot | Apr 2026 | `cs_download_evaluation_snapshot` (unverified live). |
| Get / Set Connector Consent Bypass | Jun 2026 | `cs_get_connector_consent_bypass`, `cs_set_connector_consent_bypass` (unverified live). |
| Download Agent Channel Manifest (M365 only) | Jul 2026 | `cs_download_channel_manifest` (unverified live). |
| Create / update / list / get / delete agents; get agent components | Announced in Copilot Studio 2026.6.3 | Not in the REST reference yet; nothing to wrap until it is. |
| `connectivity` List Connectors, Get Connector by ID, List Connections | Jul 2025, Feb 2026 | Documented successor to the `api.powerapps.com` calls. |
| `powerautomate` List Cloud Flows, List Flow Runs, List Flow Actions | Jun 2025 | Documented successor to part of the Process Simple calls. |
| `environmentmanagement` List / Get Environments For User (preview) | Jan 2025 | Documented successor to the BAP call. |

## Command-line tools and packages

| Dependency | Pinned / installed | Latest | Notes |
| --- | --- | --- | --- |
| Power Platform CLI (`pac`) | 2.13.1, updated from 2.12.2 on 2026-10-16 (2.12.2 from 2.11.2 on 2026-09-21) | 2.13.1 | 2.13.1 is a dependency-only release (SolutionPackagerLib, MSAL, Dataverse client): `help` for all 418 groups and commands is identical to 2.12.2, so the existing specs needed no change. The preview `pac copilot-studio` group (already in 2.12.2) mostly repeats routes `ppapi.ts` calls directly; its two commands without an equivalent are wrapped as `cs_reassign_agent_owner` and `cs_get_test_set`. Every wrapped command's flags re-checked against `pac <group> <command> help` on 2.12.2: `pac admin create` gained `--macro-region` and five preview Finance & Operations flags, `pac solution check` gained `--customEndpoint`; all now in the specs. Deprecated flags pac still lists (`--async` on assign-user, `--targetversion`, `--patchversion`, `--url` on auth create) are left out on purpose. `pac auth token` (2.11.1) prints a bearer token and is deliberately not wrapped. No `pac copilot` changes. |
| `@modelcontextprotocol/sdk` | ^1.30.0 (1.30.0 installed) | 1.30.0 on the 1.x line; 2.0.0 line published 2026-07-27 as `@modelcontextprotocol/server` / `client` | 1.30.0 speaks protocol 2025-11-25. Protocol 2026-07-28 (stateless, no initialize handshake, `server/discover`, `resultType`, `ttlMs`/`cacheScope` on list results, Logging deprecated) needs the 2.x packages. This server sends `SERVER_INSTRUCTIONS` in the initialize handshake, which 2026-07-28 removes, so that path needs a design decision before upgrading. |
| `@microsoft/agents-copilotstudio-client` | ^1.8.1 (1.8.1) | 1.8.1 (`next`: 1.9.0-beta.8) | Up to date. |
| `@microsoft/agents-activity` | ^1.8.1 (1.8.1) | 1.8.1 | Up to date. |
| `@azure/msal-node` | ^6.0.1 | 6.0.1 | Updated 2026-09-21. |
| `@azure/msal-node-extensions` | ^5.5.1 | 5.5.1 | Updated 2026-09-21. |
| `js-yaml` | ^5.4.2 | 5.4.2 | Updated 2026-09-21. |
| `diff` | ^9.0.0 | 9.0.0 | Updated 2026-09-21. Only `createTwoFilesPatch` is used; its output is unchanged for named files. |
| `zod` | ^4.6.5 | 4.6.5 | Updated 2026-09-21. `z.record` now takes a key schema everywhere. The MCP SDK emits the tool schemas through zod 4's own JSON Schema generator: a `$schema` draft-07 marker appears, nested objects no longer carry `additionalProperties: false`, and shared shapes come out as `definitions`. Same tools, same required fields. |
| `@types/node` | ^26.6.2 | 26.6.2 | Updated 2026-09-21. |
| `typescript` | ^7.0.2 | 7.0.2 | Up to date. |

## Sources

- Power Platform API reference: https://learn.microsoft.com/en-us/rest/api/power-platform/
- Versioning and support: https://learn.microsoft.com/en-us/power-platform/admin/programmability-versioning-support
- What's new or changed: https://learn.microsoft.com/en-us/power-platform/admin/programmability-whats-new-changed
- Copilot Studio Bots operations: https://learn.microsoft.com/en-us/rest/api/power-platform/copilotstudio/bots
- Evaluation REST API: https://learn.microsoft.com/en-us/microsoft-copilot-studio/analytics-agent-evaluation-rest-api
- Quarantine API (namespace notice): https://learn.microsoft.com/en-us/microsoft-copilot-studio/admin-api-quarantine
- Copilot Studio 2026.6.3 release notes: https://learn.microsoft.com/en-us/power-platform/released-versions/copilotstudio/2026.6.3
- Package Management API: https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/api/admin-settings/package/overview
- Dataverse Web API versions: https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/web-api-versions
- DirectLine security: https://learn.microsoft.com/en-us/microsoft-copilot-studio/configure-web-security
- pac release notes: https://www.nuget.org/packages/Microsoft.PowerApps.CLI
- MCP 2026-07-28 changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog
- MCP TypeScript SDK releases: https://github.com/modelcontextprotocol/typescript-sdk/releases
