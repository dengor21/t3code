import { Effect, Schema } from "effect";

import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const FleetDeploymentParallelism = PositiveInt.check(Schema.isLessThanOrEqualTo(5));

export const FleetDeploymentStatus = Schema.Literals([
  "starting",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "error",
]);
export type FleetDeploymentStatus = typeof FleetDeploymentStatus.Type;

export const FleetDeploymentHostStatus = Schema.Literals([
  "queued",
  "starting",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "skipped",
  "error",
]);
export type FleetDeploymentHostStatus = typeof FleetDeploymentHostStatus.Type;

export const FleetDeploymentHostEntry = Schema.Struct({
  hostName: TrimmedNonEmptyString,
  order: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: FleetDeploymentHostStatus,
  terminalOwnerId: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  startedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  finishedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  updatedAt: IsoDateTime,
  exitCode: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  exitSignal: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type FleetDeploymentHostEntry = typeof FleetDeploymentHostEntry.Type;

export const FleetDeploymentSummary = Schema.Struct({
  rolloutId: TrimmedNonEmptyString,
  projectId: ProjectId,
  status: FleetDeploymentStatus,
  maxParallelism: FleetDeploymentParallelism,
  stopOnFirstFailure: Schema.Boolean,
  deployOnServer: Schema.Boolean,
  magicRollback: Schema.NullOr(Schema.Boolean).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  confirmTimeoutSeconds: Schema.NullOr(PositiveInt).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  updatedAt: IsoDateTime,
  lastError: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  hostEntries: Schema.Array(FleetDeploymentHostEntry),
});
export type FleetDeploymentSummary = typeof FleetDeploymentSummary.Type;

export const FleetDeploymentStartInput = Schema.Struct({
  projectId: ProjectId,
  hostNames: Schema.Array(TrimmedNonEmptyString).check(Schema.isMinLength(1)),
  maxParallelism: Schema.optional(FleetDeploymentParallelism),
  deployOnServer: Schema.optional(Schema.Boolean),
  magicRollback: Schema.optional(Schema.Boolean),
  confirmTimeoutSeconds: Schema.optional(PositiveInt),
  stopOnFirstFailure: Schema.optional(Schema.Boolean),
});
export type FleetDeploymentStartInput = typeof FleetDeploymentStartInput.Type;

export const FleetDeploymentStartResult = Schema.Struct({
  disposition: Schema.Literals(["started", "already-running"]),
  rollout: FleetDeploymentSummary,
});
export type FleetDeploymentStartResult = typeof FleetDeploymentStartResult.Type;

export const FleetDeploymentGetInput = Schema.Struct({
  projectId: ProjectId,
});
export type FleetDeploymentGetInput = typeof FleetDeploymentGetInput.Type;

export const FleetDeploymentStopInput = FleetDeploymentGetInput;
export type FleetDeploymentStopInput = typeof FleetDeploymentStopInput.Type;

export class FleetDeploymentError extends Schema.TaggedErrorClass<FleetDeploymentError>()(
  "FleetDeploymentError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const NullOrFleetDeploymentSummary = Schema.NullOr(FleetDeploymentSummary).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
export type NullOrFleetDeploymentSummary = typeof NullOrFleetDeploymentSummary.Type;
