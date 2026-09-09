/**
 * Tools: the Microsoft 365 agent catalogue (Package Management API).
 *
 * The tenant-wide view of agents, which is the one thing the Power Platform
 * side cannot answer: whether a published agent actually reached users, and
 * whether an admin has blocked it. index.ts imports this module for its side
 * effect, in tool-list order.
 */
import { z } from "zod";

import { errorMessage } from "../log.js";
import { getToken } from "../auth.js";
import {
  ELEMENT_TYPES,
  GRAPH_PACKAGES_SCOPE,
  GRAPH_PACKAGES_WRITE_SCOPE,
  HOSTS,
  PLATFORMS,
  getPackage,
  listPackages,
  reassignPackage,
  setPackageBlocked,
  summarizePackages,
} from "../cloud/graphPackages.js";
import { clientArg, cloudContext, confirmArg, dryRun, fail, server, tenantArg, text, workspaceArg } from "./shared.js";

const LICENCE_NOTE = "Needs a Microsoft Agent 365 licence and is global-cloud only. Unverified against a live tenant.";

/** Graph is a resource of its own: a separate consent from Dataverse and the Power Platform API. */
async function graphToken(a: { workspace?: string; tenantId?: string; clientId?: string }, write = false): Promise<string> {
  const ctx = await cloudContext(a);
  const tok = await getToken(ctx.authCfg, [write ? GRAPH_PACKAGES_WRITE_SCOPE : GRAPH_PACKAGES_SCOPE]);
  return tok.accessToken;
}

const idArg = z.string().describe("Package id from cs_list_org_agents, e.g. P_19ae1zz1-56bc-505a-3d42-156df75a4xxy");
const versionArg = z.enum(["v1.0", "beta"]).optional().describe("Graph version for reads. Default v1.0; beta may carry fields v1.0 does not.");

server.registerTool(
  "cs_list_org_agents",
  {
    title: "List agents in the Microsoft 365 catalogue",
    description:
      "Every agent in the organisation's Microsoft 365 catalogue, across environments, with the things Power Platform cannot see: who the agent is available to, where it is deployed, and whether an admin has blocked it. Defaults to agents built in Copilot Studio; pass platform: 'all' to include the Agent Builder and acquired apps. Read-only. Uses Microsoft Graph, a separate sign-in from Dataverse (cs_login scope 'graph'). " +
      LICENCE_NOTE,
    inputSchema: {
      workspace: workspaceArg,
      tenantId: tenantArg,
      clientId: clientArg,
      platform: z.enum([...PLATFORMS, "all"]).optional().describe("Build platform. Default 'Copilot Studio'; 'all' does not filter."),
      host: z.enum(HOSTS).optional().describe("Only agents surfaced in this host"),
      elementType: z.enum(ELEMENT_TYPES).optional().describe("Only packages containing this element type"),
      modifiedSince: z.string().optional().describe("ISO instant; only packages modified after it, e.g. 2026-01-01T00:00:00Z"),
      filter: z.string().optional().describe("Extra raw OData $filter, combined with the options above"),
      top: z.number().optional().describe("Maximum packages per page"),
      allPages: z.boolean().optional().describe("Follow paging until the catalogue is exhausted (capped)"),
      version: versionArg,
    },
  },
  async (a) => {
    try {
      const token = await graphToken(a);
      const platform = a.platform === "all" ? null : (a.platform ?? "Copilot Studio");
      const r = await listPackages(token, {
        platform,
        host: a.host ?? null,
        elementType: a.elementType ?? null,
        modifiedSince: a.modifiedSince ?? null,
        filter: a.filter ?? null,
        top: a.top ?? null,
        allPages: a.allPages,
        version: a.version,
      });
      return text({
        ...summarizePackages(r.packages),
        platform: platform ?? "all",
        ...(r.more ? { more: "further pages exist; pass allPages: true or narrow the filter" } : {}),
        agents: r.packages,
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_get_org_agent",
  {
    title: "Read one agent from the Microsoft 365 catalogue",
    description: "Full catalogue entry for one agent: metadata, element types, availability and deployment state, and whether it is blocked. The raw body is returned alongside the mapped fields, because the detail resource carries more than the list rows. Read-only (cs_login scope 'graph'). " + LICENCE_NOTE,
    inputSchema: { workspace: workspaceArg, tenantId: tenantArg, clientId: clientArg, id: idArg, version: versionArg },
  },
  async (a) => {
    try {
      const token = await graphToken(a);
      const r = await getPackage(token, a.id, { version: a.version });
      return text({ agent: r.package, raw: r.raw });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_block_org_agent",
  {
    title: "Block or unblock an agent for the organisation",
    description:
      "Block an agent so nobody in the organisation can use it, or lift an existing block. This is a governance action across the whole tenant, not a deployment one: it does not unpublish or delete the agent, and it affects every user at once. Changes a live tenant: requires confirm: true. Needs the CopilotPackages.ReadWrite.All permission and runs against Graph beta, the only version that exposes it (cs_login scope 'graph_write'). " +
      LICENCE_NOTE,
    inputSchema: {
      workspace: workspaceArg,
      tenantId: tenantArg,
      clientId: clientArg,
      id: idArg,
      blocked: z.boolean().describe("true blocks the agent for everyone, false lifts the block"),
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      if (!a.confirm) {
        return dryRun(`${a.blocked ? "Block" : "Unblock"} package ${a.id} for the whole organisation`, {
          effect: a.blocked ? "every user in the tenant loses access to this agent immediately" : "the agent becomes usable again for whoever it is available to",
          call: `POST https://graph.microsoft.com/beta/copilot/admin/catalog/packages/${a.id}/${a.blocked ? "block" : "unblock"}`,
        });
      }
      const token = await graphToken(a, true);
      return text(await setPackageBlocked(token, a.id, a.blocked));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_reassign_org_agent",
  {
    title: "Reassign an agent's owner",
    description:
      "Hand ownership of a catalogue agent to another user, by their Entra object id. Used when the owner leaves the organisation. Changes a live tenant: requires confirm: true. Needs CopilotPackages.ReadWrite.All and runs against Graph beta (cs_login scope 'graph_write'). " +
      LICENCE_NOTE,
    inputSchema: {
      workspace: workspaceArg,
      tenantId: tenantArg,
      clientId: clientArg,
      id: idArg,
      userId: z.string().describe("Entra object id of the new owner"),
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      if (!a.confirm) {
        return dryRun(`Reassign package ${a.id} to user ${a.userId}`, {
          effect: "the current owner loses ownership; this does not change who can use the agent",
          call: `POST https://graph.microsoft.com/beta/copilot/admin/catalog/packages/${a.id}/reassign`,
        });
      }
      const token = await graphToken(a, true);
      return text(await reassignPackage(token, a.id, a.userId));
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
