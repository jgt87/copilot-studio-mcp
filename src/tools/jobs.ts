/**
 * Tools: background jobs.
 *
 * The long-running tools (a solution export plus a clone per agent) outlive
 * what an MCP client will wait for. Those tools can return a jobId instead;
 * these two read it back. Both are read-only.
 *
 * index.ts imports this module for its side effect, in tool-list order.
 */
import { z } from "zod";

import { errorMessage } from "../log.js";
import { getJob, listJobs, publicView, readRecord } from "../jobs.js";
import { fail, server, text } from "./shared.js";

// ---- background jobs -------------------------------------------------------

server.registerTool(
  "cs_job_status",
  {
    title: "Check a background job",
    description:
      "The state of a job started with background: true - running, succeeded or failed - with the phases it has reached and, once finished, the result the tool would have returned. Read-only. Jobs live in the server process, so a restart loses them; pass recordFile to read the copy the job wrote to disk instead.",
    inputSchema: {
      jobId: z.string().optional().describe("Omit to list every job this server knows about"),
      recordFile: z.string().optional().describe("Read a job record from disk (e.g. <targetDir>/pull-job.json) when the server has been restarted since"),
    },
  },
  async (a) => {
    try {
      if (a.recordFile) {
        const record = readRecord(a.recordFile);
        if (!record) return fail(`No job record at ${a.recordFile}. The job may not have started, or the path is wrong.`);
        return text({ source: "disk", ...record });
      }
      if (!a.jobId) {
        const jobs = listJobs();
        return text({
          count: jobs.length,
          running: jobs.filter((j) => j.state === "running").length,
          jobs: jobs.map((j) => ({ jobId: j.id, tool: j.tool, label: j.label, state: j.state, startedAt: j.startedAt, durationMs: j.durationMs, lastStep: j.steps[j.steps.length - 1]?.step ?? null })),
          ...(jobs.length === 0 ? { hint: "No jobs in this server process. If it was restarted, pass recordFile (e.g. <targetDir>/pull-job.json)." } : {}),
        });
      }
      const job = getJob(a.jobId);
      if (!job) return fail(`No job ${a.jobId} in this server process. If the server restarted, pass recordFile (e.g. <targetDir>/pull-job.json).`);
      return text({
        source: "memory",
        ...publicView(job),
        ...(job.state === "running" ? { hint: "Still running. Poll again; a solution export with several agents can take many minutes." } : {}),
      });
    } catch (err) {
      return fail(errorMessage(err));
    }
  },
);
