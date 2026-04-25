import crypto from "node:crypto";

import {
  type FleetDeploymentGetInput,
  type FleetDeploymentHostEntry,
  type FleetDeploymentHostStatus,
  type FleetDeploymentStartInput,
  type FleetDeploymentStartResult,
  type FleetDeploymentStatus,
  type FleetDeploymentSummary,
  FleetDeploymentError,
  type HostDeploymentStatus,
  type ProjectId,
} from "@t3tools/contracts";
import { Cache, Duration, Effect, Exit, Fiber, Layer, Option, Ref, Scope, Semaphore } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { FleetDeploymentRepository } from "../../persistence/Services/FleetDeployments.ts";
import {
  isActiveFleetDeploymentHostStatus,
  isActiveFleetDeploymentStatus,
  type PersistedFleetDeployment,
  type PersistedFleetDeploymentHost,
} from "../../persistence/Services/FleetDeployments.ts";
import { isActiveHostDeploymentStatus } from "../../persistence/Services/HostDeployments.ts";
import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";
import { DeploymentSafetyService } from "../Services/DeploymentSafetyService.ts";
import {
  FleetDeploymentService,
  type FleetDeploymentServiceShape,
} from "../Services/FleetDeploymentService.ts";
import { HostDeploymentService } from "../Services/HostDeploymentService.ts";

const DEFAULT_MAX_PARALLELISM = 1;
const POLL_INTERVAL = Duration.millis(500);

function normalizeHostName(value: string): string {
  return value.trim().toLowerCase();
}

function toFleetDeploymentError(message: string, cause?: unknown): FleetDeploymentError {
  return new FleetDeploymentError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function mapPersistedHostEntry(row: PersistedFleetDeploymentHost): FleetDeploymentHostEntry {
  return {
    hostName: row.hostName,
    order: row.order,
    status: row.status,
    terminalOwnerId: row.terminalOwnerId,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
    exitCode: row.exitCode,
    exitSignal: row.exitSignal,
    preflightReport: row.preflightReport,
    postflightReport: row.postflightReport,
  };
}

function mapPersistedRollout(
  row: PersistedFleetDeployment,
  hostEntries: ReadonlyArray<PersistedFleetDeploymentHost>,
): FleetDeploymentSummary {
  return {
    rolloutId: row.rolloutId,
    projectId: row.projectId,
    status: row.status,
    maxParallelism: row.maxParallelism,
    stopOnFirstFailure: row.stopOnFirstFailure,
    deployOnServer: row.deployOnServer,
    activationStrategy: row.activationStrategy,
    magicRollback: row.magicRollback,
    confirmTimeoutSeconds: row.confirmTimeoutSeconds,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    updatedAt: row.updatedAt,
    lastError: row.lastError,
    hostEntries: hostEntries.map(mapPersistedHostEntry),
  };
}

function mapHostDeploymentStatus(status: HostDeploymentStatus): FleetDeploymentHostStatus {
  switch (status) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "canceled":
      return "canceled";
    case "error":
    default:
      return "error";
  }
}

interface StartContext {
  readonly projectId: ProjectId;
  readonly selectedHosts: ReadonlyArray<{ readonly hostName: string; readonly normalized: string }>;
  readonly maxParallelism: number;
  readonly stopOnFirstFailure: boolean;
  readonly deployOnServer: boolean;
  readonly activationStrategy: "switch" | "boot";
  readonly magicRollback: boolean | null;
  readonly confirmTimeoutSeconds: number | null;
  readonly acknowledgeWarnings: boolean;
}

interface ActiveRolloutControl {
  readonly rolloutId: string;
  readonly cancelRequested: Ref.Ref<boolean>;
  readonly fiber: Fiber.Fiber<unknown, never>;
}

function isTerminalActiveStatus(status: FleetDeploymentHostStatus): boolean {
  return status === "starting" || status === "running";
}

