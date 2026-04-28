import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ApprovalRequestId,
  EventId,
  IsoDateTime,
  ProviderItemId,
  ThreadId,
  TurnId,
} from "./baseSchemas.ts";
import {
  HostCreationWorkflowBootstrapMode,
  ChatAttachment,
  HostCreationWorkflowOsFamily,
  HostWorkflowStatus,
  ModelSelection,
  RemoteHostAccessPolicy,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ProviderApprovalDecision,
  ProviderApprovalPolicy,
  ProviderInteractionMode,
  ProviderKind,
  ProviderRequestKind,
  ProviderSandboxMode,
  ProviderUserInputAnswers,
  RuntimeMode,
} from "./orchestration.ts";
import {
  FlakeOnboardingHostScale,
  FlakeOnboardingLayoutPattern,
  FlakeOnboardingModuleNamespace,
  FlakeOnboardingModuleStyle,
  FlakeOnboardingPlatformMatrix,
} from "./flakeOnboarding.ts";
import { NixDesignerScope } from "./nixDesigner.ts";

export const McpServerDescriptor = Schema.Struct({
  id: TrimmedNonEmptyString,
  transport: Schema.Literal("stdio"),
  command: TrimmedNonEmptyString,
  args: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type McpServerDescriptor = typeof McpServerDescriptor.Type;

const ProviderSessionStatus = Schema.Literals([
  "connecting",
  "ready",
  "running",
  "error",
  "closed",
]);

export const ProviderProjectKind = Schema.Literals(["generic", "nix-flake"]);
export type ProviderProjectKind = typeof ProviderProjectKind.Type;

export const ProviderFlakeDocumentationPaths = Schema.Struct({
  generalChanges: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  hostDoc: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  repoStyle: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type ProviderFlakeDocumentationPaths = typeof ProviderFlakeDocumentationPaths.Type;

export const ProviderFlakeContext = Schema.Struct({
  flakePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  hostNames: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  hostFlakeAttr: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  documentationPaths: Schema.optional(ProviderFlakeDocumentationPaths),
});
export type ProviderFlakeContext = typeof ProviderFlakeContext.Type;

export const ProviderWorkflowContext = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("host-creation"),
    hostName: TrimmedNonEmptyString,
    target: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    osFamily: Schema.optional(HostCreationWorkflowOsFamily),
    bootstrapMode: Schema.optional(HostCreationWorkflowBootstrapMode),
    sourceSshTarget: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    hostType: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    status: Schema.optional(HostWorkflowStatus),
  }),
  Schema.Struct({
    kind: Schema.Literal("host-removal"),
    hostName: TrimmedNonEmptyString,
    target: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    hostType: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
    status: Schema.optional(HostWorkflowStatus),
  }),
  Schema.Struct({
    kind: Schema.Literal("flake-creation"),
    hostScale: FlakeOnboardingHostScale,
    platformMatrix: FlakeOnboardingPlatformMatrix,
    homeManager: Schema.Boolean,
    moduleStyle: FlakeOnboardingModuleStyle,
    moduleNamespace: Schema.optional(Schema.NullOr(FlakeOnboardingModuleNamespace)),
    layoutPattern: FlakeOnboardingLayoutPattern,
    status: Schema.optional(HostWorkflowStatus),
  }),
]);
export type ProviderWorkflowContext = typeof ProviderWorkflowContext.Type;

export const ProviderTurnContext = Schema.Struct({
  projectKind: Schema.optional(ProviderProjectKind),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  remoteHostAccessPolicy: Schema.optional(RemoteHostAccessPolicy),
  scopedHostName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  flake: Schema.optional(ProviderFlakeContext),
  workflow: Schema.optional(ProviderWorkflowContext),
});
export type ProviderTurnContext = typeof ProviderTurnContext.Type;

