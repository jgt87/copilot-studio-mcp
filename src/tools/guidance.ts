/**
 * Tools: guidance.
 *
 * Sliced out of index.ts; the registrations themselves are unchanged.
 * index.ts imports this module for its side effect, in tool-list order.
 */
import { z } from "zod";


import { errorMessage } from "../log.js";
import { findPac } from "../pac.js";
import { GUIDE_TOPICS, TOPIC_SUMMARY, guide, nextSteps, type GuideTopic } from "../guide.js";

import { fail, server, text, tryWorkspace, workspaceArg } from "./shared.js";

// ---- guidance -------------------------------------------------------------

server.registerTool(
  "cs_guide",
  {
    title: "How to use this server",
    description: `Explain how to do one part of Copilot Studio agent development with this server's tools: ${GUIDE_TOPICS.map((t) => `'${t}' (${TOPIC_SUMMARY[t]})`).join(", ")}. Read the relevant topic when you do not know which tools a job needs or what order they go in; it names the tool for each step and the manual portal steps that cannot be automated. It only explains - it changes nothing and does no work, so when the user asked for something to be built, written or run, call the tool that does it rather than this one. Also returns next steps for the workspace at hand.`,
    inputSchema: {
      topic: z.enum(GUIDE_TOPICS as [GuideTopic, ...GuideTopic[]]).optional().describe("Default getting-started"),
      workspace: workspaceArg,
    },
  },
  async ({ topic, workspace }) => {
    try {
      const t = (topic ?? "getting-started") as GuideTopic;
      const ws = tryWorkspace(workspace);
      const steps = nextSteps(ws, { pacFound: Boolean(findPac()) });
      return text(`${guide(t)}\n\n---\n\n## Next steps here\n\n${steps.map((s) => `- ${s}`).join("\n")}\n\nOther topics: ${GUIDE_TOPICS.filter((x) => x !== t).join(", ")}.`);
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);

// Prompts: the same walkthroughs as ready-made requests, for clients that show them as commands.
const PROMPTS: { name: string; title: string; description: string; topic: GuideTopic; ask: string }[] = [
  { name: "new-agent", title: "Build a new agent", topic: "getting-started", description: "Create an agent in a solution and take it to a published, tested state.", ask: "Help me build a new Copilot Studio agent. Ask me what it should do and who it is for, then work through the steps: check prerequisites, pick or create the solution, create the agent, draft the instructions, add knowledge and tools, review, validate, push, publish and chat-test. Show me each dry run before confirming anything." },
  { name: "add-knowledge", title: "Add a knowledge source", topic: "knowledge", description: "Add website, SharePoint, Graph connector or file knowledge to the current agent.", ask: "Add a knowledge source to the agent in my workspace. Ask which kind and which URL or files, check whether the agent's authentication mode supports it, write it, validate, and tell me what still has to happen in the portal." },
  { name: "add-tool", title: "Add a tool", topic: "tools", description: "Find a connector operation and add it as a tool, with its connection step.", ask: "Add a tool to the agent in my workspace. Find the connector and operation first, show me the parameters, write the tool with a specific model description, then tell me exactly which connection I have to authorise in the portal." },
  { name: "write-instructions", title: "Write the instructions", topic: "instructions", description: "Draft or refine the agent's instructions with AI Builder.", ask: "Draft the instructions for the agent in my workspace. Ask me for the purpose, audience, tone and boundaries, generate them, show me the text for review, and only apply them when I agree." },
  { name: "review-and-push", title: "Review, validate and push", topic: "publish-and-test", description: "Run the review and validation, then push and publish with confirmation.", ask: "Review the agent in my workspace, fix what is safe to fix, validate it, then show me the push dry run including any portal drift. After I confirm, push, publish and chat-test it." },
  { name: "check-drift", title: "Check for portal changes", topic: "drift", description: "See what makers changed in Copilot Studio since the last sync.", ask: "Check whether anyone changed the agent in Copilot Studio since my last sync. Summarise what changed, by whom, and whether it collides with my local edits, then tell me whether to pull." },
];

for (const p of PROMPTS) {
  server.registerPrompt(p.name, { title: p.title, description: p.description }, () => ({
    messages: [{ role: "user" as const, content: { type: "text" as const, text: `${p.ask}\n\nFollow the walkthrough from cs_guide topic '${p.topic}'.` } }],
  }));
}
