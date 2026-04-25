import { Effect, Schema } from "effect";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const NixChannel = TrimmedNonEmptyString;
export type NixChannel = typeof NixChannel.Type;

export const NixOptionDoc = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.String,
  type: Schema.optional(Schema.NullOr(Schema.String)),
  default: Schema.optional(Schema.NullOr(Schema.String)),
  example: Schema.optional(Schema.NullOr(Schema.String)),
  declarations: Schema.optional(Schema.Array(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  sourcePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type NixOptionDoc = typeof NixOptionDoc.Type;

export const NixPackageDoc = Schema.Struct({
  attr: TrimmedNonEmptyString,
  pname: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  version: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  license: Schema.optional(Schema.Array(TrimmedNonEmptyString)).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type NixPackageDoc = typeof NixPackageDoc.Type;

export const NixIndexStatus = Schema.Literals(["missing", "building", "ready", "stale", "error"]);
export type NixIndexStatus = typeof NixIndexStatus.Type;

export const NixDiagnosticSeverity = Schema.Literals(["error", "warning", "info"]);
export type NixDiagnosticSeverity = typeof NixDiagnosticSeverity.Type;

export const NixDiagnostic = Schema.Struct({
  severity: NixDiagnosticSeverity,
  message: TrimmedNonEmptyString,
  filePath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  line: Schema.optional(Schema.NullOr(NonNegativeInt)),
  column: Schema.optional(Schema.NullOr(NonNegativeInt)),
  code: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type NixDiagnostic = typeof NixDiagnostic.Type;

export const NixValidationResult = Schema.Struct({
  command: TrimmedNonEmptyString,
  success: Schema.Boolean,
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  stdout: Schema.optional(Schema.String),
  stderr: Schema.optional(Schema.String),
  diagnostics: Schema.Array(NixDiagnostic).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type NixValidationResult = typeof NixValidationResult.Type;

export const NixDesignerScope = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project"),
  }),
  Schema.Struct({
    kind: Schema.Literal("host"),
    hostName: TrimmedNonEmptyString,
  }),
]);
export type NixDesignerScope = typeof NixDesignerScope.Type;
