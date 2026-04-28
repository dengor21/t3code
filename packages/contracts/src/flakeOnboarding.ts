import { Schema } from "effect";

import { IsoDateTime, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const FLAKE_ONBOARDING_MODULE_NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const FlakeOnboardingModuleNamespace = TrimmedNonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(FLAKE_ONBOARDING_MODULE_NAMESPACE_PATTERN),
);
export type FlakeOnboardingModuleNamespace = typeof FlakeOnboardingModuleNamespace.Type;

export const FlakeOnboardingHostScale = Schema.Literals(["1", "2-5", "6+"]);
export type FlakeOnboardingHostScale = typeof FlakeOnboardingHostScale.Type;

export const FlakeOnboardingPlatformMatrix = Schema.Literals(["nixos", "darwin", "mixed"]);
export type FlakeOnboardingPlatformMatrix = typeof FlakeOnboardingPlatformMatrix.Type;

export const FlakeOnboardingModuleStyle = Schema.Literals(["explicit-modules", "inline-first"]);
export type FlakeOnboardingModuleStyle = typeof FlakeOnboardingModuleStyle.Type;

export const FlakeOnboardingLayoutPattern = Schema.Literals([
  "single-host-minimal",
  "shared-modules",
  "fleet-layered",
]);
export type FlakeOnboardingLayoutPattern = typeof FlakeOnboardingLayoutPattern.Type;

export const FlakeOnboardingQuestionnaire = Schema.Struct({
  hostScale: FlakeOnboardingHostScale,
  platformMatrix: FlakeOnboardingPlatformMatrix,
  homeManager: Schema.Boolean,
  moduleStyle: FlakeOnboardingModuleStyle,
  moduleNamespace: Schema.optional(Schema.NullOr(FlakeOnboardingModuleNamespace)),
});
export type FlakeOnboardingQuestionnaire = typeof FlakeOnboardingQuestionnaire.Type;

export const FlakeRepoStylePaths = Schema.Struct({
  flake: TrimmedNonEmptyString,
  repoStyle: TrimmedNonEmptyString,
  hosts: TrimmedNonEmptyString,
  modules: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  profiles: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  homes: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type FlakeRepoStylePaths = typeof FlakeRepoStylePaths.Type;

export const FlakeRepoStyleConventions = Schema.Struct({
  flakeFile: TrimmedNonEmptyString,
  halHostsAttribute: TrimmedNonEmptyString,
  deployNodesAttribute: TrimmedNonEmptyString,
  hostsDir: TrimmedNonEmptyString,
  modulesDir: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  profilesDir: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  homesDir: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type FlakeRepoStyleConventions = typeof FlakeRepoStyleConventions.Type;

export const FlakeRepoStyleFieldReference = Schema.Struct({
  name: TrimmedNonEmptyString,
  required: Schema.Boolean,
  description: TrimmedNonEmptyString,
});
export type FlakeRepoStyleFieldReference = typeof FlakeRepoStyleFieldReference.Type;

export const FlakeRepoStyleHalHostsContract = Schema.Struct({
  attributePath: TrimmedNonEmptyString,
  kind: Schema.Literal("attrset"),
  bootstrapEmptyLiteral: TrimmedNonEmptyString,
  entryKeyDescription: TrimmedNonEmptyString,
  recognizedFields: Schema.Array(FlakeRepoStyleFieldReference),
  recognitionRules: Schema.Array(TrimmedNonEmptyString),
  example: TrimmedNonEmptyString,
});
export type FlakeRepoStyleHalHostsContract = typeof FlakeRepoStyleHalHostsContract.Type;

export const FlakeRepoStyleDeployNodesContract = Schema.Struct({
  attributePath: TrimmedNonEmptyString,
  kind: Schema.Literal("attrset"),
  bootstrapEmptyLiteral: TrimmedNonEmptyString,
  notes: Schema.Array(TrimmedNonEmptyString),
});
export type FlakeRepoStyleDeployNodesContract = typeof FlakeRepoStyleDeployNodesContract.Type;

export const FlakeRepoStyleBootstrapContracts = Schema.Struct({
  halHosts: FlakeRepoStyleHalHostsContract,
  deployNodes: FlakeRepoStyleDeployNodesContract,
});
export type FlakeRepoStyleBootstrapContracts = typeof FlakeRepoStyleBootstrapContracts.Type;

export const FlakeRepoStyle = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  generatedAt: IsoDateTime,
  projectTitle: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  questionnaire: FlakeOnboardingQuestionnaire,
  layoutPattern: FlakeOnboardingLayoutPattern,
  paths: FlakeRepoStylePaths,
  createdSkeletonPaths: Schema.Array(TrimmedNonEmptyString),
  conventions: FlakeRepoStyleConventions,
  bootstrapContracts: FlakeRepoStyleBootstrapContracts,
  guidance: Schema.Array(TrimmedNonEmptyString),
});
export type FlakeRepoStyle = typeof FlakeRepoStyle.Type;

export const ProjectBootstrapFlakeInput = Schema.Struct({
  projectId: ProjectId,
  hostScale: FlakeOnboardingHostScale,
  platformMatrix: FlakeOnboardingPlatformMatrix,
  homeManager: Schema.Boolean,
  moduleStyle: FlakeOnboardingModuleStyle,
  moduleNamespace: Schema.optional(Schema.NullOr(FlakeOnboardingModuleNamespace)),
});
export type ProjectBootstrapFlakeInput = typeof ProjectBootstrapFlakeInput.Type;

export const ProjectBootstrapFlakeResult = Schema.Struct({
  projectId: ProjectId,
  layoutPattern: FlakeOnboardingLayoutPattern,
  flakePath: TrimmedNonEmptyString,
  repoStylePath: TrimmedNonEmptyString,
  createdSkeletonPaths: Schema.Array(TrimmedNonEmptyString),
});
export type ProjectBootstrapFlakeResult = typeof ProjectBootstrapFlakeResult.Type;

export class ProjectBootstrapFlakeError extends Schema.TaggedErrorClass<ProjectBootstrapFlakeError>()(
  "ProjectBootstrapFlakeError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