export const ProviderScopeReceipt = Schema.Struct({
  kind: Schema.Literals(["project", "host"]),
  projectId: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  hostName: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  locked: Schema.Boolean,
  designer: Schema.optional(Schema.NullOr(NixDesignerScope)),
  mcpScope: Schema.optional(Schema.NullOr(NixDesignerScope)),
  hostDocPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  createdAt: IsoDateTime,
});
export type ProviderScopeReceipt = typeof ProviderScopeReceipt.Type;

export const ProviderSession = Schema.Struct({
  provider: ProviderKind,
  status: ProviderSessionStatus,
  runtimeMode: RuntimeMode,
  cwd: Schema.optional(TrimmedNonEmptyString),
  model: Schema.optional(TrimmedNonEmptyString),
  threadId: ThreadId,
  resumeCursor: Schema.optional(Schema.Unknown),
  activeTurnId: Schema.optional(TurnId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastError: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderSession = typeof ProviderSession.Type;

export const ProviderSessionStartInput = Schema.Struct({
  threadId: ThreadId,
  provider: Schema.optional(ProviderKind),
  cwd: Schema.optional(TrimmedNonEmptyString),
  modelSelection: Schema.optional(ModelSelection),
  mcpServers: Schema.optional(Schema.Array(McpServerDescriptor)),
  resumeCursor: Schema.optional(Schema.Unknown),
  approvalPolicy: Schema.optional(ProviderApprovalPolicy),
  sandboxMode: Schema.optional(ProviderSandboxMode),
  runtimeMode: RuntimeMode,
});
export type ProviderSessionStartInput = typeof ProviderSessionStartInput.Type;

export const ProviderSendTurnInput = Schema.Struct({
  threadId: ThreadId,
  input: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_INPUT_CHARS)),
  ),
  attachments: Schema.optional(
    Schema.Array(ChatAttachment).check(Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS)),
  ),
  modelSelection: Schema.optional(ModelSelection),
  interactionMode: Schema.optional(ProviderInteractionMode),
  providerContext: Schema.optional(ProviderTurnContext),
});
export type ProviderSendTurnInput = typeof ProviderSendTurnInput.Type;

export const ProviderTurnStartResult = Schema.Struct({
  threadId: ThreadId,
  turnId: TurnId,
  resumeCursor: Schema.optional(Schema.Unknown),
});
export type ProviderTurnStartResult = typeof ProviderTurnStartResult.Type;

export const ProviderInterruptTurnInput = Schema.Struct({
  threadId: ThreadId,
  turnId: Schema.optional(TurnId),
});
export type ProviderInterruptTurnInput = typeof ProviderInterruptTurnInput.Type;

export const ProviderStopSessionInput = Schema.Struct({
  threadId: ThreadId,
});
export type ProviderStopSessionInput = typeof ProviderStopSessionInput.Type;

export const ProviderRespondToRequestInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  decision: ProviderApprovalDecision,
});
export type ProviderRespondToRequestInput = typeof ProviderRespondToRequestInput.Type;

export const ProviderRespondToUserInputInput = Schema.Struct({
  threadId: ThreadId,
  requestId: ApprovalRequestId,
  answers: ProviderUserInputAnswers,
});
export type ProviderRespondToUserInputInput = typeof ProviderRespondToUserInputInput.Type;

const ProviderEventKind = Schema.Literals(["session", "notification", "request", "error"]);

export const ProviderEvent = Schema.Struct({
  id: EventId,
  kind: ProviderEventKind,
  provider: ProviderKind,
  threadId: ThreadId,
  createdAt: IsoDateTime,
  method: TrimmedNonEmptyString,
  message: Schema.optional(TrimmedNonEmptyString),
  turnId: Schema.optional(TurnId),
  itemId: Schema.optional(ProviderItemId),
  requestId: Schema.optional(ApprovalRequestId),
  requestKind: Schema.optional(ProviderRequestKind),
  textDelta: Schema.optional(Schema.String),
  payload: Schema.optional(Schema.Unknown),
});
export type ProviderEvent = typeof ProviderEvent.Type;
