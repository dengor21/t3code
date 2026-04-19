import {
  CommandId,
  EventId,
  ProjectId,
  ThreadId,
  type OrchestrationEvent,
} from "@t3tools/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

function makeEvent(input: {
  sequence: number;
  type: OrchestrationEvent["type"];
  occurredAt: string;
  aggregateKind: OrchestrationEvent["aggregateKind"];
  aggregateId: string;
  commandId: string | null;
  payload: unknown;
}): OrchestrationEvent {
  return {
    sequence: input.sequence,
    eventId: EventId.make(`event-${input.sequence}`),
    type: input.type,
    aggregateKind: input.aggregateKind,
    aggregateId:
      input.aggregateKind === "project"
        ? ProjectId.make(input.aggregateId)
        : ThreadId.make(input.aggregateId),
    occurredAt: input.occurredAt,
    commandId: input.commandId === null ? null : CommandId.make(input.commandId),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

describe("thread change lifecycle", () => {
  it("records commit activity and keeps duplicate commit records idempotent", async () => {
    const now = "2026-04-19T10:00:00.000Z";
    const initial = createEmptyReadModel(now);

    const withThread = await Effect.runPromise(
      projectEvent(
        initial,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: now,
          commandId: "cmd-thread-create",
          payload: {
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        }),
      ),
    );

    const result = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.commit.record",
          commandId: CommandId.make("cmd-thread-commit-record"),
          threadId: ThreadId.make("thread-1"),
          commitSha: "abc1234",
          subject: "Commit subject",
          source: "ui",
          createdAt: "2026-04-19T10:05:00.000Z",
        },
        readModel: withThread,
      }),
    );

    const events = Array.isArray(result) ? result : [result];
    expect(events.map((event) => event.type)).toEqual([
      "thread.commit-recorded",
      "thread.activity-appended",
    ]);

    const committed = await Effect.runPromise(
      projectEvent(
        withThread,
        makeEvent({
          sequence: 2,
          type: "thread.commit-recorded",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: "2026-04-19T10:05:00.000Z",
          commandId: "cmd-thread-commit-record",
          payload: {
            threadId: ThreadId.make("thread-1"),
            commitSha: "abc1234",
            subject: "Commit subject",
            source: "ui",
            recordedAt: "2026-04-19T10:05:00.000Z",
          },
        }),
      ),
    );

    const duplicate = await Effect.runPromise(
      decideOrchestrationCommand({
        command: {
          type: "thread.commit.record",
          commandId: CommandId.make("cmd-thread-commit-record-duplicate"),
          threadId: ThreadId.make("thread-1"),
          commitSha: "abc1234",
          subject: "Commit subject",
          source: "ui",
          createdAt: "2026-04-19T10:06:00.000Z",
        },
        readModel: committed,
      }),
    );

    expect(duplicate).toEqual([]);
  });

  it("reopens a committed thread on the next user message", async () => {
    const createdAt = "2026-04-19T11:00:00.000Z";
    const commitAt = "2026-04-19T11:05:00.000Z";
    const messageAt = "2026-04-19T11:06:00.000Z";
    const initial = createEmptyReadModel(createdAt);

    const withThread = await Effect.runPromise(
      projectEvent(
        initial,
        makeEvent({
          sequence: 1,
          type: "thread.created",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: createdAt,
          commandId: "cmd-thread-create",
          payload: {
            threadId: ThreadId.make("thread-1"),
            projectId: ProjectId.make("project-1"),
            title: "Thread",
            modelSelection: {
              provider: "codex",
              model: "gpt-5-codex",
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "main",
            worktreePath: null,
            createdAt,
            updatedAt: createdAt,
          },
        }),
      ),
    );

    const committed = await Effect.runPromise(
      projectEvent(
        withThread,
        makeEvent({
          sequence: 2,
          type: "thread.commit-recorded",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: commitAt,
          commandId: "cmd-thread-commit-record",
          payload: {
            threadId: ThreadId.make("thread-1"),
            commitSha: "abc1234",
            subject: "Commit subject",
            source: "ui",
            recordedAt: commitAt,
          },
        }),
      ),
    );

    expect(committed.threads[0]?.changeTracking?.state).toBe("committed");

    const reopened = await Effect.runPromise(
      projectEvent(
        committed,
        makeEvent({
          sequence: 3,
          type: "thread.message-sent",
          aggregateKind: "thread",
          aggregateId: "thread-1",
          occurredAt: messageAt,
          commandId: "cmd-thread-message-sent",
          payload: {
            threadId: ThreadId.make("thread-1"),
            messageId: "message-1",
            role: "user",
            text: "Next change please",
            attachments: [],
            turnId: null,
            streaming: false,
            createdAt: messageAt,
            updatedAt: messageAt,
          },
        }),
      ),
    );

    expect(reopened.threads[0]?.changeTracking?.state).toBe("ongoing");
  });
});
