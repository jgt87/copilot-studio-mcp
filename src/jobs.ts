/**
 * Background jobs for the tools that outlive an MCP call.
 *
 * MCP clients cap how long a tool call may take. `cs_login` already works
 * around that by returning as soon as it has the sign-in URL; the solution
 * tools could not, because a solution export plus an agent clone per agent runs
 * for minutes and the client gives up while the server is still working.
 *
 * A job runs in the background and reports through `cs_job_status`. The
 * confirm contract is unaffected: a tool decides whether it may change anything
 * *before* it starts a job, so nothing here can bypass a dry run.
 *
 * Jobs live in the server process. If the client restarts the server, running
 * jobs are lost along with it: the underlying pac process is left to finish, but
 * nothing is left to report it, which is why every job writes its outcome to
 * disk when the caller gives it somewhere to write.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { log } from "./log.js";

export type JobState = "running" | "succeeded" | "failed";

export interface JobStep {
  step: string;
  at: string;
}

export interface Job {
  id: string;
  tool: string;
  label: string;
  state: JobState;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  steps: JobStep[];
  result: unknown;
  error: string | null;
  /** Where the outcome is mirrored, so it survives a server restart. */
  recordFile: string | null;
}

/** What a job body is given to report progress. */
export type Progress = (step: string) => void;

const JOBS = new Map<string, Job>();

/** Completed jobs older than this are dropped when a new one starts. */
const KEEP_COMPLETED_MS = 24 * 60 * 60 * 1000;
const KEEP_COMPLETED_MAX = 50;

function prune(): void {
  const done = [...JOBS.values()].filter((j) => j.state !== "running").sort((a, b) => (a.finishedAt ?? "").localeCompare(b.finishedAt ?? ""));
  const cutoff = Date.now() - KEEP_COMPLETED_MS;
  const stale = done.filter((j) => new Date(j.finishedAt ?? 0).getTime() < cutoff);
  const excess = done.slice(0, Math.max(0, done.length - KEEP_COMPLETED_MAX));
  for (const j of new Set([...stale, ...excess])) JOBS.delete(j.id);
}

function writeRecord(job: Job): void {
  if (!job.recordFile) return;
  try {
    fs.mkdirSync(path.dirname(job.recordFile), { recursive: true });
    fs.writeFileSync(job.recordFile, JSON.stringify(publicView(job), null, 2) + "\n", "utf8");
  } catch (err) {
    log(`job ${job.id}: could not write ${job.recordFile}: ${String(err)}`);
  }
}

export interface StartOptions {
  tool: string;
  /** One line describing what this run is doing, for cs_job_status. */
  label: string;
  /** File to mirror the outcome into, so it survives a server restart. */
  recordFile?: string | null;
}

/**
 * Run `body` in the background and return the job immediately. The body's
 * rejection is captured on the job, never thrown into the process: an
 * unhandled rejection here would take the server down.
 */
export function startJob(o: StartOptions, body: (progress: Progress) => Promise<unknown>): Job {
  prune();
  const started = Date.now();
  const job: Job = {
    id: randomUUID(),
    tool: o.tool,
    label: o.label,
    state: "running",
    startedAt: new Date(started).toISOString(),
    finishedAt: null,
    durationMs: null,
    steps: [],
    result: null,
    error: null,
    recordFile: o.recordFile ?? null,
  };
  JOBS.set(job.id, job);

  const progress: Progress = (step) => {
    job.steps.push({ step, at: new Date().toISOString() });
    log(`job ${job.id} (${o.tool}): ${step}`);
  };

  const finish = (state: JobState, patch: Partial<Job>) => {
    job.state = state;
    job.finishedAt = new Date().toISOString();
    job.durationMs = Date.now() - started;
    Object.assign(job, patch);
    writeRecord(job);
    log(`job ${job.id} (${o.tool}) ${state} after ${job.durationMs} ms`);
  };

  Promise.resolve().then(() => body(progress)).then(
    (result) => {
      const outcome = result as { ok?: boolean; isError?: boolean; error?: string; explanation?: string } | null;
      if (outcome?.ok === false || outcome?.isError === true) {
        finish("failed", { result, error: outcome.error ?? outcome.explanation ?? "Operation reported failure; see result for diagnostics." });
      } else finish("succeeded", { result });
    },
    (err) => finish("failed", { error: err instanceof Error ? err.message : String(err) }),
  );

  writeRecord(job);
  return job;
}

/** The job without its internals, for a tool result. */
export function publicView(job: Job): Record<string, unknown> {
  return {
    jobId: job.id,
    tool: job.tool,
    label: job.label,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    steps: job.steps,
    ...(job.state === "succeeded" || job.result !== null ? { result: job.result } : {}),
    ...(job.state === "failed" ? { error: job.error } : {}),
    ...(job.recordFile ? { recordFile: job.recordFile } : {}),
  };
}

export function getJob(id: string): Job | null {
  return JOBS.get(id) ?? null;
}

export function listJobs(): Job[] {
  return [...JOBS.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

/** Read a job record a previous server process wrote. */
export function readRecord(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Test seam: forget every job. */
export function resetJobs(): void {
  JOBS.clear();
}