function summarizeFinalStatus(
  hostEntries: Iterable<PersistedFleetDeploymentHost>,
  cancelRequested: boolean,
): FleetDeploymentStatus {
  if (cancelRequested) {
    return "canceled";
  }

  let hasFailure = false;
  let hasOnlySuccess = true;
  for (const entry of hostEntries) {
    if (entry.status === "failed" || entry.status === "error") {
      hasFailure = true;
    }
    if (entry.status !== "succeeded") {
      hasOnlySuccess = false;
    }
  }

  if (hasFailure) {
    return "failed";
  }
  if (hasOnlySuccess) {
    return "succeeded";
  }
  return "error";
}

export const FleetDeploymentServiceLive = Layer.effect(
  FleetDeploymentService,
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const flakeMetadataResolver = yield* FlakeMetadataResolver;
    const deploymentSafetyService = yield* DeploymentSafetyService;
    const hostDeploymentService = yield* HostDeploymentService;
    const fleetDeploymentRepository = yield* FleetDeploymentRepository;

    const rolloutScope = yield* Effect.acquireRelease(Scope.make(), (scope) =>
      Scope.close(scope, Exit.void),
    );
    const ownerLockCache = yield* Cache.make({
      capacity: 128,
      timeToLive: Duration.minutes(10),
      lookup: () => Semaphore.make(1),
    });
    const activeRolloutsRef = yield* Ref.make(new Map<ProjectId, ActiveRolloutControl>());

    const withProjectLock = <A, E, R>(
      projectId: ProjectId,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E, R> =>
      Effect.flatMap(Cache.get(ownerLockCache, projectId), (semaphore) =>
        semaphore.withPermit(effect),
      );

    const getPersistedSummary = Effect.fn("fleetDeployment.getPersistedSummary")(function* (
      input: FleetDeploymentGetInput,
    ) {
      const rollout = yield* fleetDeploymentRepository
        .getLatestByProjectId(input)
        .pipe(
          Effect.mapError((cause) =>
            toFleetDeploymentError("Failed to load fleet deployment state.", cause),
          ),
        );
      if (Option.isNone(rollout)) {
        return null;
      }

      const hostEntries = yield* fleetDeploymentRepository
        .listHostEntriesByRolloutId({
          rolloutId: rollout.value.rolloutId,
        })
        .pipe(
          Effect.mapError((cause) =>
            toFleetDeploymentError("Failed to load fleet deployment host state.", cause),
          ),
        );
      return mapPersistedRollout(rollout.value, hostEntries);
    });

    const resolveStartContext = Effect.fn("fleetDeployment.resolveStartContext")(function* (
      input: FleetDeploymentStartInput,
    ) {
      const projectOption = yield* projectionSnapshotQuery
        .getProjectShellById(input.projectId)
        .pipe(
          Effect.mapError((cause) =>
            toFleetDeploymentError("Failed to load the selected flake.", cause),
          ),
        );
      if (Option.isNone(projectOption)) {
        return yield* toFleetDeploymentError(`Flake ${input.projectId} was not found.`);
      }
      const project = projectOption.value;

      const flakeMetadata =
        project.flakeMetadata ??
        (yield* flakeMetadataResolver
          .resolve(project.workspaceRoot)
          .pipe(
            Effect.mapError((cause) =>
              toFleetDeploymentError("Failed to resolve flake host metadata.", cause),
            ),
          ));
      const hosts =
        flakeMetadata.hosts.length > 0
          ? flakeMetadata.hosts
          : flakeMetadata.host
            ? [flakeMetadata.host]
            : [];
      const hostsByName = new Map<string, string>(
        hosts.map((host): [string, string] => [normalizeHostName(host.name), host.name]),
      );
      const selectedHosts: Array<{ hostName: string; normalized: string }> = [];
      const seen = new Set<string>();
      for (const rawHostName of input.hostNames) {
        const normalized = normalizeHostName(rawHostName);
        if (!normalized || seen.has(normalized)) {
          continue;
        }
        const hostName = hostsByName.get(normalized);
        if (!hostName) {
          return yield* toFleetDeploymentError(
            `Host ${rawHostName} was not found in the selected flake.`,
          );
        }
        seen.add(normalized);
        selectedHosts.push({
          hostName,
          normalized,
        });
      }

      if (selectedHosts.length === 0) {
        return yield* toFleetDeploymentError("Select at least one host for the rollout.");
      }

      return {
        projectId: input.projectId,
        selectedHosts,
        maxParallelism: input.maxParallelism ?? DEFAULT_MAX_PARALLELISM,
        stopOnFirstFailure: input.stopOnFirstFailure !== false,
        deployOnServer: input.deployOnServer === true,
        activationStrategy: input.activationStrategy ?? "switch",
        magicRollback: input.magicRollback ?? null,
        confirmTimeoutSeconds: input.confirmTimeoutSeconds ?? null,
        acknowledgeWarnings: input.acknowledgeWarnings === true,
      } satisfies StartContext;
    });

    const updateControl = (
      projectId: ProjectId,
      updater: (
        current: Map<ProjectId, ActiveRolloutControl>,
      ) => Map<ProjectId, ActiveRolloutControl>,
    ) => Ref.update(activeRolloutsRef, updater);

    const clearControl = (projectId: ProjectId, rolloutId: string) =>
      updateControl(projectId, (current) => {
        const existing = current.get(projectId);
        if (!existing || existing.rolloutId !== rolloutId) {
          return current;
        }
        const next = new Map(current);
        next.delete(projectId);
        return next;
      });

    const repairActiveRollouts = fleetDeploymentRepository.listActive().pipe(
      Effect.mapError((cause) =>
        toFleetDeploymentError("Failed to repair fleet deployment state.", cause),
      ),
      Effect.flatMap((rollouts) =>
        Effect.forEach(
          rollouts,
          (rollout) =>
            Effect.gen(function* () {
              const repairedAt = new Date().toISOString();
              yield* fleetDeploymentRepository.upsertRollout({
                ...rollout,
                status: "error",
                finishedAt: repairedAt,
                updatedAt: repairedAt,
                lastError: rollout.lastError ?? "Server restarted during rollout execution.",
              });

              const hostEntries = yield* fleetDeploymentRepository.listHostEntriesByRolloutId({
                rolloutId: rollout.rolloutId,
              });
              yield* Effect.forEach(
                hostEntries,
                (entry) =>
                  isActiveFleetDeploymentHostStatus(entry.status)
                    ? fleetDeploymentRepository.upsertHostEntry({
                        ...entry,
                        status: entry.status === "queued" ? "skipped" : "error",
                        finishedAt: entry.finishedAt ?? repairedAt,
                        updatedAt: repairedAt,
                      })
                    : Effect.void,
                { discard: true },
              );
            }),
          { discard: true },
        ),
      ),
    );
    yield* repairActiveRollouts;

    const runRollout = (
      context: StartContext,
      rolloutId: string,
      cancelRequestedRef: Ref.Ref<boolean>,
    ) =>
      Effect.gen(function* () {
        let rollout: PersistedFleetDeployment = {
          rolloutId,
          projectId: context.projectId,
          status: "running",
          maxParallelism: context.maxParallelism,
          stopOnFirstFailure: context.stopOnFirstFailure,
          deployOnServer: context.deployOnServer,
          activationStrategy: context.activationStrategy,
          magicRollback: context.magicRollback,
          confirmTimeoutSeconds: context.confirmTimeoutSeconds,
          startedAt: new Date().toISOString(),
          finishedAt: null,
          updatedAt: new Date().toISOString(),
          lastError: null,
        };
        const makeQueuedHostEntry = (
          host: StartContext["selectedHosts"][number],
          order: number,
          updatedAt: string,
        ): PersistedFleetDeploymentHost => ({
          rolloutId,
          hostName: host.hostName,
          hostNameNormalized: host.normalized,
          order,
          status: "queued",
          terminalOwnerId: null,
          startedAt: null,
          finishedAt: null,
          updatedAt,
          exitCode: null,
          exitSignal: null,
          preflightReport: null,
          postflightReport: null,
        });
        const hostEntries = new Map<string, PersistedFleetDeploymentHost>(
          context.selectedHosts.map(
            (host, index): readonly [string, PersistedFleetDeploymentHost] => [
              host.normalized,
              makeQueuedHostEntry(host, index, rollout.updatedAt),
            ],
          ),
        );

        const upsertRollout = (next: PersistedFleetDeployment) =>
          fleetDeploymentRepository
            .upsertRollout(next)
            .pipe(
              Effect.mapError((cause) =>
                toFleetDeploymentError("Failed to persist fleet deployment state.", cause),
              ),
            );

        const upsertHostEntry = (next: PersistedFleetDeploymentHost) =>
          fleetDeploymentRepository
            .upsertHostEntry(next)
            .pipe(
              Effect.mapError((cause) =>
                toFleetDeploymentError("Failed to persist fleet deployment host state.", cause),
              ),
            );

        const updateHostEntry = Effect.fn("fleetDeployment.updateHostEntry")(function* (
          normalizedHostName: string,
          updater: (current: PersistedFleetDeploymentHost) => PersistedFleetDeploymentHost,
        ) {
          const current = hostEntries.get(normalizedHostName);
          if (!current) {
            return;
          }
          const next = updater(current);
          hostEntries.set(normalizedHostName, next);
          rollout = {
            ...rollout,
            updatedAt: next.updatedAt,
          };
          yield* upsertHostEntry(next);
          yield* upsertRollout(rollout);
        });

        const markQueuedHostsSkipped = Effect.fn("fleetDeployment.markQueuedHostsSkipped")(
          function* (updatedAt: string) {
            yield* Effect.forEach(
              [...hostEntries.values()].filter((entry) => entry.status === "queued"),
              (entry) =>
                updateHostEntry(entry.hostNameNormalized, (current) => ({
                  ...current,
                  status: "skipped",
                  finishedAt: updatedAt,
                  updatedAt,
                })),
              { discard: true },
            );
          },
        );

        yield* upsertRollout(rollout);
        yield* Effect.forEach([...hostEntries.values()], upsertHostEntry, { discard: true });

        let nextHostIndex = 0;
        const activeHosts = new Set<string>();
        let failureDetected = false;
        let failureMessage: string | null = null;

        while (true) {
          const cancelRequested = yield* Ref.get(cancelRequestedRef);

          while (
            activeHosts.size < context.maxParallelism &&
            nextHostIndex < context.selectedHosts.length &&
            !cancelRequested &&
            !(context.stopOnFirstFailure && failureDetected)
          ) {
            const host = context.selectedHosts[nextHostIndex]!;
            nextHostIndex += 1;
            const startedAt = new Date().toISOString();

            yield* updateHostEntry(host.normalized, (current) => ({
              ...current,
              status: "starting",
              startedAt: current.startedAt ?? startedAt,
              finishedAt: null,
              updatedAt: startedAt,
            }));

            const preflight = yield* deploymentSafetyService
              .preview({
                projectId: context.projectId,
                hostName: host.hostName,
                deployOnServer: context.deployOnServer,
                activationStrategy: context.activationStrategy,
                ...(context.magicRollback !== null ? { magicRollback: context.magicRollback } : {}),
                ...(context.confirmTimeoutSeconds !== null
                  ? { confirmTimeoutSeconds: context.confirmTimeoutSeconds }
                  : {}),
                ...(context.acknowledgeWarnings ? { acknowledgeWarnings: true } : {}),
              })
              .pipe(
                Effect.map((value) => ({ _tag: "success" as const, value })),
                Effect.catch((error) => Effect.succeed({ _tag: "failure" as const, error })),
              );

            if (preflight._tag === "failure") {
              const failedAt = new Date().toISOString();
              failureDetected = true;
              failureMessage = preflight.error.message;
              rollout = {
                ...rollout,
                lastError: preflight.error.message,
                updatedAt: failedAt,
              };
              yield* updateHostEntry(host.normalized, (current) => ({
                ...current,
                status: "error",
                finishedAt: failedAt,
                updatedAt: failedAt,
              }));
              continue;
            }

            yield* updateHostEntry(host.normalized, (current) => ({
              ...current,
              preflightReport: preflight.value.report,
              updatedAt: preflight.value.report.updatedAt,
            }));

            if (!preflight.value.report.canProceed) {
              const failedAt = preflight.value.report.updatedAt;
              const blockingCheck = preflight.value.report.checks.find(
                (check) => check.severity === "blocking" && check.result === "fail",
              );
              const warningCheck = preflight.value.report.checks.find(
                (check) => check.result === "warn",
              );
              failureDetected = true;
              failureMessage =
                blockingCheck?.summary ??
                warningCheck?.summary ??
                `Deployment preflight failed for ${host.hostName}.`;
              rollout = {
                ...rollout,
                lastError: failureMessage,
                updatedAt: failedAt,
              };
              yield* updateHostEntry(host.normalized, (current) => ({
                ...current,
                status: "error",
                finishedAt: failedAt,
                updatedAt: failedAt,
              }));
              continue;
            }

            const result = yield* hostDeploymentService
              .start({
                projectId: context.projectId,
                hostName: host.hostName,
                deployOnServer: context.deployOnServer,
                activationStrategy: context.activationStrategy,
                ...(context.magicRollback !== null ? { magicRollback: context.magicRollback } : {}),
                ...(context.confirmTimeoutSeconds !== null
                  ? { confirmTimeoutSeconds: context.confirmTimeoutSeconds }
                  : {}),
                ...(context.acknowledgeWarnings ? { acknowledgeWarnings: true } : {}),
              })
              .pipe(
                Effect.map((value) => ({ _tag: "success" as const, value })),
                Effect.catch((error) => Effect.succeed({ _tag: "failure" as const, error })),
              );

            if (result._tag === "failure") {
              const failedAt = new Date().toISOString();
              failureDetected = true;
              failureMessage = result.error.message;
              rollout = {
                ...rollout,
                lastError: result.error.message,
                updatedAt: failedAt,
              };
              yield* updateHostEntry(host.normalized, (current) => ({
                ...current,
                status: "error",
                finishedAt: failedAt,
                updatedAt: failedAt,
              }));
              continue;
            }

            const deployment = result.value.deployment;
            const childStatus = mapHostDeploymentStatus(deployment.status);
            yield* updateHostEntry(host.normalized, (current) => ({
              ...current,
              status: childStatus,
              terminalOwnerId: deployment.terminalOwnerId,
              startedAt: current.startedAt ?? deployment.startedAt,
              finishedAt: deployment.finishedAt,
              updatedAt: deployment.updatedAt,
              exitCode: deployment.exitCode,
              exitSignal: deployment.exitSignal,
              preflightReport: deployment.preflightReport,
              postflightReport: deployment.postflightReport,
            }));

            if (isActiveHostDeploymentStatus(deployment.status)) {
              activeHosts.add(host.normalized);
            } else if (deployment.status === "failed" || deployment.status === "error") {
              failureDetected = true;
              failureMessage = failureMessage ?? `Deployment failed for ${deployment.hostName}.`;
              rollout = {
                ...rollout,
                lastError: failureMessage,
                updatedAt: deployment.updatedAt,
              };
              yield* upsertRollout(rollout);
            }
          }

          if (
            (cancelRequested || (context.stopOnFirstFailure && failureDetected)) &&
            nextHostIndex < context.selectedHosts.length
          ) {
            const skippedAt = new Date().toISOString();
            yield* markQueuedHostsSkipped(skippedAt);
            nextHostIndex = context.selectedHosts.length;
          }

          if (activeHosts.size === 0) {
            if (nextHostIndex >= context.selectedHosts.length) {
              break;
            }
          } else {
            yield* Effect.sleep(POLL_INTERVAL);
            yield* Effect.forEach(
              [...activeHosts],
              (normalizedHostName) =>
                Effect.gen(function* () {
                  const hostEntry = hostEntries.get(normalizedHostName);
                  if (!hostEntry) {
                    activeHosts.delete(normalizedHostName);
                    return;
                  }
                  const deployment = yield* hostDeploymentService
                    .get({
                      projectId: context.projectId,
                      hostName: hostEntry.hostName,
                    })
                    .pipe(
                      Effect.map((value) => ({ _tag: "success" as const, value })),
                      Effect.catch((error) => Effect.succeed({ _tag: "failure" as const, error })),
                    );
                  if (deployment._tag === "failure") {
                    const failedAt = new Date().toISOString();
                    failureDetected = true;
                    failureMessage = deployment.error.message;
                    rollout = {
                      ...rollout,
                      lastError: deployment.error.message,
                      updatedAt: failedAt,
                    };
                    yield* updateHostEntry(normalizedHostName, (current) => ({
                      ...current,
                      status: "error",
                      finishedAt: failedAt,
                      updatedAt: failedAt,
                    }));
                    activeHosts.delete(normalizedHostName);
                    return;
                  }
                  if (deployment.value === null) {
                    return;
                  }
                  const deploymentSummary = deployment.value;

                  const childStatus = mapHostDeploymentStatus(deploymentSummary.status);
                  yield* updateHostEntry(normalizedHostName, (current) => ({
                    ...current,
                    status: childStatus,
                    terminalOwnerId: deploymentSummary.terminalOwnerId,
                    startedAt: current.startedAt ?? deploymentSummary.startedAt,
                    finishedAt: deploymentSummary.finishedAt,
                    updatedAt: deploymentSummary.updatedAt,
                    exitCode: deploymentSummary.exitCode,
                    exitSignal: deploymentSummary.exitSignal,
                    preflightReport: deploymentSummary.preflightReport,
                    postflightReport: deploymentSummary.postflightReport,
                  }));

                  if (!isActiveHostDeploymentStatus(deploymentSummary.status)) {
                    activeHosts.delete(normalizedHostName);
                  }
                  if (
                    deploymentSummary.status === "failed" ||
                    deploymentSummary.status === "error"
                  ) {
                    failureDetected = true;
                    failureMessage =
                      failureMessage ?? `Deployment failed for ${deploymentSummary.hostName}.`;
                    rollout = {
                      ...rollout,
                      lastError: failureMessage,
                      updatedAt: deploymentSummary.updatedAt,
                    };
                    yield* upsertRollout(rollout);
                  }
                }),
              { discard: true },
            );
          }
        }

        const canceled = yield* Ref.get(cancelRequestedRef);
        const finishedAt = new Date().toISOString();
        rollout = {
          ...rollout,
          status: summarizeFinalStatus(hostEntries.values(), canceled),
          finishedAt,
          updatedAt: finishedAt,
          lastError: canceled || rollout.lastError !== null ? rollout.lastError : failureMessage,
        };
        yield* upsertRollout(rollout);
      }).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            const failedAt = new Date().toISOString();
            yield* fleetDeploymentRepository
              .upsertRollout({
                rolloutId,
                projectId: context.projectId,
                status: "error",
                maxParallelism: context.maxParallelism,
                stopOnFirstFailure: context.stopOnFirstFailure,
                deployOnServer: context.deployOnServer,
                activationStrategy: context.activationStrategy,
                magicRollback: context.magicRollback,
                confirmTimeoutSeconds: context.confirmTimeoutSeconds,
                startedAt: failedAt,
                finishedAt: failedAt,
                updatedAt: failedAt,
                lastError: error.message,
              })
              .pipe(Effect.orDie);
          }),
        ),
        Effect.ensuring(clearControl(context.projectId, rolloutId)),
        Effect.orDie,
      );

    const get: FleetDeploymentServiceShape["get"] = (input) => getPersistedSummary(input);

    const start: FleetDeploymentServiceShape["start"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolveStartContext(input);
        return yield* withProjectLock(
          context.projectId,
          Effect.gen(function* () {
            const existing = yield* getPersistedSummary({
              projectId: context.projectId,
            });
            if (existing && isActiveFleetDeploymentStatus(existing.status)) {
              return {
                disposition: "already-running",
                rollout: existing,
              } as const;
            }

            const rolloutId = `rollout-${crypto.randomUUID()}`;
            const now = new Date().toISOString();
            const initialSummary: FleetDeploymentSummary = {
              rolloutId,
              projectId: context.projectId,
              status: "starting",
              maxParallelism: context.maxParallelism,
              stopOnFirstFailure: context.stopOnFirstFailure,
              deployOnServer: context.deployOnServer,
              activationStrategy: context.activationStrategy,
              magicRollback: context.magicRollback,
              confirmTimeoutSeconds: context.confirmTimeoutSeconds,
              startedAt: now,
              finishedAt: null,
              updatedAt: now,
              lastError: null,
              hostEntries: context.selectedHosts.map((host, index) => ({
                hostName: host.hostName,
                order: index,
                status: "queued",
                terminalOwnerId: null,
                startedAt: null,
                finishedAt: null,
                updatedAt: now,
                exitCode: null,
                exitSignal: null,
                preflightReport: null,
                postflightReport: null,
              })),
            };

            yield* fleetDeploymentRepository
              .upsertRollout({
                rolloutId,
                projectId: context.projectId,
                status: initialSummary.status,
                maxParallelism: initialSummary.maxParallelism,
                stopOnFirstFailure: initialSummary.stopOnFirstFailure,
                deployOnServer: initialSummary.deployOnServer,
                activationStrategy: initialSummary.activationStrategy,
                magicRollback: initialSummary.magicRollback,
                confirmTimeoutSeconds: initialSummary.confirmTimeoutSeconds,
                startedAt: initialSummary.startedAt,
                finishedAt: initialSummary.finishedAt,
                updatedAt: initialSummary.updatedAt,
                lastError: initialSummary.lastError,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toFleetDeploymentError("Failed to persist fleet deployment state.", cause),
                ),
              );
            yield* Effect.forEach(
              context.selectedHosts,
              (host, index) =>
                fleetDeploymentRepository.upsertHostEntry({
                  rolloutId,
                  hostName: host.hostName,
                  hostNameNormalized: host.normalized,
                  order: index,
                  status: "queued",
                  terminalOwnerId: null,
                  startedAt: null,
                  finishedAt: null,
                  updatedAt: now,
                  exitCode: null,
                  exitSignal: null,
                  preflightReport: null,
                  postflightReport: null,
                }),
              {
                discard: true,
              },
            ).pipe(
              Effect.mapError((cause) =>
                toFleetDeploymentError("Failed to persist fleet deployment host state.", cause),
              ),
            );

            const cancelRequested = yield* Ref.make(false);
            const fiber = yield* runRollout(context, rolloutId, cancelRequested).pipe(
              Effect.asVoid,
              Effect.forkIn(rolloutScope),
            );
            yield* updateControl(context.projectId, (current) => {
              const next = new Map(current);
              next.set(context.projectId, {
                rolloutId,
                cancelRequested,
                fiber,
              });
              return next;
            });

            return {
              disposition: "started",
              rollout: initialSummary,
            } satisfies FleetDeploymentStartResult;
          }),
        );
      });

    const stop: FleetDeploymentServiceShape["stop"] = (input) =>
      withProjectLock(
        input.projectId,
        Effect.gen(function* () {
          const rollout = yield* getPersistedSummary(input);
          if (!rollout) {
            return null;
          }
          if (!isActiveFleetDeploymentStatus(rollout.status)) {
            return rollout;
          }

          const controls = yield* Ref.get(activeRolloutsRef).pipe(
            Effect.map((current) => current.get(input.projectId) ?? null),
          );
          if (!controls || controls.rolloutId !== rollout.rolloutId) {
            return yield* toFleetDeploymentError("The active rollout control state is missing.");
          }

          yield* Ref.set(controls.cancelRequested, true);
          yield* Effect.forEach(
            rollout.hostEntries.filter((entry) => isTerminalActiveStatus(entry.status)),
            (entry) =>
              hostDeploymentService
                .stop({
                  projectId: input.projectId,
                  hostName: entry.hostName,
                })
                .pipe(Effect.ignoreCause({ log: true })),
            { discard: true },
          );
          yield* Fiber.await(controls.fiber);
          return yield* getPersistedSummary(input);
        }),
      );

    return {
      start,
      get,
      stop,
    } satisfies FleetDeploymentServiceShape;
  }),
);
