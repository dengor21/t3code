import { Schema } from "effect";
import { UiActionRequestedPayload, type OrchestrationThreadActivity } from "@t3tools/contracts";

import type { PendingFlakeUiAction } from "../uiStateStore";

const decodeUiActionRequestedPayload = Schema.decodeUnknownSync(UiActionRequestedPayload);

export function activityToPendingFlakeUiAction(input: {
  readonly activity: OrchestrationThreadActivity;
  readonly environmentId: PendingFlakeUiAction["environmentId"];
  readonly projectId: PendingFlakeUiAction["projectId"];
  readonly threadId: PendingFlakeUiAction["threadId"];
}): PendingFlakeUiAction | null {
  if (input.activity.kind !== "ui.action.requested") {
    return null;
  }

  let decoded: typeof UiActionRequestedPayload.Type;
  try {
    decoded = decodeUiActionRequestedPayload(input.activity.payload);
  } catch {
    return null;
  }

  if (decoded.kind === "open-host-deploy-dialog") {
    return {
      environmentId: input.environmentId,
      projectId: input.projectId,
      threadId: input.threadId,
      actionId: decoded.actionId,
      kind: decoded.kind,
      hostName: decoded.hostName,
    };
  }

  return {
    environmentId: input.environmentId,
    projectId: input.projectId,
    threadId: input.threadId,
    actionId: decoded.actionId,
    kind: decoded.kind,
  };
}

export function findLatestPendingFlakeUiAction(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly environmentId: PendingFlakeUiAction["environmentId"];
  readonly projectId: PendingFlakeUiAction["projectId"];
  readonly threadId: PendingFlakeUiAction["threadId"];
  readonly handledActionIds: ReadonlyArray<string>;
}): PendingFlakeUiAction | null {
  const handledActionIds = new Set(input.handledActionIds);
  for (let index = input.activities.length - 1; index >= 0; index -= 1) {
    const activity = input.activities[index];
    if (!activity) {
      continue;
    }
    const action = activityToPendingFlakeUiAction({
      activity,
      environmentId: input.environmentId,
      projectId: input.projectId,
      threadId: input.threadId,
    });
    if (!action || handledActionIds.has(action.actionId)) {
      continue;
    }
    return action;
  }
  return null;
}
