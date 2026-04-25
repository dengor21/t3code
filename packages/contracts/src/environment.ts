import { Effect, Schema } from "effect";

import { EnvironmentId, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
});
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const EnvironmentConnectionState = Schema.Literals([
  "connecting",
  "connected",
  "disconnected",
  "error",
]);
export type EnvironmentConnectionState = typeof EnvironmentConnectionState.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(TrimmedNonEmptyString),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export const FlakeHost = Schema.Struct({
  name: TrimmedNonEmptyString,
  target: TrimmedNonEmptyString,
  sshUser: Schema.optionalKey(TrimmedNonEmptyString),
  activationUser: Schema.optionalKey(TrimmedNonEmptyString),
  system: Schema.optionalKey(TrimmedNonEmptyString),
  type: Schema.optionalKey(TrimmedNonEmptyString),
});
export type FlakeHost = typeof FlakeHost.Type;

export const FlakeMetadataSource = Schema.Literals([
  "nix-eval",
  "parsed-flake",
  "missing",
  "error",
]);
export type FlakeMetadataSource = typeof FlakeMetadataSource.Type;

export const FlakeMetadata = Schema.Struct({
  host: Schema.NullOr(FlakeHost),
  hosts: Schema.Array(FlakeHost),
  source: FlakeMetadataSource,
  flakePath: TrimmedNonEmptyString,
  diagnostics: Schema.Array(TrimmedNonEmptyString),
});
export type FlakeMetadata = typeof FlakeMetadata.Type;

export const HostDocumentationStatus = Schema.Literals([
  "missing",
  "generating",
  "current",
  "stale",
  "needs-review",
]);
export type HostDocumentationStatus = typeof HostDocumentationStatus.Type;

export const HostDocumentationState = Schema.Struct({
  hostName: TrimmedNonEmptyString,
  docPath: TrimmedNonEmptyString,
  status: HostDocumentationStatus,
  generatedAt: Schema.NullOr(TrimmedNonEmptyString),
  coversChangesThrough: Schema.NullOr(TrimmedNonEmptyString),
  latestRelevantChangeAt: Schema.NullOr(TrimmedNonEmptyString),
});
export type HostDocumentationState = typeof HostDocumentationState.Type;

export const ProjectDocumentationState = Schema.Struct({
  docsRoot: TrimmedNonEmptyString,
  legacyDocsDetected: Schema.Boolean,
  hosts: Schema.Array(HostDocumentationState),
});
export type ProjectDocumentationState = typeof ProjectDocumentationState.Type;

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;

export const ScopedThreadSessionRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadSessionRef = typeof ScopedThreadSessionRef.Type;
