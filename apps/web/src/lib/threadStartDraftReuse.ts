import type { ThreadWorkflow } from "@t3tools/contracts";

function normalizeScopedHostName(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

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
  }
}

export function shouldReuseDraftForThreadStart(input: {
  requestedScopedHostName?: string | null;
  existingScopedHostName?: string | null;
  requestedWorkflow?: ThreadWorkflow | null;
  existingWorkflow?: ThreadWorkflow | null;
  existingPrompt?: string | null;
}): boolean {
  const requestedScopedHostName = normalizeScopedHostName(input.requestedScopedHostName);
  const existingScopedHostName = normalizeScopedHostName(input.existingScopedHostName);
  if (!workflowsEqual(input.requestedWorkflow ?? null, input.existingWorkflow ?? null)) {
    return false;
  }

  if (existingScopedHostName === requestedScopedHostName) {
    return true;
  }

  return (input.existingPrompt ?? "").trim().length === 0;
}
