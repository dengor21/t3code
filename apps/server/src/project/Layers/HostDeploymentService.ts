import {
  DEFAULT_TERMINAL_ID,
  HostDeploymentError,
  type HostDeploymentGetInput,
  type HostDeploymentStartInput,
  type HostDeploymentStartResult,
  type HostDeploymentSummary,
  type HostDeploymentTerminalEvent,
  type HostDeploymentTerminalSnapshot,
  type ProjectId,
  buildDeployRsCommand,
} from "@t3tools/contracts";
import { Cache, Duration, Effect, Layer, Option, Queue, Semaphore, Stream } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HostDeploymentRepository } from "../../persistence/Services/HostDeployments.ts";
import {
  isActiveHostDeploymentStatus,
  type PersistedHostDeployment,
} from "../../persistence/Services/HostDeployments.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { DeployRsResolver } from "../Services/DeployRsResolver.ts";
import { DeploymentSafetyService } from "../Services/DeploymentSafetyService.ts";
import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";
import {
  HostDeploymentService,
  type HostDeploymentServiceShape,
} from "../Services/HostDeploymentService.ts";

const HOST_DEPLOYMENT_OWNER_PREFIX = "host-deploy:";

function normalizeHostName(value: string): string {
  return value.trim().toLowerCase();
}

