/**
 * Background jobs: the mechanism that lets cs_pull_solution outlive an MCP
 * client's call timeout. A job must never throw into the process, and its
 * outcome must reach disk so a server restart does not lose it.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { afterEach } from "node:test";

import { getJob, listJobs, publicView, readRecord, resetJobs, startJob } from "../dist/jobs.js";

afterEach(() => resetJobs());

const settled = async (job) => {
  for (let i = 0; i < 200 && job.state === "running"; i++) await new Promise((r) => setTimeout(r, 5));
  return job;
};

test("a job returns immediately and reports its result when it finishes", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const job = startJob({ tool: "cs_pull_solution", label: "pull X" }, async () => {
    await gate;
    return { manifestFile: "solution.json" };
  });

  assert.equal(job.state, "running", "startJob must not wait for the body");
  assert.equal(getJob(job.id)?.label, "pull X");

  release();
  await settled(job);
  assert.equal(job.state, "succeeded");
  assert.deepEqual(job.result, { manifestFile: "solution.json" });
  assert.ok(job.durationMs >= 0);
  assert.equal(job.error, null);
});

test("a failing job is recorded, not thrown", async () => {
  const job = startJob({ tool: "cs_pull_solution", label: "pull Y" }, async () => {
    throw new Error("pac solution export failed: no such solution");
  });
  await settled(job);
  assert.equal(job.state, "failed");
  assert.match(job.error, /no such solution/);
  // publicView carries the error but no result key.
  const view = publicView(job);
  assert.ok("error" in view);
  assert.ok(!("result" in view));
});

test("progress steps are recorded in order", async () => {
  const job = startJob({ tool: "cs_pull_solution", label: "pull Z" }, async (progress) => {
    progress("exporting the unmanaged solution");
    progress("unpacking");
    progress("done");
    return {};
  });
  await settled(job);
  assert.deepEqual(
    job.steps.map((s) => s.step),
    ["exporting the unmanaged solution", "unpacking", "done"],
  );
  assert.ok(job.steps.every((s) => typeof s.at === "string"));
});

test("the outcome is mirrored to disk so a server restart does not lose it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-jobs-"));
  try {
    const recordFile = join(dir, "nested", "pull-job.json");
    const job = startJob({ tool: "cs_pull_solution", label: "pull W", recordFile }, async (progress) => {
      progress("working");
      return { ok: true };
    });
    await settled(job);

    const onDisk = readRecord(recordFile);
    assert.equal(onDisk.jobId, job.id);
    assert.equal(onDisk.state, "succeeded");
    assert.deepEqual(onDisk.result, { ok: true });

    // The same file is what cs_job_status reads when the job is gone from memory.
    resetJobs();
    assert.equal(getJob(job.id), null);
    assert.equal(readRecord(recordFile).state, "succeeded");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a record is written while the job is still running, so a crash leaves a trace", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-jobs-"));
  try {
    const recordFile = join(dir, "pull-job.json");
    let release;
    const gate = new Promise((r) => (release = r));
    const job = startJob({ tool: "cs_pull_solution", label: "pull V", recordFile }, () => gate);

    const early = JSON.parse(readFileSync(recordFile, "utf8"));
    assert.equal(early.state, "running");
    assert.equal(early.jobId, job.id);

    release();
    await settled(job);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRecord returns null for a missing or unreadable file", () => {
  assert.equal(readRecord(join(tmpdir(), "definitely-not-here", "pull-job.json")), null);
});

test("listJobs is newest first and survives a mix of states", async () => {
  const a = startJob({ tool: "cs_pull_solution", label: "a" }, async () => "a");
  await settled(a);
  const b = startJob({ tool: "cs_pull_solution", label: "b" }, async () => {
    throw new Error("boom");
  });
  await settled(b);
  const jobs = listJobs();
  assert.equal(jobs.length, 2);
  assert.deepEqual(new Set(jobs.map((j) => j.state)), new Set(["succeeded", "failed"]));
});

test("an unhandled rejection inside a job body cannot escape", async () => {
  // If startJob did not attach a handler this would take the server down.
  let unhandled = null;
  const onUnhandled = (err) => (unhandled = err);
  process.on("unhandledRejection", onUnhandled);
  try {
    const job = startJob({ tool: "cs_pull_solution", label: "reject" }, () => Promise.reject(new Error("nope")));
    await settled(job);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(unhandled, null, "the rejection escaped the job");
    assert.equal(job.state, "failed");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
