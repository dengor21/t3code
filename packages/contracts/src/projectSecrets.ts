import { Effect, Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SecretsProviderKind = Schema.Literals(["none", "sops-nix"]);
export type SecretsProviderKind = typeof SecretsProviderKind.Type;

export const SecretValidationCheckCode = Schema.Literals([
  "declaration-eval",
  "encrypted-source-exists",
  "encrypted-source-readable",
]);
export type SecretValidationCheckCode = typeof SecretValidationCheckCode.Type;

export const SecretValidationCheckResult = Schema.Literals(["pass", "fail", "skipped"]);
export type SecretValidationCheckResult = typeof SecretValidationCheckResult.Type;

export const SecretValidationCheck = Schema.Struct({
  code: SecretValidationCheckCode,
  label: TrimmedNonEmptyString,
  result: SecretValidationCheckResult,
  summary: TrimmedNonEmptyString,
  detail: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
});
export type SecretValidationCheck = typeof SecretValidationCheck.Type;

export const HostSecretEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  encryptedSourcePath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  workspaceRelativeEncryptedSourcePath: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
});
export type HostSecretEntry = typeof HostSecretEntry.Type;

export const HostSecretInventory = Schema.Struct({
  hostName: TrimmedNonEmptyString,
  secretCount: NonNegativeInt,
  sourceFileCount: NonNegativeInt,
  secrets: Schema.Array(HostSecretEntry),
  validationChecks: Schema.Array(SecretValidationCheck),
});
export type HostSecretInventory = typeof HostSecretInventory.Type;

export const ProjectSecretsSummary = Schema.Struct({
  provider: SecretsProviderKind,
  detectionSummary: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  hostInventories: Schema.Array(HostSecretInventory),
  updatedAt: IsoDateTime,
});
export type ProjectSecretsSummary = typeof ProjectSecretsSummary.Type;

export const ProjectSecretsGetInput = Schema.Struct({
  projectId: ProjectId,
});
export type ProjectSecretsGetInput = typeof ProjectSecretsGetInput.Type;

export class ProjectSecretsError extends Schema.TaggedErrorClass<ProjectSecretsError>()(
  "ProjectSecretsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
