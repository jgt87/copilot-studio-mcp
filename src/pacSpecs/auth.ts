/**
 * pac authentication profiles.
 *
 * One entry per command; the flags come from `pac auth <command> help` on pac 2.11.2.
 */
import { ASYNC, ENV, SOLUTION_EXPORT, type PacCommandSpec } from "../pacParams.js";

export const SPECS: PacCommandSpec[] = [
  {
    tool: "cs_create_auth_profile",
    title: "Create a pac auth profile",
    description: "Create a pac authentication profile without a person at the keyboard: service principal (applicationId + clientSecret + tenant), certificate, managed identity, or GitHub / Azure DevOps federation. For interactive sign-in run 'pac auth create' in a terminal instead: pac opens its own browser and this tool would block until it completes.",
    command: ["auth", "create"],
    params: {
      name: { flag: "--name", type: "string", description: "Profile name (max 30 characters)" },
      environment: { flag: "--environment", type: "string", description: "Default environment for the profile (id, URL, unique or partial name)" },
      applicationId: { flag: "--applicationId", type: "string", description: "App registration (client) id" },
      clientSecret: { flag: "--clientSecret", type: "string", secret: true, description: "Client secret (masked in logs)" },
      tenant: { flag: "--tenant", type: "string", description: "Tenant id (required with applicationId)" },
      certificateDiskPath: { flag: "--certificateDiskPath", type: "string", description: "Certificate file for certificate auth" },
      certificatePassword: { flag: "--certificatePassword", type: "string", secret: true, description: "Certificate password (masked in logs)" },
      username: { flag: "--username", type: "string", description: "User name for username/password auth (not recommended)" },
      password: { flag: "--password", type: "string", secret: true, description: "Password (masked in logs)" },
      cloud: { flag: "--cloud", type: "string", description: "Cloud instance (Public, UsGov, UsGovHigh, UsGovDod, China)" },
      deviceCode: { flag: "--deviceCode", type: "boolean", description: "Use the device-code flow for interactive sign-in (blocks until done)" },
      managedIdentity: { flag: "--managedIdentity", type: "boolean", description: "Use the default Azure identity" },
      githubFederated: { flag: "--githubFederated", type: "boolean", description: "GitHub federated credential (needs tenant and applicationId)" },
      azureDevOpsFederated: { flag: "--azureDevOpsFederated", type: "boolean", description: "Azure DevOps federated credential (needs tenant and applicationId)" },
    },
    mutating: false,
    timeoutMs: 10 * 60_000,
    note: "A service-principal profile needs an application user with a security role in each environment it will touch.",
  },
  {
    tool: "cs_select_auth_profile",
    title: "Select the active pac auth profile",
    description: "Make a pac auth profile the active one, by index (cs_init lists them) or name.",
    command: ["auth", "select"],
    params: { index: { flag: "--index", type: "number", description: "Profile index" }, name: { flag: "--name", type: "string", description: "Profile name" } },
    mutating: false,
  },
  {
    tool: "cs_auth_who",
    title: "Show the active pac auth profile",
    description: "Who pac is signed in as, and against which environment.",
    command: ["auth", "who"],
    params: {},
    mutating: false,
  },
  {
    tool: "cs_delete_auth_profile",
    title: "Delete a pac auth profile",
    description: "Remove a pac auth profile by index or name (local credential store only).",
    command: ["auth", "delete"],
    params: { index: { flag: "--index", type: "number", description: "Profile index" }, name: { flag: "--name", type: "string", description: "Profile name" } },
    mutating: false,
  }
];
