import type { NixDesignerScope, ThreadWorkflow } from "@t3tools/contracts";
import { designerScopesEqual, normalizeHostName } from "@t3tools/shared/threadScope";

function workflowsEqual(
  left: ThreadWorkflow | null | undefined,
  right: ThreadWorkflow | null | undefined,
): boolean {
  if (left === right) {
    return true;
  }
  if (left == null || right == null) {
    return false;
  }
  if (left.kind !== right.kind) {
    return false;
  }
  switch (left.kind) {
    case "host-creation":
      return (
        right.kind === "host-creation" &&
        left.hostName === right.hostName &&
        (left.target ?? null) === (right.target ?? null) &&
        (left.osFamily ?? null) === (right.osFamily ?? null) &&
        (left.bootstrapMode ?? null) === (right.bootstrapMode ?? null) &&
        (left.sourceSshTarget ?? null) === (right.sourceSshTarget ?? null) &&
        (left.hostType ?? null) === (right.hostType ?? null) &&
        (left.status ?? null) === (right.status ?? null)
      );
    case "host-removal":
      return (
        right.kind === "host-removal" &&
        left.hostName === right.hostName &&
        (left.target ?? null) === (right.target ?? null) &&
        (left.hostType ?? null) === (right.hostType ?? null) &&
        (left.status ?? null) === (right.status ?? null)
      );
    case "flake-creation":
      return (
        right.kind === "flake-creation" &&
        left.hostScale === right.hostScale &&
        left.platformMatrix === right.platformMatrix &&
        left.homeManager === right.homeManager &&
        left.moduleStyle === right.moduleStyle &&
        (left.moduleNamespace ?? null) === (right.moduleNamespace ?? null) &&
        left.layoutPattern === right.layoutPattern &&
        (left.status ?? null) === (right.status ?? null)
      );
  }
}

export function shouldReuseDraftForThreadStart(input: {
  requestedDesigner?: NixDesignerScope | null;
  existingDesigner?: NixDesignerScope | null;
  requestedScopedHostName?: string | null;
  existingScopedHostName?: string | null;
  requestedWorkflow?: ThreadWorkflow | null;
  existingWorkflow?: ThreadWorkflow | null;
  existingPrompt?: string | null;
}): boolean {
  const requestedScopedHostName = normalizeHostName(input.requestedScopedHostName);
  const existingScopedHostName = normalizeHostName(input.existingScopedHostName);
  if (!designerScopesEqual(input.requestedDesigner ?? null, input.existingDesigner ?? null)) {
    return false;
  }
  if (!workflowsEqual(input.requestedWorkflow ?? null, input.existingWorkflow ?? null)) {
    return false;
  }

  if (existingScopedHostName === requestedScopedHostName) {
    return true;
  }

  return (input.existingPrompt ?? "").trim().length === 0;
}
