import {
  type FleetDeploymentHostStatus as FleetDeploymentHostStatusType,
  type FleetDeploymentStatus as FleetDeploymentStatusType,
  ProjectId,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { FleetDeploymentRepositoryError } from "../Errors.ts";

export const PersistedFleetDeployment = Schema.Struct({
  rolloutId: Schema.String,
  projectId: ProjectId,
  status: Schema.Literals(["starting", "running", "succeeded", "failed", "canceled", "error"]),
  maxParallelism: Schema.Int,
  stopOnFirstFailure: Schema.Boolean,
  deployOnServer: Schema.Boolean,
  magicRollback: Schema.NullOr(Schema.Boolean),
  confirmTimeoutSeconds: Schema.NullOr(Schema.Int),
  startedAt: Schema.String,
  finishedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  lastError: Schema.NullOr(Schema.String),
});
export type PersistedFleetDeployment = typeof PersistedFleetDeployment.Type;

export const PersistedFleetDeploymentHost = Schema.Struct({
  rolloutId: Schema.String,
  hostName: Schema.String,
  hostNameNormalized: Schema.String,
  order: Schema.Int,
  status: Schema.Literals([
    "queued",
    "starting",
    "running",
    "succeeded",
    "failed",
    "canceled",
    "skipped",
    "error",
  ]),
  terminalOwnerId: Schema.NullOr(Schema.String),
  startedAt: Schema.NullOr(Schema.String),
  finishedAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});
export type PersistedFleetDeploymentHost = typeof PersistedFleetDeploymentHost.Type;

export const FleetDeploymentLookup = Schema.Struct({
  projectId: ProjectId,
});
export type FleetDeploymentLookup = typeof FleetDeploymentLookup.Type;

export const FleetDeploymentHostLookup = Schema.Struct({
  rolloutId: Schema.String,
});
export type FleetDeploymentHostLookup = typeof FleetDeploymentHostLookup.Type;

export interface FleetDeploymentRepositoryShape {
  readonly upsertRollout: (
    row: PersistedFleetDeployment,
  ) => Effect.Effect<void, FleetDeploymentRepositoryError>;
  readonly upsertHostEntry: (
    row: PersistedFleetDeploymentHost,
  ) => Effect.Effect<void, FleetDeploymentRepositoryError>;
  readonly getLatestByProjectId: (
    input: FleetDeploymentLookup,
  ) => Effect.Effect<Option.Option<PersistedFleetDeployment>, FleetDeploymentRepositoryError>;
  readonly listHostEntriesByRolloutId: (
    input: FleetDeploymentHostLookup,
  ) => Effect.Effect<ReadonlyArray<PersistedFleetDeploymentHost>, FleetDeploymentRepositoryError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<PersistedFleetDeployment>,
    FleetDeploymentRepositoryError
  >;
}

export class FleetDeploymentRepository extends Context.Service<
  FleetDeploymentRepository,
  FleetDeploymentRepositoryShape
>()("t3/persistence/Services/FleetDeployments/FleetDeploymentRepository") {}

export function isActiveFleetDeploymentStatus(status: FleetDeploymentStatusType): boolean {
  return status === "starting" || status === "running";
}

export function isActiveFleetDeploymentHostStatus(status: FleetDeploymentHostStatusType): boolean {
  return status === "queued" || status === "starting" || status === "running";
}
