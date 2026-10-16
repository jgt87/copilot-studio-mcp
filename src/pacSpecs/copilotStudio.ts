/**
 * Copilot Studio administration over the Power Platform API (`pac copilot-studio`, preview).
 *
 * Most of this group repeats routes the server already calls itself (src/cloud/ppapi.ts:
 * evaluations, consent bypass, the channel manifest) or through `pac copilot` (delete,
 * quarantine); only the two commands with no equivalent are wrapped here. The rest stay
 * reachable through `cs_pac`.
 *
 * One entry per command; the flags come from `pac copilot-studio <command> help` on pac 2.13.1.
 */
import { ENV, type PacCommandSpec } from "../pacParams.js";

export const SPECS: PacCommandSpec[] = [
  {
    tool: "cs_reassign_agent_owner",
    title: "Reassign an agent's owner in its environment",
    description: "Make another person the owner of a Copilot Studio agent in its Power Platform environment, so they can edit, publish and manage it there. Admin operation. cs_reassign_org_agent is a separate tool for the Microsoft 365 side.",
    command: ["copilot-studio", "reassign-copilot-agent"],
    params: {
      environment: ENV,
      botId: { flag: "--bot-id", type: "string", required: true, description: "Agent id (GUID)" },
      newOwner: { flag: "--new-owner-aad-user-id", type: "string", required: true, description: "Entra ID object id of the new owner" },
    },
    mutating: true,
  },
  {
    tool: "cs_get_test_set",
    title: "Show one evaluation test set",
    description: "Show one evaluation test set of an agent with its test cases. Read-only. testSetId comes from cs_list_test_sets.",
    command: ["copilot-studio", "get-maker-evaluation-test-set"],
    params: {
      environment: ENV,
      botId: { flag: "--bot-id", type: "string", required: true, description: "Agent id (GUID)" },
      testSetId: { flag: "--test-set-id", type: "string", required: true, description: "Test set id (cs_list_test_sets)" },
    },
    mutating: false,
  },
];
