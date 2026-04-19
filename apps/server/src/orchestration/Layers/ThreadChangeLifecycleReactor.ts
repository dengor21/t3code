import { realpathSync } from "node:fs";

import type {
  GitStatusStreamEvent,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@t3tools/contracts";
import { CommandId, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { Cause, Effect, Layer, Stream } from "effect";

import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  ThreadChangeLifecycleReactor,
  type ThreadChangeLifecycleReactorShape,
} from "../Services/ThreadChangeLifecycleReactor.ts";

type ReactorInput =
  | {
      source: "domain";
      event: Extract<
        OrchestrationEvent,
        {
          type: "thread.created" | "thread.turn-start-requested";
        }
      >;
    }
  | {
      source: "git";
      cwd: string;
      event: GitStatusStreamEvent;
    };

function normalizeCwd(cwd: string): string {
  try {
    return realpathSync.native(cwd);
  } catch {
    return cwd;
  }
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const serverCommandId = (tag: string) => CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

  const dispatchBaselineRecord = (threadId: ThreadId, baselineHeadSha: string | null) =>
    orchestrationEngine.dispatch({
      type: "thread.change-baseline.record",
      commandId: serverCommandId("thread-change-baseline-record"),
      threadId,
      baselineHeadSha,
      createdAt: new Date().toISOString(),
    });

  const resolveThreadGitContext = (input: {
    readonly threadId: ThreadId;
    readonly readModel: OrchestrationReadModel;
  }) => {
    const thread = input.readModel.threads.find((entry) => entry.id === input.threadId);
    if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
      return null;
    }
    const project = input.readModel.projects.find((entry) => entry.id === thread.projectId);
    if (!project || project.deletedAt !== null) {
      return null;
    }

    return {
      thread,
      cwd: normalizeCwd(thread.worktreePath ?? project.workspaceRoot),
      branch: thread.branch,
    };
  };

  const processDomainEvent = (
    event: Extract<
      OrchestrationEvent,
      {
        type: "thread.created" | "thread.turn-start-requested";
      }
    >,
  ) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const context = resolveThreadGitContext({
        threadId: event.payload.threadId,
        readModel,
      });
      if (!context) {
        return;
      }

      if (
        event.type === "thread.turn-start-requested" &&
        context.thread.changeTracking?.state !== "committed"
      ) {
        return;
      }

      const localStatus = yield* gitStatusBroadcaster.refreshLocalStatus(context.cwd);

      yield* dispatchBaselineRecord(context.thread.id, localStatus.head?.sha ?? null).pipe(
        Effect.catch(() => Effect.void),
      );
    });

  const processGitChange = (cwd: string, event: GitStatusStreamEvent) =>
    Effect.gen(function* () {
      if (event._tag !== "localUpdated") {
        return;
      }

      const localStatus = event.local;
      const headSha = localStatus.head?.sha ?? null;
      if (headSha === null || localStatus.branch === null) {
        return;
      }

      const readModel = yield* orchestrationEngine.getReadModel();
      const normalizedCwd = normalizeCwd(cwd);

      for (const thread of readModel.threads) {
        if (thread.deletedAt !== null || thread.archivedAt !== null) {
          continue;
        }
        const project = readModel.projects.find((entry) => entry.id === thread.projectId);
        if (!project || project.deletedAt !== null) {
          continue;
        }

        const threadCwd = normalizeCwd(thread.worktreePath ?? project.workspaceRoot);
        if (threadCwd !== normalizedCwd) {
          continue;
        }
        if (thread.branch === null || thread.branch !== localStatus.branch) {
          continue;
        }

        const changeTracking = thread.changeTracking ?? null;
        if (changeTracking === null || changeTracking.baselineHeadSha === null) {
          yield* dispatchBaselineRecord(thread.id, headSha).pipe(Effect.catch(() => Effect.void));
          continue;
        }

        if (changeTracking.baselineHeadSha === headSha || localStatus.hasWorkingTreeChanges) {
          continue;
        }

        yield* orchestrationEngine
          .dispatch({
            type: "thread.commit.record",
            commandId: serverCommandId("thread-commit-record"),
            threadId: thread.id,
            commitSha: headSha,
            subject: localStatus.head?.subject ?? null,
            source: "external",
            createdAt: new Date().toISOString(),
          })
          .pipe(Effect.catch(() => Effect.void));
      }
    });

  const processInputSafely = (input: ReactorInput) =>
    (input.source === "domain"
      ? processDomainEvent(input.event)
      : processGitChange(input.cwd, input.event)
    ).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("thread change lifecycle reactor failed", {
          source: input.source,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: ThreadChangeLifecycleReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.created" && event.type !== "thread.turn-start-requested") {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(gitStatusBroadcaster.streamAllChanges(), ({ cwd, event }) =>
        worker.enqueue({ source: "git", cwd, event }),
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies ThreadChangeLifecycleReactorShape;
});

export const ThreadChangeLifecycleReactorLive = Layer.effect(ThreadChangeLifecycleReactor, make);
