/**
 * What a new agent needs decided, and what the user has to know to decide it.
 *
 * `cs_create_agent` used to require a publisher prefix and a project directory
 * outright, so a model with no way to ask invented them: "contoso", "./agent".
 * A prefix is not cosmetic - it is welded onto the schema name of every
 * component the agent will ever have, and it has to match the publisher of the
 * solution the agent lands in, or the import fails - and a project directory
 * that already has files in it is refused by pac several steps later. Both are
 * the user's call, so the tool asks, with the real choices where the server can
 * read them (publishers and solutions in the environment) and a concrete
 * suggestion where it cannot.
 *
 * Everything here is pure so `test/create-agent.test.js` can pin the questions
 * and the wording; the caller does the reading.
 */
import path from "node:path";
import { kebab } from "./authoring/util.js";
import type { NeedChoice, NeedSpec } from "./needs.js";

/** A publisher as the environment knows it: the prefix is what matters. */
export interface PublisherChoice {
  prefix: string;
  name: string;
  /** True for the environment's default publisher (the one the portal uses). */
  isDefault?: boolean;
}

export interface SolutionChoice {
  uniqueName: string;
  friendlyName: string;
  publisherPrefix?: string | null;
}

export interface CreateAgentAsk {
  name?: string;
  publisherPrefix?: string;
  projectDir?: string;
  environment?: string;
  solutionName?: string;
}

export interface CreateAgentFacts {
  cwd: string;
  /** Publishers in the environment; null when they could not be read. */
  publishers?: PublisherChoice[] | null;
  /** Unmanaged solutions in the environment; null when they could not be read. */
  solutions?: SolutionChoice[] | null;
}

/** The folder to suggest: a sibling of where the session already is, named after the agent. */
export function suggestedProjectDir(cwd: string, name: string | undefined): string {
  return path.join(cwd, kebab(name ?? "agent"));
}

const PREFIX_RULE = "2-8 lowercase letters or digits, starting with a letter";

/**
 * Why a prefix cannot be guessed, in the words a user needs to choose one.
 * `solution` is the solution the agent is going into, when one is named: its
 * publisher decides the answer, so say so rather than offering a menu.
 */
export function prefixExplanation(solution?: SolutionChoice | null): string {
  const base = `The publisher prefix is stamped onto every component this agent will have (the topics become <prefix>_<agent>.topic.<Name>), and it cannot be changed afterwards without recreating them. It is ${PREFIX_RULE}.`;
  if (solution?.publisherPrefix) return `${base} Solution '${solution.uniqueName}' belongs to a publisher whose prefix is '${solution.publisherPrefix}', and an agent added to it must use that prefix.`;
  if (solution) return `${base} It must match the publisher of solution '${solution.uniqueName}', or the import is rejected.`;
  return `${base} It must match the publisher of the solution the agent ends up in, so pick the one the team already uses for this environment.`;
}

function publisherChoices(publishers: PublisherChoice[] | null | undefined): NeedChoice[] | undefined {
  if (!publishers?.length) return undefined;
  return publishers.map((p) => ({ value: p.prefix, label: `${p.prefix} - ${p.name}`, ...(p.isDefault ? { detail: "the environment's default publisher" } : {}) }));
}

/** The decisions still open, in the order a user makes them. */
export function createAgentNeeds(a: CreateAgentAsk, facts: CreateAgentFacts): NeedSpec[] {
  const needs: NeedSpec[] = [];
  const solution = a.solutionName ? (facts.solutions?.find((s) => s.uniqueName.toLowerCase() === (a.solutionName as string).toLowerCase()) ?? { uniqueName: a.solutionName, friendlyName: a.solutionName }) : null;

  if (!a.projectDir) {
    const suggestion = suggestedProjectDir(facts.cwd, a.name);
    needs.push({
      argument: "projectDir",
      question: `Where should the agent's files live? Suggested: ${suggestion}`,
      why: "The workspace is a folder of YAML on this machine - the agent's topics, knowledge, tools and settings - and everything is edited there before anything reaches Copilot Studio. pac refuses a folder that already has files in it, so it must be a new or empty one.",
      choices: [{ value: suggestion, label: suggestion, detail: "suggested: named after the agent, next to the current folder" }],
    });
  }

  if (!a.publisherPrefix) {
    const fromSolution = solution?.publisherPrefix ?? null;
    needs.push({
      argument: "publisherPrefix",
      question: fromSolution ? `Use the publisher prefix '${fromSolution}' from solution '${solution?.uniqueName}'?` : "Which publisher prefix should this agent use?",
      why: prefixExplanation(solution),
      choices: fromSolution ? [{ value: fromSolution, label: fromSolution, detail: `the publisher of solution '${solution?.uniqueName}'` }] : publisherChoices(facts.publishers),
      // No moreWith: nothing in the tool list enumerates publishers, and
      // pointing at cs_list_solutions would send the user somewhere that
      // cannot answer this.
      ...(facts.publishers?.length && !fromSolution ? { totalChoices: facts.publishers.length } : {}),
    });
  }

  return needs;
}

/**
 * The solution sentence for the dry run. Not a blocking question: leaving
 * `solutionName` out is a real answer - pac makes a solution named after the
 * agent - and the dry run is already shown to the user before anything is
 * created, so the alternatives belong there rather than in a round trip of
 * their own.
 */
export function solutionGuidance(a: CreateAgentAsk, facts: CreateAgentFacts): string {
  if (a.solutionName) {
    const known = facts.solutions?.find((s) => s.uniqueName.toLowerCase() === (a.solutionName as string).toLowerCase());
    if (known) return `The agent goes into the existing unmanaged solution '${known.uniqueName}' (${known.friendlyName}).`;
    if (facts.solutions) return `Solution '${a.solutionName}' does not exist in this environment yet; pass createSolution: true to create it, or choose one of: ${facts.solutions.map((s) => s.uniqueName).join(", ") || "(none unmanaged)"}.`;
    return `The agent goes into solution '${a.solutionName}'; it must exist and be unmanaged, or pass createSolution: true.`;
  }
  const options = facts.solutions?.length ? ` Existing unmanaged solutions here: ${facts.solutions.map((s) => s.uniqueName).join(", ")}.` : "";
  return `No solution was named, so pac creates one named after the agent. A solution is the unit you export and import to move this agent to another environment, so putting it in the team's solution now saves moving it later: pass solutionName to use an existing one, or solutionName plus createSolution: true to make a new one.${options}`;
}
