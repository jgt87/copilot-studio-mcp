/**
 * Tools: per-agent settings and downloads through the Power Platform API
 * `copilotstudio` namespace that are neither authoring nor evaluation.
 *
 * Connector consent bypass is an admin switch: on, the agent's connector tools
 * run without each end user being asked to approve the connection first. The
 * channel manifest is the Teams / Microsoft 365 app package the portal offers
 * as "Download .zip" on the channel page. Both follow the published reference
 * (June and July 2026) and are unverified against a live tenant.
 */
import fs from "node:fs";
import { z } from "zod";

import { getToken, PPAPI_SCOPE } from "../auth.js";
import { downloadChannelManifest, getConnectorConsentBypass, MANIFEST_CHANNELS, setConnectorConsentBypass } from "../cloud/ppapi.js";
import { errorMessage } from "../log.js";
import { botArg, clientArg, cloudContext, confirmArg, downloadPath, dryRun, envArg, fail, server, tenantArg, text, workspaceArg } from "./shared.js";

const UNVERIFIED = "Follows the published Power Platform API reference; not yet verified against a live tenant.";

server.registerTool(
  "cs_get_connector_consent_bypass",
  {
    title: "Read connector consent bypass",
    description:
      "Answer 'do users have to approve this agent's connectors?': read whether an admin has switched connector consent bypass on for the agent, so its connector tools run without each end user consenting to the connection first. Read-only. cs_set_connector_consent_bypass is the separate step that changes it. " +
      UNVERIFIED,
    inputSchema: { workspace: workspaceArg, environmentId: envArg, botId: botArg, tenantId: tenantArg, clientId: clientArg },
  },
  async (a) => {
    try {
      const ctx = await cloudContext(a, { environment: true, bot: true });
      const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
      const { raw: _raw, ...setting } = await getConnectorConsentBypass(tok.accessToken, ctx.environmentId as string, ctx.botId as string);
      return text({
        botId: ctx.botId,
        ...setting,
        meaning: setting.adminConsentBypass === true ? "end users are not asked to consent to the agent's connectors" : setting.adminConsentBypass === false ? "each end user is asked to consent to the agent's connectors on first use" : "the service did not report the setting",
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_set_connector_consent_bypass",
  {
    title: "Switch connector consent bypass",
    description:
      "Switch connector consent bypass on or off for one agent. On, end users stop being asked to approve the agent's connectors and the tools run straight away; off restores the consent prompt. An admin setting through the Power Platform API, so the signed-in user needs a Power Platform or Copilot Studio admin role. Changes a live environment: requires confirm: true. " +
      UNVERIFIED,
    inputSchema: {
      workspace: workspaceArg,
      environmentId: envArg,
      botId: botArg,
      tenantId: tenantArg,
      clientId: clientArg,
      enabled: z.boolean().describe("true switches the bypass on (no consent prompt), false switches it off"),
      confirm: confirmArg,
    },
  },
  async (a) => {
    try {
      const ctx = await cloudContext(a, { environment: true, bot: true });
      if (!a.confirm) {
        return dryRun(`${a.enabled ? "Switch on" : "Switch off"} connector consent bypass for agent ${ctx.botId} in environment ${ctx.environmentId}`, {
          effect: a.enabled ? "every user of the agent stops being asked to consent to its connectors; the tools run under the configured connections" : "users are asked to consent to the agent's connectors again on first use",
          call: `PUT https://api.powerplatform.com/copilotstudio/environments/${ctx.environmentId}/bots/${ctx.botId}/api/connectorConsentBypass`,
        });
      }
      const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
      const { raw: _raw, ...setting } = await setConnectorConsentBypass(tok.accessToken, ctx.environmentId as string, ctx.botId as string, a.enabled);
      return text({ botId: ctx.botId, ...setting, changed: true });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

server.registerTool(
  "cs_download_channel_manifest",
  {
    title: "Download the Teams / Microsoft 365 app package",
    description:
      "Answer 'give me the Teams app package for this agent': download the channel manifest zip (manifest.json plus icons) for an agent published to the Microsoft 365 and Teams channel, the same file the portal offers as 'Download .zip', for sideloading or the Teams admin centre. Writes only the zip file; nothing in the environment changes. The agent must already be published to that channel. " +
      UNVERIFIED,
    inputSchema: {
      workspace: workspaceArg,
      environmentId: envArg,
      botId: botArg,
      tenantId: tenantArg,
      clientId: clientArg,
      channel: z.enum(MANIFEST_CHANNELS).optional().describe("Channel name; M365 is the only one the API supports today"),
      includeAgentSchema: z.boolean().optional().describe("Also put the agent schema in the package"),
      outputPath: z.string().optional().describe("Where to write the zip. Default: beside the workspace, else the temp folder"),
    },
  },
  async (a) => {
    try {
      const ctx = await cloudContext(a, { environment: true, bot: true });
      const tok = await getToken(ctx.authCfg, [PPAPI_SCOPE]);
      const file = await downloadChannelManifest(tok.accessToken, ctx.environmentId as string, ctx.botId as string, { channel: a.channel, includeAgentSchema: a.includeAgentSchema });
      const out = downloadPath(a.workspace, file.fileName ?? `${a.channel ?? "M365"}-manifest.zip`, a.outputPath);
      fs.writeFileSync(out, file.bytes);
      return text({ file: out, bytes: file.bytes.byteLength, contentType: file.contentType, channel: a.channel ?? "M365", includeAgentSchema: Boolean(a.includeAgentSchema) });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
