/**
 * Event triggers (`trigger/<name>.trigger.mcs.yml`): a cloud flow that starts
 * the agent when something happens outside a conversation.
 */
import path from "node:path";
import { pascal, writeComponentFile } from "./util.js";

export interface TriggerSpec {
  name: string;
  description?: string;
  /** Id of the cloud flow whose "When an agent is triggered" step fires this. */
  flowId: string;
  overwrite?: boolean;
}

export function addTrigger(root: string, spec: TriggerSpec): { file: string; note: string } {
  const doc = {
    "mcs.metadata": { componentName: spec.name, ...(spec.description ? { description: spec.description } : {}) },
    kind: "ExternalTriggerConfiguration",
    externalTriggerSource: { kind: "WorkflowExternalTrigger", flowId: spec.flowId },
  };
  const file = writeComponentFile(path.join(root, "trigger", `${pascal(spec.name)}.mcs.yml`), [`Name: ${spec.name}`, spec.description ?? `Trigger: ${spec.name}`], doc, {
    overwrite: spec.overwrite,
  });
  return { file, note: `Wrote ${path.relative(root, file)}. The referenced flow must exist in the same environment (see cs_add_flow) before pushing.` };
}
