import { Effect, Schema } from "effect";
import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HostDeploymentStatus = Schema.Literals([
  "starting",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "error",
]);
export type HostDeploymentStatus = typeof HostDeploymentStatus.Type;

export const HostDeploymentSummary = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  terminalOwnerId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  deployOnServer: Schema.Boolean,
  status: HostDeploymentStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});
export type HostDeploymentSummary = typeof HostDeploymentSummary.Type;

export const HostDeploymentStartInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  deployOnServer: Schema.optional(Schema.Boolean),
  magicRollback: Schema.optional(Schema.Boolean),
  confirmTimeoutSeconds: Schema.optional(PositiveInt),
});
export type HostDeploymentStartInput = typeof HostDeploymentStartInput.Type;

export const HostDeploymentStartResult = Schema.Struct({
  disposition: Schema.Literals(["started", "already-running"]),
  deployment: HostDeploymentSummary,
});
export type HostDeploymentStartResult = typeof HostDeploymentStartResult.Type;

export const HostDeploymentGetInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
});
export type HostDeploymentGetInput = typeof HostDeploymentGetInput.Type;

export const HostDeploymentStopInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
});
export type HostDeploymentStopInput = typeof HostDeploymentStopInput.Type;

const HostDeploymentTerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)).check(
  Schema.isLessThanOrEqualTo(400),
);
const HostDeploymentTerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);

export const HostDeploymentTerminalOpenInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  cols: Schema.optional(HostDeploymentTerminalColsSchema),
  rows: Schema.optional(HostDeploymentTerminalRowsSchema),
});
export type HostDeploymentTerminalOpenInput = typeof HostDeploymentTerminalOpenInput.Type;

export const HostDeploymentTerminalResizeInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  cols: HostDeploymentTerminalColsSchema,
  rows: HostDeploymentTerminalRowsSchema,
});
export type HostDeploymentTerminalResizeInput = typeof HostDeploymentTerminalResizeInput.Type;

export const HostDeploymentTerminalSnapshot = Schema.Struct({
  terminalOwnerId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  worktreePath: Schema.NullOr(TrimmedNonEmptyString),
  status: Schema.Literals(["starting", "running", "exited", "error"]),
  pid: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  history: Schema.String,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
  updatedAt: IsoDateTime,
});
export type HostDeploymentTerminalSnapshot = typeof HostDeploymentTerminalSnapshot.Type;

const HostDeploymentTerminalEventBase = Schema.Struct({
  terminalOwnerId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const HostDeploymentTerminalStartedEvent = Schema.Struct({
  ...HostDeploymentTerminalEventBase.fields,
  type: Schema.Literal("started"),
  snapshot: HostDeploymentTerminalSnapshot,
});

const HostDeploymentTerminalOutputEvent = Schema.Struct({
  ...HostDeploymentTerminalEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const HostDeploymentTerminalExitedEvent = Schema.Struct({
  ...HostDeploymentTerminalEventBase.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const HostDeploymentTerminalErrorEvent = Schema.Struct({
  ...HostDeploymentTerminalEventBase.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const HostDeploymentTerminalClearedEvent = Schema.Struct({
  ...HostDeploymentTerminalEventBase.fields,
  type: Schema.Literal("cleared"),
});

const HostDeploymentTerminalRestartedEvent = Schema.Struct({
  ...HostDeploymentTerminalEventBase.fields,
  type: Schema.Literal("restarted"),
  snapshot: HostDeploymentTerminalSnapshot,
});

const HostDeploymentTerminalActivityEvent = Schema.Struct({
  ...HostDeploymentTerminalEventBase.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
});

export const HostDeploymentTerminalEvent = Schema.Union([
  HostDeploymentTerminalStartedEvent,
  HostDeploymentTerminalOutputEvent,
  HostDeploymentTerminalExitedEvent,
  HostDeploymentTerminalErrorEvent,
  HostDeploymentTerminalClearedEvent,
  HostDeploymentTerminalRestartedEvent,
  HostDeploymentTerminalActivityEvent,
]);
export type HostDeploymentTerminalEvent = typeof HostDeploymentTerminalEvent.Type;

export class HostDeploymentError extends Schema.TaggedErrorClass<HostDeploymentError>()(
  "HostDeploymentError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const NullOrHostDeploymentSummary = Schema.NullOr(HostDeploymentSummary).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
export type NullOrHostDeploymentSummary = typeof NullOrHostDeploymentSummary.Type;
