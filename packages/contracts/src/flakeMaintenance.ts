import { Effect, Schema } from "effect";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FlakeMaintenanceStatus = Schema.Literals([
  "starting",
  "running",
  "succeeded",
  "failed",
  "canceled",
  "error",
]);
export type FlakeMaintenanceStatus = typeof FlakeMaintenanceStatus.Type;

export const FlakeMaintenanceSummary = Schema.Struct({
  projectId: ProjectId,
  terminalOwnerId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  status: FlakeMaintenanceStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});
export type FlakeMaintenanceSummary = typeof FlakeMaintenanceSummary.Type;

export const FlakeMaintenanceStartInput = Schema.Struct({
  projectId: ProjectId,
});
export type FlakeMaintenanceStartInput = typeof FlakeMaintenanceStartInput.Type;

export const FlakeMaintenanceStartResult = Schema.Struct({
  disposition: Schema.Literals(["started", "already-running"]),
  maintenance: FlakeMaintenanceSummary,
});
export type FlakeMaintenanceStartResult = typeof FlakeMaintenanceStartResult.Type;

export const FlakeMaintenanceGetInput = Schema.Struct({
  projectId: ProjectId,
});
export type FlakeMaintenanceGetInput = typeof FlakeMaintenanceGetInput.Type;

export const FlakeMaintenanceStopInput = Schema.Struct({
  projectId: ProjectId,
});
export type FlakeMaintenanceStopInput = typeof FlakeMaintenanceStopInput.Type;

const FlakeMaintenanceTerminalColsSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(20),
).check(Schema.isLessThanOrEqualTo(400));
const FlakeMaintenanceTerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);

export const FlakeMaintenanceTerminalOpenInput = Schema.Struct({
  projectId: ProjectId,
  cols: Schema.optional(FlakeMaintenanceTerminalColsSchema),
  rows: Schema.optional(FlakeMaintenanceTerminalRowsSchema),
});
export type FlakeMaintenanceTerminalOpenInput = typeof FlakeMaintenanceTerminalOpenInput.Type;

export const FlakeMaintenanceTerminalResizeInput = Schema.Struct({
  projectId: ProjectId,
  cols: FlakeMaintenanceTerminalColsSchema,
  rows: FlakeMaintenanceTerminalRowsSchema,
});
export type FlakeMaintenanceTerminalResizeInput = typeof FlakeMaintenanceTerminalResizeInput.Type;

export const FlakeMaintenanceTerminalSnapshot = Schema.Struct({
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
export type FlakeMaintenanceTerminalSnapshot = typeof FlakeMaintenanceTerminalSnapshot.Type;

const FlakeMaintenanceTerminalEventBase = Schema.Struct({
  terminalOwnerId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const FlakeMaintenanceTerminalStartedEvent = Schema.Struct({
  ...FlakeMaintenanceTerminalEventBase.fields,
  type: Schema.Literal("started"),
  snapshot: FlakeMaintenanceTerminalSnapshot,
});

const FlakeMaintenanceTerminalOutputEvent = Schema.Struct({
  ...FlakeMaintenanceTerminalEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const FlakeMaintenanceTerminalExitedEvent = Schema.Struct({
  ...FlakeMaintenanceTerminalEventBase.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const FlakeMaintenanceTerminalErrorEvent = Schema.Struct({
  ...FlakeMaintenanceTerminalEventBase.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const FlakeMaintenanceTerminalClearedEvent = Schema.Struct({
  ...FlakeMaintenanceTerminalEventBase.fields,
  type: Schema.Literal("cleared"),
});

const FlakeMaintenanceTerminalRestartedEvent = Schema.Struct({
  ...FlakeMaintenanceTerminalEventBase.fields,
  type: Schema.Literal("restarted"),
  snapshot: FlakeMaintenanceTerminalSnapshot,
});

const FlakeMaintenanceTerminalActivityEvent = Schema.Struct({
  ...FlakeMaintenanceTerminalEventBase.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
});

export const FlakeMaintenanceTerminalEvent = Schema.Union([
  FlakeMaintenanceTerminalStartedEvent,
  FlakeMaintenanceTerminalOutputEvent,
  FlakeMaintenanceTerminalExitedEvent,
  FlakeMaintenanceTerminalErrorEvent,
  FlakeMaintenanceTerminalClearedEvent,
  FlakeMaintenanceTerminalRestartedEvent,
  FlakeMaintenanceTerminalActivityEvent,
]);
export type FlakeMaintenanceTerminalEvent = typeof FlakeMaintenanceTerminalEvent.Type;

export class FlakeMaintenanceError extends Schema.TaggedErrorClass<FlakeMaintenanceError>()(
  "FlakeMaintenanceError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const NullOrFlakeMaintenanceSummary = Schema.NullOr(FlakeMaintenanceSummary).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
export type NullOrFlakeMaintenanceSummary = typeof NullOrFlakeMaintenanceSummary.Type;
