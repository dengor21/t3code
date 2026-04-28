import { EnvironmentId, EventId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { activityToPendingFlakeUiAction, findLatestPendingFlakeUiAction } from "./flakeUiActions";

describe("flakeUiActions", () => {
  it("converts ui.action.requested activities into pending flake ui actions", () => {
    const action = activityToPendingFlakeUiAction({
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      activity: {
        id: EventId.make("activity-1"),
        tone: "tool",
        kind: "ui.action.requested",
        summary: "Opened HAL deploy flow for nexus",
        payload: {
          kind: "open-host-deploy-dialog",
          actionId: "action-1",
          hostName: "nexus",
        },
        turnId: TurnId.make("turn-1"),
        createdAt: "2026-04-27T12:00:00.000Z",
      },
    });

    expect(action).toEqual({
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      actionId: "action-1",
      kind: "open-host-deploy-dialog",
      hostName: "nexus",
    });
  });

  it("finds the latest unhandled flake ui action and skips handled or invalid entries", () => {
    const action = findLatestPendingFlakeUiAction({
      environmentId: EnvironmentId.make("env-1"),
      projectId: ProjectId.make("project-1"),
      threadId: ThreadId.make("thread-1"),
      handledActionIds: ["action-1"],
      activities: [
        {
          id: EventId.make("activity-1"),
          tone: "tool",
          kind: "ui.action.requested",
          summary: "Opened HAL deploy flow for nexus",
          payload: {
            kind: "open-host-deploy-dialog",
            actionId: "action-1",
            hostName: "nexus",
          },
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-04-27T12:00:00.000Z",
        },
        {
          id: EventId.make("activity-2"),
          tone: "tool",
          kind: "ui.action.requested",
          summary: "Opened HAL fleet rollout flow",
          payload: {
            kind: "open-fleet-rollout",
            actionId: "action-2",
          },
          turnId: TurnId.make("turn-1"),
          createdAt: "2026-04-27T12:01:00.000Z",
        },
      ],
    });

    expect(action).toMatchObject({
      actionId: "action-2",
      kind: "open-fleet-rollout",
    });
  });
});
