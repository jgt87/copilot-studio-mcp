/**
 * Tools: environments / agents.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import { z } from "zod";


import { errorMessage, log } from "../log.js";
import { explainFailure, findPac, parseCopilotList, runPac } from "../pac.js";

import { BAP_SCOPE, getToken, resolveTenantId, type AuthConfig } from "../auth.js";
import { listEnvironments } from "../cloud/bap.js";
import { dataverseScope, listBots } from "../cloud/dataverse.js";
import { clientArg, cloudContext, envArg, fail, server, tail, tenantArg, text, tryWorkspace, workspaceArg } from "./shared.js";

// ---- environments / agents ------------------------------------------------

server.registerTool(
  "cs_list_environments",
  { title: "List environments", description: "List Power Platform environments the signed-in user can access (BAP API), with Dataverse URLs.", inputSchema: { tenantId: tenantArg, clientId: clientArg } },
  async ({ tenantId, clientId }) => {
    try {
      const cfg: AuthConfig = { tenantId: resolveTenantId(tenantId), clientId };
      const tok = await getToken(cfg, [BAP_SCOPE]);
      const envs = await listEnvironments(tok.accessToken);
      return text({ count: envs.length, environments: envs });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_list_agents",
  {
    title: "List agents",
    description: "List Copilot Studio agents in an environment. via 'pac' uses 'pac copilot list' (needs a pac auth profile); via 'dataverse' queries the bots table with the MSAL token. Default auto: pac when available, else dataverse.",
    inputSchema: { environmentId: envArg, dataverseUrl: z.string().optional(), via: z.enum(["auto", "pac", "dataverse"]).optional(), ownerOnly: z.boolean().optional(), tenantId: tenantArg, clientId: clientArg, workspace: workspaceArg },
  },
  async (args) => {
    try {
      const via = args.via ?? "auto";
      if (via === "pac" || (via === "auto" && findPac())) {
        const ws = tryWorkspace(args.workspace);
        const envId = args.environmentId ?? ws?.sync.environmentId ?? process.env.CPS_ENVIRONMENT_ID;
        const r = await runPac(["copilot", "list", ...(envId ? ["--environment", envId] : [])], { timeoutMs: 120_000 });
        if (r.ok)
          return text({
            via: "pac",
            environmentId: envId ?? "(active profile)",
            agents: parseCopilotList(r.stdout),
            // The two routes return different columns, and picking pac is invisible otherwise.
            note: "Listed through pac, which reports componentState, statusCode, stateCode and solutionId. For publishedOn, authenticationMode and ownership, call again with via: 'dataverse' (needs a cs_login that covers Dataverse; cs_init reports whether it does).",
            raw: tail(r.stdout, 40),
          });
        if (via === "pac") return fail(explainFailure(r));
        log(`pac copilot list failed (${explainFailure(r)}); falling back to Dataverse`);
      }
      const ctx = await cloudContext(args, { dataverse: true });
      const tok = await getToken(ctx.authCfg, [dataverseScope(ctx.dataverseUrl as string)]);
      const bots = await listBots(ctx.dataverseUrl as string, tok.accessToken, { ownerOnly: args.ownerOnly });
      return text({ via: "dataverse", dataverseUrl: ctx.dataverseUrl, count: bots.length, agents: bots });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
