import { Effect, Schema } from "effect";

import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const DeploymentCheckCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DeploymentActivationStrategy = Schema.Literals(["switch", "boot"]);
export type DeploymentActivationStrategy = typeof DeploymentActivationStrategy.Type;

export const DeploymentCheckSeverity = Schema.Literals(["info", "warning", "blocking"]);
export type DeploymentCheckSeverity = typeof DeploymentCheckSeverity.Type;

export const DeploymentCheckResult = Schema.Literals(["pass", "warn", "fail", "skipped"]);
export type DeploymentCheckResult = typeof DeploymentCheckResult.Type;

export const DeploymentCheckCode = Schema.Literals([
  "flake-exists",
  "host-exists",
  "deploy-rs-target",
  "git-status",
  "ssh-reachability",
  "switch-activation-preview",
  "secret-declarations",
  "secret-source-files",
  "secret-source-readability",
  "postflight-ssh-reachability",
  "reboot-pending",
]);
export type DeploymentCheckCode = typeof DeploymentCheckCode.Type;

export const DeploymentCheckRecommendedAction = Schema.NullOr(
  Schema.Literals(["acknowledge-warnings", "use-boot-activation"]),
).pipe(Schema.withDecodingDefault(Effect.succeed(null)));
export type DeploymentCheckRecommendedAction = typeof DeploymentCheckRecommendedAction.Type;

export const DeploymentCheck = Schema.Struct({
  code: DeploymentCheckCode,
  label: TrimmedNonEmptyString,
  severity: DeploymentCheckSeverity,
  result: DeploymentCheckResult,
  summary: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  recommendedAction: DeploymentCheckRecommendedAction,
});
export type DeploymentCheck = typeof DeploymentCheck.Type;

export const DeploymentPreflightReport = Schema.Struct({
  activationStrategy: DeploymentActivationStrategy,
  acknowledgedWarnings: Schema.Boolean,
  canProceed: Schema.Boolean,
  blockingFailureCount: DeploymentCheckCount,
  warningCount: DeploymentCheckCount,
  checks: Schema.Array(DeploymentCheck),
  updatedAt: IsoDateTime,
});
export type DeploymentPreflightReport = typeof DeploymentPreflightReport.Type;

export const DeploymentPostflightReport = Schema.Struct({
  activationStrategy: DeploymentActivationStrategy,
  checks: Schema.Array(DeploymentCheck),
  updatedAt: IsoDateTime,
});
export type DeploymentPostflightReport = typeof DeploymentPostflightReport.Type;

export const HostDeploymentPreviewInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
  deployOnServer: Schema.optional(Schema.Boolean),
  magicRollback: Schema.optional(Schema.Boolean),
  confirmTimeoutSeconds: Schema.optional(PositiveInt),
  activationStrategy: Schema.optional(DeploymentActivationStrategy),
  acknowledgeWarnings: Schema.optional(Schema.Boolean),
});
export type HostDeploymentPreviewInput = typeof HostDeploymentPreviewInput.Type;

export const HostDeploymentPreviewResult = Schema.Struct({
  report: DeploymentPreflightReport,
});
export type HostDeploymentPreviewResult = typeof HostDeploymentPreviewResult.Type;

export class DeploymentSafetyError extends Schema.TaggedErrorClass<DeploymentSafetyError>()(
  "DeploymentSafetyError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
