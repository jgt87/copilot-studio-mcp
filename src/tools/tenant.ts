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
import { assignUsers, describePlan, readAssignmentCsv, type Assignment } from "../adminAssign.js";

import { backgroundArg, clientArg, confirmArg, dataverseReadsFor, dryRun, fail, maybeBackground, server, tenantArg, text } from "./shared.js";

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


server.registerTool(
  "cs_admin_assign_users",
  {
    title: "Assign security roles to a roster of users",
    description:
      "Give many users their security roles in one environment, from a CSV roster or an inline list. pac assigns one user and one role per call, so a roster of ten developers with three roles each is thirty calls; this expands the roster and runs them under a single approval. Without confirm it returns the plan: every user-and-role pair it would attempt, so you can read the whole thing before any of it happens. Rows are independent, so a bad UPN or a role the environment does not have is reported and the rest still run. Changes a live environment: requires confirm: true. Runs as the admin account: pass 'profile' or set CPS_ADMIN_PROFILE. Prefer cs_admin_assign_group when the roster is really a group: that is one call per role however many people are in it, and new joiners inherit access. Unverified against a live tenant.",
    inputSchema: {
      environment: z.string().describe("Environment id or URL to assign the roles in"),
      csv: z.string().optional().describe("Path to a CSV roster. Header row needs a user column (user, upn, email) and a roles column (roles, role); several roles in one cell separated by comma, semicolon or pipe. Optional businessUnit and applicationUser columns. A user on several rows accumulates their roles."),
      assignments: z
        .array(z.object({ user: z.string(), roles: z.array(z.string()), applicationUser: z.boolean().optional(), businessUnit: z.string().optional() }))
        .optional()
        .describe("Roster inline instead of a CSV file"),
      businessUnit: z.string().optional().describe("Business unit for rows that do not name one"),
      continueOnError: z.boolean().optional().describe("Default true: one failed row does not abort the roster. false stops at the first failure."),
      profile: z.string().optional().describe("pac auth profile of the admin account; default CPS_ADMIN_PROFILE, then the active profile"),
      confirm: confirmArg,
      background: backgroundArg,
    },
  },
  async (a) => {
    try {
      let assignments: Assignment[] = a.assignments ?? [];
      const warnings: string[] = [];
      if (a.csv) {
        const parsed = readAssignmentCsv(a.csv);
        assignments = [...assignments, ...parsed.assignments];
        warnings.push(...parsed.warnings);
      }
      if (!assignments.length) {
        return fail(`No assignments to make.${warnings.length ? ` ${warnings.join(" ")}` : " Pass csv or assignments."}`);
      }

      const plan = describePlan(a.environment, assignments, { businessUnit: a.businessUnit });
      if (!a.confirm) {
        return dryRun(`Assign ${plan.assignments} security role(s) to ${plan.users} user(s) in ${a.environment}`, {
          ...plan,
          ...(warnings.length ? { warnings } : {}),
          note: "One approval covers the whole roster. Check the pairs above, and that every role name exists in this environment (cs_admin_list_security_roles). A user who is not in the environment yet cannot hold a role.",
        });
      }

      return await maybeBackground({ tool: "cs_admin_assign_users", label: `assign roles in ${a.environment}`, background: a.background }, async () => {
        const report = await assignUsers({
          environment: a.environment,
          assignments,
          businessUnit: a.businessUnit,
          continueOnError: a.continueOnError,
          profile: a.profile,
        });
        return {
          ...report,
          ...(warnings.length ? { warnings } : {}),
          ...(report.failed ? { failures: report.results.filter((r) => !r.ok) } : {}),
        };
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
