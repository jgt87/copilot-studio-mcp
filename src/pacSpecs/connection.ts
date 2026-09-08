/**
 * Service-principal Dataverse connections.
 *
 * One entry per command; the flags come from `pac connection (service-principal Dataverse connections only) <command> help` on pac 2.11.2.
 */
import { ASYNC, ENV, SOLUTION_EXPORT, type PacCommandSpec } from "../pacParams.js";

export const SPECS: PacCommandSpec[] = [
  {
    tool: "cs_create_connection",
    title: "Create a service-principal Dataverse connection",
    description: "Create a Dataverse connection that authenticates with an app registration (application id + client secret) so flows and tools owned by a pipeline do not depend on a person. This is the only connection kind pac can create; connector connections (SharePoint, Outlook, MCP servers ...) are still authorised in the portal.",
    command: ["connection", "create"],
    params: {
      environment: ENV,
      tenantId: { flag: "--tenant-id", type: "string", required: true, description: "Entra tenant id" },
      name: { flag: "--name", type: "string", required: true, description: "Connection display name" },
      applicationId: { flag: "--application-id", type: "string", required: true, description: "App registration (client) id" },
      clientSecret: { flag: "--client-secret", type: "string", required: true, secret: true, description: "Client secret; prefer a secret from a vault, it is masked in logs" },
    },
    mutating: true,
  },
  {
    tool: "cs_update_connection",
    title: "Update a service-principal Dataverse connection",
    description: "Rotate the app registration or secret behind a service-principal Dataverse connection.",
    command: ["connection", "update"],
    params: {
      environment: ENV,
      tenantId: { flag: "--tenant-id", type: "string", required: true, description: "Entra tenant id" },
      connectionId: { flag: "--connection-id", type: "string", required: true, description: "Connection id (cs_list_connections)" },
      applicationId: { flag: "--application-id", type: "string", required: true, description: "App registration (client) id" },
      clientSecret: { flag: "--client-secret", type: "string", required: true, secret: true, description: "New client secret (masked in logs)" },
    },
    mutating: true,
  },
  {
    tool: "cs_delete_connection",
    title: "Delete a connection",
    description: "Delete a connection by id. Flows and tools bound to it stop working until rebound.",
    command: ["connection", "delete"],
    params: { environment: ENV, connectionId: { flag: "--connection-id", type: "string", required: true, description: "Connection id (cs_list_connections)" } },
    mutating: true,
  }
];