function toHostDeploymentError(message: string, cause?: unknown): HostDeploymentError {
  return new HostDeploymentError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toTerminalStatus(
  status: HostDeploymentSummary["status"],
): HostDeploymentTerminalSnapshot["status"] {
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

function ownerIdFor(projectId: ProjectId, hostNameNormalized: string): string {
  return `${HOST_DEPLOYMENT_OWNER_PREFIX}${projectId}:${hostNameNormalized}`;
}

function parseOwnerId(
  terminalOwnerId: string,
): { projectId: ProjectId; hostNameNormalized: string } | null {
  if (!terminalOwnerId.startsWith(HOST_DEPLOYMENT_OWNER_PREFIX)) {
    return null;
  }
  const remainder = terminalOwnerId.slice(HOST_DEPLOYMENT_OWNER_PREFIX.length);
  const separatorIndex = remainder.indexOf(":");
  if (separatorIndex <= 0 || separatorIndex >= remainder.length - 1) {
    return null;
  }
  return {
    projectId: remainder.slice(0, separatorIndex) as ProjectId,
    hostNameNormalized: remainder.slice(separatorIndex + 1),
  };
}

function toSummary(row: PersistedHostDeployment): HostDeploymentSummary {
  const { hostNameNormalized: _ignored, ...summary } = row;
  return summary;
}

function toPersisted(
  summary: HostDeploymentSummary,
  hostNameNormalized: string,
): PersistedHostDeployment {
  return {
    ...summary,
    hostNameNormalized,
  };
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
}): HostDeploymentTerminalSnapshot {
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
  type: HostDeploymentTerminalEvent["type"];
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
}): HostDeploymentTerminalEvent {
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

const makeHostDeploymentService = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const flakeMetadataResolver = yield* FlakeMetadataResolver;
  const deployRsResolver = yield* DeployRsResolver;
  const deploymentSafetyService = yield* DeploymentSafetyService;
  const terminalManager = yield* TerminalManager;
  const hostDeploymentRepository = yield* HostDeploymentRepository;

  const ownerLockCache = yield* Cache.make({
    capacity: 256,
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

  const getPersisted = Effect.fn("hostDeployment.getPersisted")(function* (
    input: HostDeploymentGetInput,
  ) {
    return yield* hostDeploymentRepository
      .getByProjectAndHost({
        projectId: input.projectId,
        hostNameNormalized: normalizeHostName(input.hostName),
      })
      .pipe(
        Effect.mapError((cause) =>
          toHostDeploymentError("Failed to load host deployment state.", cause),
        ),
      );
  });

  const resolveStartContext = Effect.fn("hostDeployment.resolveStartContext")(function* (
    input: HostDeploymentStartInput,
  ) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
      Effect.mapError((cause) =>
        toHostDeploymentError("Failed to load the selected flake.", cause),
      ),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () =>
            Effect.fail(toHostDeploymentError(`Flake ${input.projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

    const flakeMetadata =
      project.flakeMetadata ??
      (yield* flakeMetadataResolver
        .resolve(project.workspaceRoot)
        .pipe(
          Effect.mapError((cause) =>
            toHostDeploymentError("Failed to resolve flake host metadata.", cause),
          ),
        ));
    const hosts =
      flakeMetadata.hosts.length > 0
        ? flakeMetadata.hosts
        : flakeMetadata.host
          ? [flakeMetadata.host]
          : [];
    const hostNameNormalized = normalizeHostName(input.hostName);
    const selectedHost =
      hosts.find((host) => normalizeHostName(host.name) === hostNameNormalized) ?? null;

    if (selectedHost === null) {
      return yield* toHostDeploymentError(
        `Host ${input.hostName} was not found in the selected flake.`,
      );
    }

    const hostDeployments = yield* deployRsResolver
      .resolveHostDeployments({
        workspaceRoot: project.workspaceRoot,
        hosts,
      })
      .pipe(
        Effect.mapError((cause) =>
          toHostDeploymentError("Failed to resolve deploy-rs host targets.", cause),
        ),
      );

    const deployment = hostDeployments.get(hostNameNormalized) ?? null;
    if (deployment === null || deployment.status !== "deployable") {
      const message =
        deployment?.reason === "evaluation-failed"
          ? "Could not evaluate deploy-rs targets for the selected flake."
          : `Host ${selectedHost.name} does not have a deploy-rs target configured.`;
      return yield* toHostDeploymentError(message);
    }

    const deployOnServer = input.deployOnServer === true;
    const magicRollback = input.magicRollback;
    const confirmTimeoutSeconds = input.confirmTimeoutSeconds;
    const activationStrategy = input.activationStrategy ?? "switch";

    return {
      project,
      selectedHost,
      deployOnServer,
      magicRollback,
      confirmTimeoutSeconds,
      activationStrategy,
      hostNameNormalized,
      command: buildDeployRsCommand(selectedHost.name, {
        deployOnServer,
        magicRollback,
        confirmTimeoutSeconds,
        activationStrategy,
      }),
      terminalOwnerId: ownerIdFor(input.projectId, hostNameNormalized),
    } as const;
  });

  const updateSummaryFromTerminalEvent = Effect.fn("hostDeployment.updateFromTerminalEvent")(
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
      const parsedOwner = parseOwnerId(event.threadId);
      if (parsedOwner === null) {
        return;
      }

      const current = yield* hostDeploymentRepository
        .getByProjectAndHost(parsedOwner)
        .pipe(
          Effect.mapError((cause) =>
            toHostDeploymentError("Failed to load host deployment state.", cause),
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
          const postflightReport =
            existing.status === "canceled" || event.exitCode !== 0
              ? existing.postflightReport
              : yield* deploymentSafetyService
                  .buildPostflightReport({
                    projectId: existing.projectId,
                    hostName: existing.hostName,
                    activationStrategy: existing.activationStrategy,
                  })
                  .pipe(Effect.catch(() => Effect.succeed(existing.postflightReport)));
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
            postflightReport,
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

      yield* hostDeploymentRepository
        .upsert(next)
        .pipe(
          Effect.mapError((cause) =>
            toHostDeploymentError("Failed to persist host deployment state.", cause),
          ),
        );
    },
  );

  const repairActiveDeployments = hostDeploymentRepository.listActive().pipe(
    Effect.mapError((cause) =>
      toHostDeploymentError("Failed to repair host deployment state.", cause),
    ),
    Effect.flatMap((deployments) =>
      Effect.forEach(
        deployments,
        (deployment) => {
          const now = new Date().toISOString();
          return hostDeploymentRepository
            .upsert({
              ...deployment,
              status: "error",
              finishedAt: deployment.finishedAt ?? now,
              updatedAt: now,
            })
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError("Failed to repair host deployment state.", cause),
              ),
            );
        },
        { discard: true },
      ),
    ),
  );
  yield* repairActiveDeployments;

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

  const get: HostDeploymentServiceShape["get"] = (input) =>
    getPersisted(input).pipe(Effect.map(Option.match({ onNone: () => null, onSome: toSummary })));

  const listByProjectId: HostDeploymentServiceShape["listByProjectId"] = (projectId) =>
    hostDeploymentRepository.listByProjectId({ projectId }).pipe(
      Effect.mapError((cause) =>
        toHostDeploymentError("Failed to load host deployment state.", cause),
      ),
      Effect.map(
        (rows) => new Map(rows.map((row) => [row.hostNameNormalized, toSummary(row)] as const)),
      ),
    );

  const start: HostDeploymentServiceShape["start"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      return yield* withOwnerLock(
        context.terminalOwnerId,
        Effect.gen(function* () {
          const existing = yield* hostDeploymentRepository
            .getByProjectAndHost({
              projectId: input.projectId,
              hostNameNormalized: context.hostNameNormalized,
            })
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError("Failed to load host deployment state.", cause),
              ),
            );

          if (Option.isSome(existing) && isActiveHostDeploymentStatus(existing.value.status)) {
            const liveSnapshot = yield* terminalManager
              .getSnapshot({
                threadId: context.terminalOwnerId,
                terminalId: DEFAULT_TERMINAL_ID,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toHostDeploymentError("Failed to inspect the active host deployment.", cause),
                ),
              );
            if (liveSnapshot !== null && liveSnapshot.status === "running") {
              return {
                disposition: "already-running",
                deployment: toSummary(existing.value),
              } as const;
            }

            const repairedAt = new Date().toISOString();
            const repaired = {
              ...existing.value,
              status: "error" as const,
              finishedAt: existing.value.finishedAt ?? repairedAt,
              updatedAt: repairedAt,
            };
            yield* hostDeploymentRepository
              .upsert(repaired)
              .pipe(
                Effect.mapError((cause) =>
                  toHostDeploymentError("Failed to repair host deployment state.", cause),
                ),
              );
          }

          const preflight = yield* deploymentSafetyService
            .preview({
              projectId: input.projectId,
              hostName: context.selectedHost.name,
              deployOnServer: context.deployOnServer,
              ...(context.magicRollback !== undefined
                ? { magicRollback: context.magicRollback }
                : {}),
              ...(context.confirmTimeoutSeconds !== undefined
                ? { confirmTimeoutSeconds: context.confirmTimeoutSeconds }
                : {}),
              activationStrategy: context.activationStrategy,
              acknowledgeWarnings: input.acknowledgeWarnings,
            })
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError("Failed to run deployment preflight checks.", cause),
              ),
            );

          if (!preflight.report.canProceed) {
            const blockingCheck = preflight.report.checks.find(
              (check) => check.severity === "blocking" && check.result === "fail",
            );
            const warningCheck = preflight.report.checks.find((check) => check.result === "warn");
            const message =
              blockingCheck?.recommendedAction === "use-boot-activation"
                ? "Live switch is not recommended for this deployment. Stage it for next boot instead."
                : (blockingCheck?.summary ??
                  warningCheck?.summary ??
                  "Acknowledge deployment warnings before starting.");
            return yield* toHostDeploymentError(message);
          }

          yield* terminalManager
            .close({
              threadId: context.terminalOwnerId,
              deleteHistory: true,
            })
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError(
                  "Failed to reset the previous host deployment session.",
                  cause,
                ),
              ),
            );

          const startedAt = new Date().toISOString();
          let summary: HostDeploymentSummary = {
            projectId: input.projectId,
            hostName: context.selectedHost.name,
            terminalOwnerId: context.terminalOwnerId,
            cwd: context.project.workspaceRoot,
            command: context.command,
            deployOnServer: context.deployOnServer,
            activationStrategy: context.activationStrategy,
            status: "starting",
            startedAt,
            finishedAt: null,
            updatedAt: startedAt,
            exitCode: null,
            exitSignal: null,
            preflightReport: preflight.report,
            postflightReport: null,
          };

          yield* hostDeploymentRepository
            .upsert(toPersisted(summary, context.hostNameNormalized))
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError("Failed to persist host deployment state.", cause),
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
                toHostDeploymentError(
                  "Failed to start the host deployment terminal session.",
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

          yield* hostDeploymentRepository
            .upsert(toPersisted(summary, context.hostNameNormalized))
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError("Failed to persist host deployment state.", cause),
              ),
            );

          return {
            disposition: "started",
            deployment: summary,
          } satisfies HostDeploymentStartResult;
        }),
      );
    });

  const stop: HostDeploymentServiceShape["stop"] = (input) =>
    Effect.gen(function* () {
      const hostNameNormalized = normalizeHostName(input.hostName);
      const terminalOwnerId = ownerIdFor(input.projectId, hostNameNormalized);
      return yield* withOwnerLock(
        terminalOwnerId,
        Effect.gen(function* () {
          const existing = yield* hostDeploymentRepository
            .getByProjectAndHost({
              projectId: input.projectId,
              hostNameNormalized,
            })
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError("Failed to load host deployment state.", cause),
              ),
            );
          if (Option.isNone(existing)) {
            return null;
          }
          if (!isActiveHostDeploymentStatus(existing.value.status)) {
            return toSummary(existing.value);
          }

          const canceledAt = new Date().toISOString();
          const canceled: PersistedHostDeployment = {
            ...existing.value,
            status: "canceled",
            finishedAt: canceledAt,
            updatedAt: canceledAt,
          };
          yield* hostDeploymentRepository
            .upsert(canceled)
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError("Failed to persist host deployment state.", cause),
              ),
            );
          yield* terminalManager
            .close({
              threadId: terminalOwnerId,
              terminalId: DEFAULT_TERMINAL_ID,
            })
            .pipe(
              Effect.mapError((cause) =>
                toHostDeploymentError(
                  "Failed to stop the host deployment terminal session.",
                  cause,
                ),
              ),
            );
          return toSummary(canceled);
        }),
      );
    });

  const openTerminal: HostDeploymentServiceShape["openTerminal"] = (input) =>
    Effect.gen(function* () {
      const deployment = yield* get(input);
      if (deployment === null) {
        return yield* toHostDeploymentError(`No deployment exists yet for host ${input.hostName}.`);
      }

      const liveSnapshot = yield* terminalManager
        .getSnapshot({
          threadId: deployment.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostDeploymentError("Failed to open the host deployment terminal.", cause),
          ),
        );
      if (liveSnapshot !== null) {
        if (input.cols && input.rows && liveSnapshot.status === "running") {
          yield* terminalManager
            .resize({
              threadId: deployment.terminalOwnerId,
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
          threadId: deployment.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostDeploymentError("Failed to load host deployment terminal history.", cause),
          ),
        );
      return {
        terminalOwnerId: deployment.terminalOwnerId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: deployment.cwd,
        worktreePath: null,
        status: toTerminalStatus(deployment.status),
        pid: null,
        history,
        exitCode: deployment.exitCode,
        exitSignal: deployment.exitSignal,
        updatedAt: deployment.updatedAt,
      } satisfies HostDeploymentTerminalSnapshot;
    });

  const resizeTerminal: HostDeploymentServiceShape["resizeTerminal"] = (input) =>
    Effect.gen(function* () {
      const deployment = yield* get(input);
      if (deployment === null || !isActiveHostDeploymentStatus(deployment.status)) {
        return;
      }
      yield* terminalManager
        .resize({
          threadId: deployment.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
          cols: input.cols,
          rows: input.rows,
        })
        .pipe(Effect.ignore);
    });

  const subscribeTerminalEvents: HostDeploymentServiceShape["subscribeTerminalEvents"] = (input) =>
    Stream.callback<HostDeploymentTerminalEvent, HostDeploymentError>((queue) => {
      const terminalOwnerId = ownerIdFor(input.projectId, normalizeHostName(input.hostName));
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
          toHostDeploymentError("Failed to subscribe to host deployment terminal events.", cause),
        ),
      );
    });

  return {
    start,
    get,
    listByProjectId,
    stop,
    openTerminal,
    resizeTerminal,
    subscribeTerminalEvents,
  } satisfies HostDeploymentServiceShape;
});

export const HostDeploymentServiceLive = Layer.effect(
  HostDeploymentService,
  makeHostDeploymentService,
);
