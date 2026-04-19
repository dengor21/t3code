import { readFile } from "node:fs/promises";

import type {
  FlakeHost,
  HostDocumentationState,
  ProjectDashboardChangeEntry,
  ProjectDashboardContentResult,
} from "@t3tools/contracts";
import { ProjectGetDashboardContentError } from "@t3tools/contracts";
import { Effect, Layer, Option, Schema } from "effect";

import { DocumentationStatusResolver } from "../../orchestration/Services/DocumentationStatusResolver.ts";
import {
  GENERAL_CHANGELOG_PATH,
  HOST_DOCS_DIR,
  parseChangeLogEntries,
  resolveProjectHosts,
  slugHostName,
} from "../../orchestration/DocumentationUtils.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import {
  ProjectDashboardContentResolver,
  type ProjectDashboardContentResolverShape,
} from "../Services/ProjectDashboardContentResolver.ts";
import { DeployRsResolver } from "../Services/DeployRsResolver.ts";
import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";

const MAX_DASHBOARD_CHANGE_ENTRIES = 3;
const FLAKE_SOURCE_RELATIVE_PATH = "flake.nix";

function toDashboardError(message: string, cause?: unknown): ProjectGetDashboardContentError {
  return new ProjectGetDashboardContentError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function normalizeHostName(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function sortEntriesDescending(
  entries: ReadonlyArray<ProjectDashboardChangeEntry>,
): ReadonlyArray<ProjectDashboardChangeEntry> {
  return [...entries].sort((left, right) => right.completedAt.localeCompare(left.completedAt));
}

function defaultDocumentationState(host: FlakeHost): HostDocumentationState {
  return {
    hostName: host.name,
    docPath: `${HOST_DOCS_DIR}/${slugHostName(host.name)}.md`,
    status: "missing",
    generatedAt: null,
    coversChangesThrough: null,
    latestRelevantChangeAt: null,
  };
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const flakeMetadataResolver = yield* FlakeMetadataResolver;
  const deployRsResolver = yield* DeployRsResolver;
  const documentationStatusResolver = yield* DocumentationStatusResolver;
  const workspacePaths = yield* WorkspacePaths;

  const resolveWithinWorkspace = (workspaceRoot: string, relativePath: string) =>
    workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot,
        relativePath,
      })
      .pipe(
        Effect.mapError((cause) =>
          toDashboardError(`Invalid flake dashboard path: ${relativePath}`, cause),
        ),
      );

  const readWorkspaceRelativeFile = (input: {
    workspaceRoot: string;
    relativePath: string;
    required: boolean;
  }) =>
    Effect.gen(function* () {
      const resolved = yield* resolveWithinWorkspace(input.workspaceRoot, input.relativePath);
      const contents = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(resolved.absolutePath, "utf8");
          } catch (cause) {
            if (
              !input.required &&
              cause &&
              typeof cause === "object" &&
              "code" in cause &&
              cause.code === "ENOENT"
            ) {
              return null;
            }
            throw cause;
          }
        },
        catch: (cause) => toDashboardError(`Failed to read ${input.relativePath}.`, cause),
      });
      if (contents === null) {
        return null;
      }
      return {
        path: resolved.relativePath,
        contents,
      };
    });

  const resolveDashboardContent: ProjectDashboardContentResolverShape["resolveDashboardContent"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
        Effect.mapError((cause) => toDashboardError("Failed to load the selected flake.", cause)),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () => Effect.fail(toDashboardError(`Flake ${input.projectId} was not found.`)),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
      );

      const flakeMetadata =
        project.flakeMetadata ??
        (yield* flakeMetadataResolver
          .resolve(project.workspaceRoot)
          .pipe(
            Effect.mapError((cause) =>
              toDashboardError("Failed to resolve flake metadata.", cause),
            ),
          ));
      const documentationState =
        project.documentationState ??
        (yield* documentationStatusResolver
          .resolve({
            workspaceRoot: project.workspaceRoot,
            flakeMetadata,
          })
          .pipe(
            Effect.mapError((cause) =>
              toDashboardError("Failed to resolve documentation status.", cause),
            ),
          ));
      const hosts = resolveProjectHosts(flakeMetadata);
      const deploymentByHost = yield* deployRsResolver
        .resolveHostDeployments({
          workspaceRoot: project.workspaceRoot,
          hosts,
        })
        .pipe(
          Effect.mapError((cause) =>
            toDashboardError("Failed to resolve deploy-rs host targets.", cause),
          ),
        );
      const documentationByHost = new Map(
        documentationState.hosts.map((entry) => [entry.hostName.toLowerCase(), entry] as const),
      );
      const requestedHostName = normalizeHostName(input.hostName);
      const selectedHost =
        requestedHostName === null
          ? null
          : (hosts.find((host) => normalizeHostName(host.name) === requestedHostName) ?? null);

      if (requestedHostName !== null && selectedHost === null) {
        return yield* toDashboardError(
          `Host ${input.hostName?.trim() ?? "unknown"} was not found in the selected flake.`,
        );
      }

      const flakeSource = yield* readWorkspaceRelativeFile({
        workspaceRoot: project.workspaceRoot,
        relativePath: FLAKE_SOURCE_RELATIVE_PATH,
        required: true,
      }).pipe(
        Effect.flatMap((result) =>
          result === null
            ? Effect.fail(toDashboardError("flake.nix is missing for the selected flake."))
            : Effect.succeed(result),
        ),
      );

      const changesFile = yield* readWorkspaceRelativeFile({
        workspaceRoot: project.workspaceRoot,
        relativePath: GENERAL_CHANGELOG_PATH,
        required: false,
      });
      const parsedEntries = sortEntriesDescending(
        parseChangeLogEntries({
          markdown: changesFile?.contents ?? "",
          hosts,
        }).map((entry) => ({
          id: entry.id,
          kind: entry.kind,
          completedAt: entry.completedAt,
          title: entry.title,
          markdown: entry.markdown,
          hosts: [...entry.hosts],
          ambiguous: entry.ambiguous,
          files: [...entry.files],
        })),
      );

      const generalChanges = parsedEntries.slice(0, MAX_DASHBOARD_CHANGE_ENTRIES);
      const hostChanges =
        selectedHost === null
          ? []
          : parsedEntries
              .filter(
                (entry) =>
                  entry.ambiguous || entry.hosts.some((host) => host === selectedHost.name),
              )
              .slice(0, MAX_DASHBOARD_CHANGE_ENTRIES);

      const hostDocState =
        selectedHost === null
          ? null
          : (documentationByHost.get(selectedHost.name.toLowerCase()) ??
            defaultDocumentationState(selectedHost));

      let hostDocFile: { path: string; contents: string } | null = null;
      if (selectedHost !== null) {
        hostDocFile = yield* readWorkspaceRelativeFile({
          workspaceRoot: project.workspaceRoot,
          relativePath: `${HOST_DOCS_DIR}/${slugHostName(selectedHost.name)}.md`,
          required: false,
        });
      }

      const hostSummaries = hosts.map((host) => ({
        host,
        documentation:
          documentationByHost.get(host.name.toLowerCase()) ?? defaultDocumentationState(host),
        deployment: deploymentByHost.get(host.name.toLowerCase()) ?? {
          status: "unavailable" as const,
          reason: "missing-deploy-target" as const,
          command: null,
        },
      }));

      return {
        mode: selectedHost === null ? "flake" : "host",
        selectedHostName: selectedHost?.name ?? null,
        flakeSource: {
          path: flakeSource.path,
          language: "nix",
          contents: flakeSource.contents,
        },
        generalChanges,
        hostChanges,
        hostDoc:
          selectedHost === null || hostDocState === null
            ? null
            : {
                path: hostDocState.docPath,
                markdown: hostDocFile?.contents ?? "",
                generatedAt: hostDocState.generatedAt,
                status: hostDocState.status,
              },
        hostSummaries,
      } satisfies ProjectDashboardContentResult;
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ProjectGetDashboardContentError)(cause)
          ? cause
          : toDashboardError("Failed to resolve flake dashboard content.", cause),
      ),
    );

  return {
    resolveDashboardContent,
  } satisfies ProjectDashboardContentResolverShape;
});

export const ProjectDashboardContentResolverLive = Layer.effect(
  ProjectDashboardContentResolver,
  make,
);
