import { Effect, Schema } from "effect";
import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HostImportStatus = Schema.Literals([
  "idle",
  "starting",
  "running",
  "awaiting-ssh-password",
  "awaiting-sudo-password",
  "completed",
  "failed",
  "canceled",
]);
export type HostImportStatus = typeof HostImportStatus.Type;

export const HostImportAuthPhase = Schema.Literals(["ssh-login", "remote-sudo"]);
export type HostImportAuthPhase = typeof HostImportAuthPhase.Type;

export const HostImportSummary = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  hostName: TrimmedNonEmptyString,
  sshTarget: TrimmedNonEmptyString,
  status: HostImportStatus,
  startedAt: IsoDateTime,
  finishedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  lastError: Schema.NullOr(TrimmedNonEmptyString),
  findingsSummary: Schema.NullOr(Schema.String),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});
export type HostImportSummary = typeof HostImportSummary.Type;

export const HostImportStartInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type HostImportStartInput = typeof HostImportStartInput.Type;

export const HostImportStartResult = Schema.Struct({
  disposition: Schema.Literals(["started", "already-running"]),
  summary: HostImportSummary,
});
export type HostImportStartResult = typeof HostImportStartResult.Type;

export const HostImportGetInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type HostImportGetInput = typeof HostImportGetInput.Type;

export const HostImportCancelInput = HostImportGetInput;
export type HostImportCancelInput = typeof HostImportCancelInput.Type;

const HostImportSecretSchema = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(4_096),
);

export const HostImportSubmitSecretInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  phase: HostImportAuthPhase,
  secret: HostImportSecretSchema,
});
export type HostImportSubmitSecretInput = typeof HostImportSubmitSecretInput.Type;

export const HostImportSubmitSecretResult = Schema.Struct({
  accepted: Schema.Boolean,
  status: HostImportStatus,
});
export type HostImportSubmitSecretResult = typeof HostImportSubmitSecretResult.Type;

const HostImportTerminalColsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(20)).check(
  Schema.isLessThanOrEqualTo(400),
);
const HostImportTerminalRowsSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(5)).check(
  Schema.isLessThanOrEqualTo(200),
);

export const HostImportTerminalOpenInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  cols: Schema.optional(HostImportTerminalColsSchema),
  rows: Schema.optional(HostImportTerminalRowsSchema),
});
export type HostImportTerminalOpenInput = typeof HostImportTerminalOpenInput.Type;

export const HostImportTerminalResizeInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  cols: HostImportTerminalColsSchema,
  rows: HostImportTerminalRowsSchema,
});
export type HostImportTerminalResizeInput = typeof HostImportTerminalResizeInput.Type;

export const HostImportTerminalSnapshot = Schema.Struct({
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
export type HostImportTerminalSnapshot = typeof HostImportTerminalSnapshot.Type;

const HostImportTerminalEventBase = Schema.Struct({
  terminalOwnerId: TrimmedNonEmptyString,
  terminalId: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});

const HostImportTerminalStartedEvent = Schema.Struct({
  ...HostImportTerminalEventBase.fields,
  type: Schema.Literal("started"),
  snapshot: HostImportTerminalSnapshot,
});

const HostImportTerminalOutputEvent = Schema.Struct({
  ...HostImportTerminalEventBase.fields,
  type: Schema.Literal("output"),
  data: Schema.String,
});

const HostImportTerminalExitedEvent = Schema.Struct({
  ...HostImportTerminalEventBase.fields,
  type: Schema.Literal("exited"),
  exitCode: Schema.NullOr(Schema.Int),
  exitSignal: Schema.NullOr(Schema.Int),
});

const HostImportTerminalErrorEvent = Schema.Struct({
  ...HostImportTerminalEventBase.fields,
  type: Schema.Literal("error"),
  message: Schema.String.check(Schema.isNonEmpty()),
});

const HostImportTerminalClearedEvent = Schema.Struct({
  ...HostImportTerminalEventBase.fields,
  type: Schema.Literal("cleared"),
});

const HostImportTerminalRestartedEvent = Schema.Struct({
  ...HostImportTerminalEventBase.fields,
  type: Schema.Literal("restarted"),
  snapshot: HostImportTerminalSnapshot,
});

const HostImportTerminalActivityEvent = Schema.Struct({
  ...HostImportTerminalEventBase.fields,
  type: Schema.Literal("activity"),
  hasRunningSubprocess: Schema.Boolean,
});

export const HostImportTerminalEvent = Schema.Union([
  HostImportTerminalStartedEvent,
  HostImportTerminalOutputEvent,
  HostImportTerminalExitedEvent,
  HostImportTerminalErrorEvent,
  HostImportTerminalClearedEvent,
  HostImportTerminalRestartedEvent,
  HostImportTerminalActivityEvent,
]);
export type HostImportTerminalEvent = typeof HostImportTerminalEvent.Type;

export class HostImportError extends Schema.TaggedErrorClass<HostImportError>()("HostImportError", {
  message: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect),
}) {}

export const NullOrHostImportSummary = Schema.NullOr(HostImportSummary).pipe(
  Schema.withDecodingDefault(Effect.succeed(null)),
);
export type NullOrHostImportSummary = typeof NullOrHostImportSummary.Type;
