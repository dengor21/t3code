import {
  DEFAULT_TERMINAL_ID,
  FlakeMaintenanceError,
  type FlakeMaintenanceGetInput,
  type ProjectId,
  type FlakeMaintenanceStartResult,
  type FlakeMaintenanceSummary,
  type FlakeMaintenanceTerminalEvent,
  type FlakeMaintenanceTerminalSnapshot,
} from "@t3tools/contracts";
import {
  Cache,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Semaphore,
  Stream,
} from "effect";

import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { FlakeMaintenanceRepository } from "../../persistence/Services/FlakeMaintenance.ts";
import {
  isActiveFlakeMaintenanceStatus,
  type PersistedFlakeMaintenance,
} from "../../persistence/Services/FlakeMaintenance.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import {
  FlakeMaintenanceService,
  type FlakeMaintenanceServiceShape,
} from "../Services/FlakeMaintenanceService.ts";

const FLAKE_MAINTENANCE_OWNER_PREFIX = "flake-maintenance:";
const FLAKE_UPDATE_COMMAND = "nix flake update";

function ownerIdFor(projectId: ProjectId): string {
  return `${FLAKE_MAINTENANCE_OWNER_PREFIX}${projectId}`;
}

function parseOwnerId(terminalOwnerId: string): ProjectId | null {
  if (!terminalOwnerId.startsWith(FLAKE_MAINTENANCE_OWNER_PREFIX)) {
    return null;
  }
  const projectId = terminalOwnerId.slice(FLAKE_MAINTENANCE_OWNER_PREFIX.length);
  return projectId.length > 0 ? (projectId as ProjectId) : null;
}

function toFlakeMaintenanceError(message: string, cause?: unknown): FlakeMaintenanceError {
  return new FlakeMaintenanceError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toTerminalStatus(
  status: FlakeMaintenanceSummary["status"],
): FlakeMaintenanceTerminalSnapshot["status"] {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "succeeded":
    case "failed":
    case "canceled":
    default:
      return "exited";
  }
}

function mapTerminalSnapshot(snapshot: {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: "starting" | "running" | "exited" | "error";
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
}): FlakeMaintenanceTerminalSnapshot {
  return {
    terminalOwnerId: snapshot.threadId,
    terminalId: snapshot.terminalId,
    cwd: snapshot.cwd,
    worktreePath: snapshot.worktreePath,
    status: snapshot.status,
    pid: snapshot.pid,
    history: snapshot.history,
    exitCode: snapshot.exitCode,
    exitSignal: snapshot.exitSignal,
    updatedAt: snapshot.updatedAt,
  };
}

function mapTerminalEvent(event: {
  type: FlakeMaintenanceTerminalEvent["type"];
  threadId: string;
  terminalId: string;
  createdAt: string;
  snapshot?: {
    threadId: string;
    terminalId: string;
    cwd: string;
    worktreePath: string | null;
    status: "starting" | "running" | "exited" | "error";
    pid: number | null;
    history: string;
    exitCode: number | null;
    exitSignal: number | null;
    updatedAt: string;
  };
  data?: string;
  exitCode?: number | null;
  exitSignal?: number | null;
  message?: string;
  hasRunningSubprocess?: boolean;
}): FlakeMaintenanceTerminalEvent {
  switch (event.type) {
    case "started":
    case "restarted":
      return {
        type: event.type,
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        snapshot: mapTerminalSnapshot(event.snapshot!),
      };
    case "output":
      return {
        type: "output",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        data: event.data!,
      };
    case "exited":
      return {
        type: "exited",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        exitCode: event.exitCode ?? null,
        exitSignal: event.exitSignal ?? null,
      };
    case "error":
      return {
        type: "error",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        message: event.message!,
      };
    case "cleared":
      return {
        type: "cleared",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
      };
    case "activity":
      return {
        type: "activity",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        hasRunningSubprocess: event.hasRunningSubprocess ?? false,
      };
  }
}

