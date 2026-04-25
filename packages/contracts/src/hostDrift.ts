import { Effect, Schema } from "effect";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ThreadId } from "./baseSchemas.ts";

export const HostDriftStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "completed",
  "failed",
  "canceled",
  "error",
]);
export type HostDriftStatus = typeof HostDriftStatus.Type;

export const HostDriftAuthPhase = Schema.Literals(["ssh-login", "remote-sudo"]);
export type HostDriftAuthPhase = typeof HostDriftAuthPhase.Type;

export const HostDriftCategory = Schema.Literals([
  "identity",
  "system",
  "users",
  "enabledServices",
  "firewallPorts",
]);
export type HostDriftCategory = typeof HostDriftCategory.Type;

export const HostDriftCategoryStatus = Schema.Literals(["match", "drift", "unknown"]);
export type HostDriftCategoryStatus = typeof HostDriftCategoryStatus.Type;

export const HostDriftCategoryResult = Schema.Struct({
  category: HostDriftCategory,
  status: HostDriftCategoryStatus,
  summary: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  desiredValue: Schema.NullOr(Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  observedValue: Schema.NullOr(Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  updatedAt: IsoDateTime,
});
export type HostDriftCategoryResult = typeof HostDriftCategoryResult.Type;

export const HostDriftSummary = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  terminalOwnerId: TrimmedNonEmptyString,
  cwd: TrimmedNonEmptyString,
  status: HostDriftStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  updatedAt: IsoDateTime,
  lastError: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  awaitingAuthPhase: Schema.NullOr(HostDriftAuthPhase).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  exitCode: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  exitSignal: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  categoryResults: Schema.Array(HostDriftCategoryResult),
});
export type HostDriftSummary = typeof HostDriftSummary.Type;

export const HostDriftRefreshInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
});
export type HostDriftRefreshInput = typeof HostDriftRefreshInput.Type;

export const HostDriftRefreshResult = Schema.Struct({
  disposition: Schema.Literals(["started", "already-running"]),
  summary: HostDriftSummary,
});
export type HostDriftRefreshResult = typeof HostDriftRefreshResult.Type;

export const HostDriftGetInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
});
export type HostDriftGetInput = typeof HostDriftGetInput.Type;

export const HostDriftCancelInput = HostDriftGetInput;
export type HostDriftCancelInput = typeof HostDriftCancelInput.Type;

const HostDriftSecretSchema = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(8_192),
);

export const HostDriftSubmitSecretInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  phase: HostDriftAuthPhase,
  secret: HostDriftSecretSchema,
});
export type HostDriftSubmitSecretInput = typeof HostDriftSubmitSecretInput.Type;

export const HostDriftSubmitSecretResult = Schema.Struct({
  accepted: Schema.Boolean,
  status: HostDriftStatus,
});
export type HostDriftSubmitSecretResult = typeof HostDriftSubmitSecretResult.Type;

const HostDriftTerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)).check(
  Schema.isLessThanOrEqualTo(400),
);
const HostDriftTerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);

export const HostDriftTerminalOpenInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  cols: Schema.optional(HostDriftTerminalColsSchema),
  rows: Schema.optional(HostDriftTerminalRowsSchema),
});
export type HostDriftTerminalOpenInput = typeof HostDriftTerminalOpenInput.Type;

export const HostDriftTerminalResizeInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  cols: HostDriftTerminalColsSchema,
  rows: HostDriftTerminalRowsSchema,
});
export type HostDriftTerminalResizeInput = typeof HostDriftTerminalResizeInput.Type;

export const HostDriftTerminalSnapshot = Schema.Struct({
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
export type HostDriftTerminalSnapshot = typeof HostDriftTerminalSnapshot.Type;

const HostDriftTerminalEventBase = Schema.Struct({
  terminalOwnerId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const HostDriftTerminalStartedEvent = Schema.Struct({
  ...HostDriftTerminalEventBase.fields,
  type: Schema.Literal("started"),
  snapshot: HostDriftTerminalSnapshot,
});

const HostDriftTerminalOutputEvent = Schema.Struct({
  ...HostDriftTerminalEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const HostDriftTerminalExitedEvent = Schema.Struct({
  ...HostDriftTerminalEventBase.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const HostDriftTerminalErrorEvent = Schema.Struct({
  ...HostDriftTerminalEventBase.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const HostDriftTerminalClearedEvent = Schema.Struct({
  ...HostDriftTerminalEventBase.fields,
  type: Schema.Literal("cleared"),
});

const HostDriftTerminalRestartedEvent = Schema.Struct({
  ...HostDriftTerminalEventBase.fields,
  type: Schema.Literal("restarted"),
  snapshot: HostDriftTerminalSnapshot,
});

const HostDriftTerminalActivityEvent = Schema.Struct({
  ...HostDriftTerminalEventBase.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
});

export const HostDriftTerminalEvent = Schema.Union([
  HostDriftTerminalStartedEvent,
  HostDriftTerminalOutputEvent,
  HostDriftTerminalExitedEvent,
  HostDriftTerminalErrorEvent,
  HostDriftTerminalClearedEvent,
  HostDriftTerminalRestartedEvent,
  HostDriftTerminalActivityEvent,
]);
export type HostDriftTerminalEvent = typeof HostDriftTerminalEvent.Type;

export const HostDriftReconcileIntent = Schema.Literals([
  "reconcile-flake-to-host",
  "reconcile-host-to-flake",
]);
export type HostDriftReconcileIntent = typeof HostDriftReconcileIntent.Type;

export const HostDriftReconcileInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  intent: HostDriftReconcileIntent,
});
export type HostDriftReconcileInput = typeof HostDriftReconcileInput.Type;

export const HostDriftReconcileResult = Schema.Struct({
  threadId: ThreadId,
});
export type HostDriftReconcileResult = typeof HostDriftReconcileResult.Type;

export class HostDriftError extends Schema.TaggedErrorClass<HostDriftError>()("HostDriftError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export const NullOrHostDriftSummary = Schema.NullOr(HostDriftSummary).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
export type NullOrHostDriftSummary = typeof NullOrHostDriftSummary.Type;
