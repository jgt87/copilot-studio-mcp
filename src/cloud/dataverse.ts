/**
 * Dataverse Web API calls the server needs.
 *
 * The calls live in four modules by table; this one keeps them reachable
 * under the original import path:
 *  - `dataverseBots.ts`: agents, their components, and publishing
 *  - `dataverseFlows.ts`: cloud flows (the `workflow` table)
 *  - `dataverseEnvironment.ts`: connection references and environment variables
 *  - `dataverseTranscripts.ts`: conversation transcripts (read-only)
 *
 * `dataverseApi.ts` holds what they share.
 */
export { dataverseScope } from "./dataverseApi.js";
export { getBot, listBotComponents, listBots, publishBot, whoAmI, type BotComponentRow, type BotDetails, type BotRow, type PublishResult } from "./dataverseBots.js";
export {
  FLOW_STATES,
  bindConnectionInClientData,
  connectionReferenceLogicalName,
  connectionReferenceShape,
  connectorOfReference,
  createFlow,
  deleteFlow,
  flowConnectionReferences,
  getFlow,
  listFlows,
  setFlowState,
  updateFlow,
  type ConnectionRefShape,
  type FlowConnectionReference,
  type FlowDetails,
  type FlowRow,
  type FlowState,
} from "./dataverseFlows.js";
export { bindConnectionReference, listConnectionReferences, listEnvironmentVariables, type ConnectionReferenceRow, type EnvironmentVariableRow } from "./dataverseEnvironment.js";
export {
  getTranscript,
  listTranscripts,
  parseContent,
  questionsFromTranscripts,
  summarizeTranscript,
  summarizeTranscripts,
  type SessionOutcome,
  type Transcript,
  type TranscriptStats,
  type TranscriptSummary,
  type TranscriptTurn,
} from "./dataverseTranscripts.js";
