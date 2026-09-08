/**
 * Tools: tenant administration.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import path from "node:path";
import { z } from "zod";


import { errorMessage } from "../log.js";
import { adminProfileDefault, listProfiles, makerProfileDefault } from "../pacProfile.js";
import { backupTenant, summarizeBackup, type EnvironmentTarget } from "../tenantBackup.js";

import { clientArg, dataverseReadsFor, fail, server, tenantArg, text } from "./shared.js";

// ---- tenant administration -------------------------------------------------

server.registerTool(
  "cs_list_auth_profiles",
  {
    title: "List pac auth profiles",
    description: "The pac authentication profiles on this machine, which one is active, and which account each belongs to. Use it to find the name of the admin profile to pass as 'profile' to the admin tools. Read-only.",
    inputSchema: {},
  },
  async () => {
    try {
      const profiles = await listProfiles();
      return text({
        profiles: profiles.map((p) => ({ index: p.index, name: p.name, active: p.active, user: p.user, url: p.url, kind: p.kind })),
        defaults: { admin: adminProfileDefault() ?? null, maker: makerProfileDefault() ?? null },
        hint: profiles.length ? "Pass 'profile' to any pac-backed tool to run it as that account, or set CPS_ADMIN_PROFILE / CPS_PAC_PROFILE." : "No profiles yet. In a terminal: pac auth create --name admin --environment <id> (once per account).",
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_backup_tenant",
  {
    title: "Back up the tenant configuration to files",
    description:
      "Write the tenant's Power Platform configuration to local files for reference, diffing and source control: tenant settings, environments, DLP policies, environment groups, service principals, registered applications and app templates, plus per environment its details, solutions, agents, connections, security roles and platform backups. Read-only for the tenant; it only writes files. Runs as the admin account: pass 'profile' or set CPS_ADMIN_PROFILE. Each capture is independent, so a command the account cannot run is reported in 'skipped' and the rest still completes.",
    inputSchema: {
      dir: z.string().describe("Folder to write the backup into (created; existing files with the same names are overwritten)"),
      profile: z.string().optional().describe("pac auth profile of the admin account; default CPS_ADMIN_PROFILE, then the active profile"),
      environments: z.array(z.object({ id: z.string(), name: z.string().optional(), url: z.string().optional() })).optional().describe("Environments to detail; default: every environment 'pac admin list' returns"),
      maxEnvironments: z.number().optional().describe("Default 50"),
      includeEnvironments: z.boolean().optional().describe("Default true; false captures tenant level only"),
      includeBackups: z.boolean().optional().describe("Default true: the platform backups of each environment"),
      includeRoles: z.boolean().optional().describe("Default true: the security roles of each environment"),
      includeDataverse: z.boolean().optional().describe("Default true: flows, connection references, environment variables and agents per environment, when a Dataverse sign-in is cached (cs_login)"),
      tenantId: tenantArg,
      clientId: clientArg,
    },
  },
  async (a) => {
    try {
      const dataverse = a.includeDataverse === false ? null : async (env: EnvironmentTarget) => {
        const dv = await dataverseReadsFor(env.url ?? env.id, a.tenantId, a.clientId);
        return dv.reads ? (dv.reads as unknown as Record<string, unknown>) : null;
      };
      const report = await backupTenant({
        dir: a.dir,
        profile: a.profile ?? adminProfileDefault(),
        environments: a.environments,
        maxEnvironments: a.maxEnvironments,
        includeEnvironments: a.includeEnvironments,
        includeBackups: a.includeBackups,
        includeRoles: a.includeRoles,
        dataverse,
      });
      return text({ ...summarizeBackup(report), manifest: path.join(report.dir, "backup.json"), hint: "Commit this folder to keep a history of the tenant configuration; re-run it and diff to see what changed." });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
