/**
 * Environments through pac, without an MSAL sign-in.
 *
 * One entry per command; the flags come from `pac env <command> help` on pac 2.11.2.
 */
import { ASYNC, ENV, SOLUTION_EXPORT, type PacCommandSpec } from "../pacParams.js";

export const SPECS: PacCommandSpec[] = [
  {
    tool: "cs_env_list",
    title: "List environments (pac)",
    description: "Environments visible to the active pac auth profile. The pac-based alternative to cs_list_environments, which needs a cs_login.",
    command: ["env", "list"],
    params: { filter: { flag: "--filter", type: "string", description: "Only environments whose name contains this text" } },
    mutating: false,
  },
  {
    tool: "cs_env_who",
    title: "Show environment details (pac)",
    description: "Organisation id, URL, version and the signed-in user for an environment.",
    command: ["env", "who"],
    params: { environment: ENV },
    mutating: false,
  },
  {
    tool: "cs_env_fetch",
    title: "Run a FetchXML query",
    description: "Run a FetchXML query against Dataverse through pac (read-only), e.g. to inspect bot or botcomponent rows without an MSAL sign-in.",
    command: ["env", "fetch"],
    params: {
      environment: ENV,
      xml: { flag: "--xml", type: "string", description: "FetchXML query text" },
      xmlFile: { flag: "--xmlFile", type: "string", description: "File containing the FetchXML query" },
    },
    mutating: false,
  },
  {
    tool: "cs_env_select",
    title: "Select the default environment for the pac profile",
    description: "Set the environment that pac commands use when none is passed (local profile setting).",
    command: ["env", "select"],
    params: { environment: { flag: "--environment", type: "string", required: true, description: "Environment id, URL, unique or partial name" } },
    mutating: false,
  }
];