const makeFlakeMaintenanceService = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const gitStatusBroadcaster = yield* GitStatusBroadcaster;
  const terminalManager = yield* TerminalManager;
  const flakeMaintenanceRepository = yield* FlakeMaintenanceRepository;

  const ownerLockCache = yield* Cache.make({
    capacity: 128,
    timeToLive: Duration.minutes(10),
    lookup: () => Semaphore.make(1),
  });

  const withOwnerLock = <A, E, R>(
    terminalOwnerId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(Cache.get(ownerLockCache, terminalOwnerId), (semaphore) =>
      semaphore.withPermit(effect),
    );

  const getPersisted = Effect.fn("flakeMaintenance.getPersisted")(function* (
    input: FlakeMaintenanceGetInput,
  ) {
    return yield* flakeMaintenanceRepository
      .getByProjectId(input)
      .pipe(
        Effect.mapError((cause) =>
          toFlakeMaintenanceError("Failed to load flake maintenance state.", cause),
        ),
      );
  });

  const refreshGitStatus = (cwd: string) =>
    gitStatusBroadcaster.refreshStatus(cwd).pipe(Effect.ignoreCause({ log: true }));

  const resolveStartContext = Effect.fn("flakeMaintenance.resolveStartContext")(function* (
    input: FlakeMaintenanceGetInput,
  ) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
      Effect.mapError((cause) =>
        toFlakeMaintenanceError("Failed to load the selected flake.", cause),
      ),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.fail(toFlakeMaintenanceError(`Flake ${input.projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

    const flakeFile = path.join(project.workspaceRoot, "flake.nix");
    const flakeStats = yield* fileSystem
      .stat(flakeFile)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (flakeStats?.type !== "File") {
      return yield* Effect.fail(
        toFlakeMaintenanceError("flake.nix is missing for the selected flake."),
      );
    }

    const gitStatus = yield* gitStatusBroadcaster
      .refreshStatus(project.workspaceRoot)
      .pipe(
        Effect.mapError((cause) =>
          toFlakeMaintenanceError("Failed to refresh git status for the selected flake.", cause),
        ),
      );
    if (!gitStatus.isRepo) {
      return yield* Effect.fail(
        toFlakeMaintenanceError(
          "Flake maintenance requires a git repository so updates can be reviewed before commit.",
        ),
      );
    }
    if (gitStatus.hasWorkingTreeChanges) {
      return yield* Effect.fail(
        toFlakeMaintenanceError(
          "Commit, stash, or discard local changes before running flake maintenance.",
        ),
      );
    }

    return {
      project,
      command: FLAKE_UPDATE_COMMAND,
      terminalOwnerId: ownerIdFor(input.projectId),
    } as const;
  });

  const updateSummaryFromTerminalEvent = Effect.fn("flakeMaintenance.updateFromTerminalEvent")(
    function* (
      event:
        | {
            type: "started" | "restarted";
            threadId: string;
            createdAt: string;
            snapshot: { updatedAt: string };
          }
        | {
            type: "activity";
            threadId: string;
            createdAt: string;
            hasRunningSubprocess: boolean;
          }
        | {
            type: "exited";
            threadId: string;
            createdAt: string;
            exitCode: number | null;
            exitSignal: number | null;
          }
        | {
            type: "error";
            threadId: string;
            createdAt: string;
          },
    ) {
      const projectId = parseOwnerId(event.threadId);
      if (projectId === null) {
        return;
      }

      const current = yield* flakeMaintenanceRepository
        .getByProjectId({ projectId })
        .pipe(
          Effect.mapError((cause) =>
            toFlakeMaintenanceError("Failed to load flake maintenance state.", cause),
          ),
        );
      if (Option.isNone(current)) {
        return;
      }

      const existing = current.value;
      let next = existing;

      switch (event.type) {
        case "started":
        case "restarted":
          next = {
            ...existing,
            status: "running",
            finishedAt: null,
            updatedAt: event.snapshot.updatedAt,
            exitCode: null,
            exitSignal: null,
          };
          break;
        case "activity":
          if (!event.hasRunningSubprocess) {
            return;
          }
          next = {
            ...existing,
            status: "running",
            updatedAt: event.createdAt,
          };
          break;
        case "exited":
          next = {
            ...existing,
            status:
              existing.status === "canceled"
                ? "canceled"
                : event.exitCode === 0
                  ? "succeeded"
                  : "failed",
            finishedAt: event.createdAt,
            updatedAt: event.createdAt,
            exitCode: event.exitCode,
            exitSignal: event.exitSignal,
          };
          break;
        case "error":
          next = {
            ...existing,
            status: "error",
            finishedAt: event.createdAt,
            updatedAt: event.createdAt,
          };
          break;
      }

      yield* flakeMaintenanceRepository
        .upsert(next)
        .pipe(
          Effect.mapError((cause) =>
            toFlakeMaintenanceError("Failed to persist flake maintenance state.", cause),
          ),
        );

      if (event.type === "exited" || event.type === "error") {
        yield* refreshGitStatus(existing.cwd);
      }
    },
  );

  const repairActiveMaintenance = flakeMaintenanceRepository.listActive().pipe(
    Effect.mapError((cause) =>
      toFlakeMaintenanceError("Failed to repair flake maintenance state.", cause),
    ),
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows,
        (row) => {
          const now = new Date().toISOString();
          return flakeMaintenanceRepository
            .upsert({
              ...row,
              status: "error",
              finishedAt: row.finishedAt ?? now,
              updatedAt: now,
            })
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError("Failed to repair flake maintenance state.", cause),
              ),
            );
        },
        { discard: true },
      ),
    ),
  );
  yield* repairActiveMaintenance;

  const unsubscribe = yield* terminalManager.subscribe((event) => {
    if (parseOwnerId(event.threadId) === null) {
      return Effect.void;
    }
    if (event.type === "output" || event.type === "cleared") {
      return Effect.void;
    }
    return updateSummaryFromTerminalEvent(event as never).pipe(Effect.ignoreCause({ log: true }));
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const get: FlakeMaintenanceServiceShape["get"] = (input) =>
    getPersisted(input).pipe(
      Effect.map(Option.match({ onNone: () => null, onSome: (row) => row })),
    );

  const start: FlakeMaintenanceServiceShape["start"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      return yield* withOwnerLock(
        context.terminalOwnerId,
        Effect.gen(function* () {
          const existing = yield* flakeMaintenanceRepository
            .getByProjectId({
              projectId: input.projectId,
            })
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError("Failed to load flake maintenance state.", cause),
              ),
            );

          if (Option.isSome(existing) && isActiveFlakeMaintenanceStatus(existing.value.status)) {
            const liveSnapshot = yield* terminalManager
              .getSnapshot({
                threadId: context.terminalOwnerId,
                terminalId: DEFAULT_TERMINAL_ID,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toFlakeMaintenanceError("Failed to inspect active flake maintenance.", cause),
                ),
              );
            if (liveSnapshot !== null && liveSnapshot.status === "running") {
              return {
                disposition: "already-running",
                maintenance: existing.value,
              } as const;
            }

            const repairedAt = new Date().toISOString();
            yield* flakeMaintenanceRepository
              .upsert({
                ...existing.value,
                status: "error",
                finishedAt: existing.value.finishedAt ?? repairedAt,
                updatedAt: repairedAt,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toFlakeMaintenanceError("Failed to repair flake maintenance state.", cause),
                ),
              );
          }

          yield* terminalManager
            .close({
              threadId: context.terminalOwnerId,
              deleteHistory: true,
            })
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError(
                  "Failed to reset the previous flake maintenance session.",
                  cause,
                ),
              ),
            );

          const startedAt = new Date().toISOString();
          let summary: FlakeMaintenanceSummary = {
            projectId: input.projectId,
            terminalOwnerId: context.terminalOwnerId,
            cwd: context.project.workspaceRoot,
            command: context.command,
            status: "starting",
            startedAt,
            finishedAt: null,
            updatedAt: startedAt,
            exitCode: null,
            exitSignal: null,
          };

          yield* flakeMaintenanceRepository
            .upsert(summary)
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError("Failed to persist flake maintenance state.", cause),
              ),
            );

          const terminalSnapshot = yield* terminalManager
            .openCommand({
              threadId: context.terminalOwnerId,
              terminalId: DEFAULT_TERMINAL_ID,
              cwd: context.project.workspaceRoot,
              worktreePath: null,
              command: context.command,
            })
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError(
                  "Failed to start the flake maintenance terminal session.",
                  cause,
                ),
              ),
            );

          summary = {
            ...summary,
            status: terminalSnapshot.status === "error" ? "error" : "running",
            updatedAt: terminalSnapshot.updatedAt,
            finishedAt: terminalSnapshot.status === "error" ? terminalSnapshot.updatedAt : null,
            exitCode: terminalSnapshot.exitCode,
            exitSignal: terminalSnapshot.exitSignal,
          };

          yield* flakeMaintenanceRepository
            .upsert(summary)
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError("Failed to persist flake maintenance state.", cause),
              ),
            );

          return {
            disposition: "started",
            maintenance: summary,
          } satisfies FlakeMaintenanceStartResult;
        }),
      );
    });

  const stop: FlakeMaintenanceServiceShape["stop"] = (input) =>
    Effect.gen(function* () {
      const terminalOwnerId = ownerIdFor(input.projectId);
      return yield* withOwnerLock(
        terminalOwnerId,
        Effect.gen(function* () {
          const existing = yield* flakeMaintenanceRepository
            .getByProjectId(input)
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError("Failed to load flake maintenance state.", cause),
              ),
            );
          if (Option.isNone(existing)) {
            return null;
          }
          if (!isActiveFlakeMaintenanceStatus(existing.value.status)) {
            return existing.value;
          }

          const canceledAt = new Date().toISOString();
          const canceled: PersistedFlakeMaintenance = {
            ...existing.value,
            status: "canceled",
            finishedAt: canceledAt,
            updatedAt: canceledAt,
          };
          yield* flakeMaintenanceRepository
            .upsert(canceled)
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError("Failed to persist flake maintenance state.", cause),
              ),
            );
          yield* terminalManager
            .close({
              threadId: terminalOwnerId,
              terminalId: DEFAULT_TERMINAL_ID,
            })
            .pipe(
              Effect.mapError((cause) =>
                toFlakeMaintenanceError(
                  "Failed to stop the flake maintenance terminal session.",
                  cause,
                ),
              ),
            );
          yield* refreshGitStatus(canceled.cwd);
          return canceled;
        }),
      );
    });

  const openTerminal: FlakeMaintenanceServiceShape["openTerminal"] = (input) =>
    Effect.gen(function* () {
      const maintenance = yield* get(input);
      if (maintenance === null) {
        return yield* Effect.fail(
          toFlakeMaintenanceError("No flake maintenance run exists yet for this project."),
        );
      }

      const liveSnapshot = yield* terminalManager
        .getSnapshot({
          threadId: maintenance.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
        })
        .pipe(
          Effect.mapError((cause) =>
            toFlakeMaintenanceError("Failed to open the flake maintenance terminal.", cause),
          ),
        );
      if (liveSnapshot !== null) {
        if (input.cols && input.rows && liveSnapshot.status === "running") {
          yield* terminalManager
            .resize({
              threadId: maintenance.terminalOwnerId,
              terminalId: DEFAULT_TERMINAL_ID,
              cols: input.cols,
              rows: input.rows,
            })
            .pipe(Effect.ignore);
        }
        return mapTerminalSnapshot(liveSnapshot);
      }

      const history = yield* terminalManager
        .readHistory({
          threadId: maintenance.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
        })
        .pipe(
          Effect.mapError((cause) =>
            toFlakeMaintenanceError("Failed to load flake maintenance terminal history.", cause),
          ),
        );
      return {
        terminalOwnerId: maintenance.terminalOwnerId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: maintenance.cwd,
        worktreePath: null,
        status: toTerminalStatus(maintenance.status),
        pid: null,
        history,
        exitCode: maintenance.exitCode,
        exitSignal: maintenance.exitSignal,
        updatedAt: maintenance.updatedAt,
      } satisfies FlakeMaintenanceTerminalSnapshot;
    });

  const resizeTerminal: FlakeMaintenanceServiceShape["resizeTerminal"] = (input) =>
    Effect.gen(function* () {
      const maintenance = yield* get(input);
      if (maintenance === null || !isActiveFlakeMaintenanceStatus(maintenance.status)) {
        return;
      }
      yield* terminalManager
        .resize({
          threadId: maintenance.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
          cols: input.cols,
          rows: input.rows,
        })
        .pipe(Effect.ignore);
    });

  const subscribeTerminalEvents: FlakeMaintenanceServiceShape["subscribeTerminalEvents"] = (
    input,
  ) =>
    Stream.callback<FlakeMaintenanceTerminalEvent, FlakeMaintenanceError>((queue) => {
      const terminalOwnerId = ownerIdFor(input.projectId);
      return Effect.acquireRelease(
        terminalManager.subscribe((event) => {
          if (event.threadId !== terminalOwnerId) {
            return Effect.void;
          }
          return Queue.offer(queue, mapTerminalEvent(event as never)).pipe(Effect.asVoid);
        }),
        (release) => Effect.sync(release),
      ).pipe(
        Effect.mapError((cause) =>
          toFlakeMaintenanceError(
            "Failed to subscribe to flake maintenance terminal events.",
            cause,
          ),
        ),
      );
    });

  return {
    start,
    get,
    stop,
    openTerminal,
    resizeTerminal,
    subscribeTerminalEvents,
  } satisfies FlakeMaintenanceServiceShape;
});

export const FlakeMaintenanceServiceLive = Layer.effect(
  FlakeMaintenanceService,
  makeFlakeMaintenanceService,
);
