/**
 * Business Application Platform (BAP) API: lists Power Platform environments
 * and resolves an environment id to its Dataverse and agent-management URLs.
 */
import { requestJson, type FetchLike } from "./http.js";

export const BAP_SCOPE = "https://service.powerapps.com/.default";
const BAP_BASE = "https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform";
const API_VERSION = "2024-05-01";

export interface EnvironmentInfo {
  environmentId: string;
  displayName: string;
  dataverseUrl: string | null;
  agentManagementUrl: string | null;
  environmentSku: string | null;
  isDefault: boolean;
  region: string | null;
}

interface BapEnvironment {
  name: string;
  properties?: {
    displayName?: string;
    environmentSku?: string;
    isDefault?: boolean;
    azureRegion?: string;
    linkedEnvironmentMetadata?: { instanceUrl?: string };
    runtimeEndpoints?: Record<string, string>;
    permissions?: Record<string, unknown>;
  };
}

function toInfo(env: BapEnvironment): EnvironmentInfo {
  const p = env.properties ?? {};
  return {
    environmentId: env.name,
    displayName: p.displayName ?? env.name,
    dataverseUrl: p.linkedEnvironmentMetadata?.instanceUrl?.replace(/\/+$/, "") ?? null,
    agentManagementUrl: p.runtimeEndpoints?.["microsoft.PowerVirtualAgents"] ?? null,
    environmentSku: p.environmentSku ?? null,
    isDefault: Boolean(p.isDefault),
    region: p.azureRegion ?? null,
  };
}

export async function listEnvironments(token: string, fetchImpl?: FetchLike): Promise<EnvironmentInfo[]> {
  const filter = encodeURIComponent("properties/environmentSku ne 'Platform'");
  const url = `${BAP_BASE}/environments?api-version=${API_VERSION}&$filter=${filter}&$expand=properties.permissions`;
  const data = await requestJson<{ value?: BapEnvironment[] }>(url, { token, fetchImpl });
  return (data?.value ?? []).map(toInfo);
}

export async function getEnvironment(token: string, environmentId: string, fetchImpl?: FetchLike): Promise<EnvironmentInfo> {
  const url = `${BAP_BASE}/environments/${encodeURIComponent(environmentId)}?api-version=${API_VERSION}&$expand=properties.permissions`;
  const env = await requestJson<BapEnvironment>(url, { token, fetchImpl });
  if (!env) throw new Error(`Environment ${environmentId} not found`);
  return toInfo(env);
}
