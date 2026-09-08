/**
 * Power Platform pipelines.
 *
 * One entry per command; the flags come from `pac pipeline <command> help` on pac 2.11.2.
 */
import { ASYNC, ENV, SOLUTION_EXPORT, type PacCommandSpec } from "../pacParams.js";

export const SPECS: PacCommandSpec[] = [
  {
    tool: "cs_list_pipelines",
    title: "List Power Platform pipelines",
    description: "List the pipelines that can deploy from an environment, or the stages of one pipeline. Read-only.",
    command: ["pipeline", "list"],
    params: { environment: ENV, pipeline: { flag: "--pipeline", type: "string", description: "Pipeline name or id to show its stages" } },
    mutating: false,
  },
  {
    tool: "cs_deploy_pipeline",
    title: "Deploy through a Power Platform pipeline",
    description: "Start a pipeline deployment of a solution to a stage (the alternative to cs_deploy_solution when the tenant uses Power Platform pipelines). stageId comes from cs_list_pipelines.",
    command: ["pipeline", "deploy"],
    params: {
      environment: ENV,
      solutionName: { flag: "--solutionName", type: "string", required: true, description: "Solution unique name" },
      stageId: { flag: "--stageId", type: "string", required: true, description: "Deployment stage id (cs_list_pipelines with pipeline)" },
      currentVersion: { flag: "--currentVersion", type: "string", required: true, description: "Current solution version" },
      newVersion: { flag: "--newVersion", type: "string", required: true, description: "Version to deploy as" },
      wait: { flag: "--wait", type: "boolean", description: "Wait until the deployment finishes" },
    },
    mutating: true,
    timeoutMs: 60 * 60_000,
  }
];
