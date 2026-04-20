import { Schema } from "effect";
import { IsoDateTime, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { FlakeHost, HostDocumentationState, HostDocumentationStatus } from "./environment.ts";
import { FlakeMaintenanceSummary } from "./flakeMaintenance.ts";
import { HostDeploymentSummary } from "./hostDeployment.ts";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export class ProjectSearchEntriesError extends Schema.TaggedErrorClass<ProjectSearchEntriesError>()(
  "ProjectSearchEntriesError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;

export class ProjectWriteFileError extends Schema.TaggedErrorClass<ProjectWriteFileError>()(
  "ProjectWriteFileError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export const ProjectGenerateHostDocumentationInput = Schema.Struct({
  projectId: ProjectId,
  hostName: TrimmedNonEmptyString,
});
export type ProjectGenerateHostDocumentationInput =
  typeof ProjectGenerateHostDocumentationInput.Type;

export const ProjectGenerateHostDocumentationResult = Schema.Struct({
  docPath: TrimmedNonEmptyString,
  generatedAt: TrimmedNonEmptyString,
});
export type ProjectGenerateHostDocumentationResult =
  typeof ProjectGenerateHostDocumentationResult.Type;

export class ProjectGenerateHostDocumentationError extends Schema.TaggedErrorClass<ProjectGenerateHostDocumentationError>()(
  "ProjectGenerateHostDocumentationError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}

const ProjectDashboardChangeKind = Schema.Literals(["change", "bootstrap"]);

export const ProjectDashboardChangeEntry = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ProjectDashboardChangeKind,
  completedAt: IsoDateTime,
  title: TrimmedNonEmptyString,
  markdown: Schema.String,
  hosts: Schema.Array(TrimmedNonEmptyString),
  ambiguous: Schema.Boolean,
  files: Schema.Array(TrimmedNonEmptyString),
});
export type ProjectDashboardChangeEntry = typeof ProjectDashboardChangeEntry.Type;

const ProjectDashboardHostDeploymentStatus = Schema.Literals(["deployable", "unavailable"]);
const ProjectDashboardHostDeploymentReason = Schema.NullOr(
  Schema.Literals(["missing-deploy-target", "evaluation-failed"]),
);

export function buildDeployRsCommand(
  hostName: string,
  options?: {
    deployOnServer?: boolean | null | undefined;
  },
): string {
  const target = hostName.trim();
  return options?.deployOnServer
    ? `nix run github:serokell/deploy-rs -- .#${target}`
    : `nix run github:serokell/deploy-rs -- --skip-checks --remote-build .#${target}`;
}

export const ProjectDashboardHostDeployment = Schema.Struct({
  status: ProjectDashboardHostDeploymentStatus,
  reason: ProjectDashboardHostDeploymentReason,
  command: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProjectDashboardHostDeployment = typeof ProjectDashboardHostDeployment.Type;

export const ProjectDashboardHostSummary = Schema.Struct({
  host: FlakeHost,
  documentation: HostDocumentationState,
  deployment: ProjectDashboardHostDeployment,
  latestDeployment: Schema.NullOr(HostDeploymentSummary),
});
export type ProjectDashboardHostSummary = typeof ProjectDashboardHostSummary.Type;

export const ProjectDashboardFlakeSource = Schema.Struct({
  path: TrimmedNonEmptyString,
  language: Schema.Literal("nix"),
  contents: Schema.String,
});
export type ProjectDashboardFlakeSource = typeof ProjectDashboardFlakeSource.Type;

export const ProjectDashboardHostDoc = Schema.Struct({
  path: TrimmedNonEmptyString,
  markdown: Schema.String,
  generatedAt: Schema.NullOr(TrimmedNonEmptyString),
  status: HostDocumentationStatus,
});
export type ProjectDashboardHostDoc = typeof ProjectDashboardHostDoc.Type;

export const ProjectGetDashboardContentInput = Schema.Struct({
  projectId: ProjectId,
  hostName: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectGetDashboardContentInput = typeof ProjectGetDashboardContentInput.Type;

export const ProjectDashboardContentResult = Schema.Struct({
  mode: Schema.Literals(["flake", "host"]),
  selectedHostName: Schema.NullOr(TrimmedNonEmptyString),
  flakeSource: ProjectDashboardFlakeSource,
  generalChanges: Schema.Array(ProjectDashboardChangeEntry),
  hostChanges: Schema.Array(ProjectDashboardChangeEntry),
  hostDoc: Schema.NullOr(ProjectDashboardHostDoc),
  hostSummaries: Schema.Array(ProjectDashboardHostSummary),
  latestMaintenance: Schema.NullOr(FlakeMaintenanceSummary),
});
export type ProjectDashboardContentResult = typeof ProjectDashboardContentResult.Type;

export class ProjectGetDashboardContentError extends Schema.TaggedErrorClass<ProjectGetDashboardContentError>()(
  "ProjectGetDashboardContentError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect),
  },
) {}
