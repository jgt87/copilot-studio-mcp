/**
 * Dataverse Web API calls the server needs.
 *
 * The calls live in three modules by table; this one keeps them reachable
 * under the original import path:
 *  - `dataverseBots.ts`: agents, their components, and publishing
 *  - `dataverseFlows.ts`: cloud flows (the `workflow` table)
 *  - `dataverseEnvironment.ts`: connection references and environment variables
 *
 * `dataverseApi.ts` holds what all three share.
 */
export { dataverseScope } from "./dataverseApi.js";
export { getBot, listBotComponents, listBots, publishBot, whoAmI, type BotComponentRow, type BotDetails, type BotRow, type PublishResult } from "./dataverseBots.js";
export { FLOW_STATES, createFlow, getFlow, listFlows, setFlowState, updateFlow, type FlowDetails, type FlowRow, type FlowState } from "./dataverseFlows.js";
export { listConnectionReferences, listEnvironmentVariables, type ConnectionReferenceRow, type EnvironmentVariableRow } from "./dataverseEnvironment.js";
