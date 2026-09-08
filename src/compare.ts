/**
 * Environment snapshots and comparison for DTAP pipelines.
 *
 * A snapshot is a folder: `snapshot.json` plus `agents/<Agent>/` workspaces
 * produced by `pac copilot clone`. Snapshots are plain files, so they can be
 * committed for history and compared offline. Comparison normalises the YAML
 * (drops audit/id noise, connection ids) before diffing, treats values that
 * differ by design between environments as "expected", and reports the rest
 * as drift.
 *
 * The work lives in three modules; this one keeps them reachable under the
 * original import path:
 *  - `snapshot.ts` captures an environment and reads or writes snapshot folders
 *  - `workspaceDiff.ts` normalises and compares workspace files, and fingerprints them
 *  - `compareReport.ts` compares two snapshots layer by layer and renders the report
 */
export { SNAPSHOT_FILE, captureSnapshot, readSnapshot, writeSnapshot, type CaptureOptions, type DataverseReads, type Snapshot, type SnapshotAgent } from "./snapshot.js";
export { DEFAULT_IGNORED_KEYS, compareWorkspaces, workspaceFingerprints, type FileComparison } from "./workspaceDiff.js";
export { compareChain, compareSnapshots, renderReportMarkdown, writeReport, type AgentComparison, type CompareReport, type PublishState } from "./compareReport.js";
