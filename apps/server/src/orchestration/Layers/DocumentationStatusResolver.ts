import { access, constants, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import type { HostDocumentationStatus, ProjectDocumentationState } from "@t3tools/contracts";

import {
  DocumentationStatusResolver,
  type DocumentationStatusResolverShape,
} from "../Services/DocumentationStatusResolver.ts";
import { HostDocumentationGenerationRegistry } from "../Services/HostDocumentationGenerationRegistry.ts";
import {
  HOST_DOCS_DIR,
  LEGACY_GENERAL_CHANGELOG_PATH,
  LEGACY_HOST_DOCS_DIR,
  LEGACY_HOST_DOCS_FALLBACK_DIR,
  parseChangeLogEntries,
  parseHostDocumentationFrontmatter,
  resolveGeneralChangeLogCandidatePaths,
  resolveHostDocCandidatePaths,
  resolveProjectHosts,
} from "../DocumentationUtils.ts";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readFirstAvailableFile(
  candidatePaths: ReadonlyArray<string>,
): Promise<{ path: string; markdown: string } | null> {
  for (const candidatePath of candidatePaths) {
    if (!(await pathExists(candidatePath))) {
      continue;
    }
    return {
      path: candidatePath,
      markdown: await readFile(candidatePath, "utf8"),
    };
  }
  return null;
}

function maxIso(left: string | null, right: string | null): string | null {
  if (left === null) {
    return right;
  }
  if (right === null) {
    return left;
  }
  return left > right ? left : right;
}

const make = Effect.gen(function* () {
  const hostDocumentationGenerationRegistry = yield* HostDocumentationGenerationRegistry;

  const resolve: DocumentationStatusResolverShape["resolve"] = (input) =>
    Effect.gen(function* () {
      const hosts = resolveProjectHosts(input.flakeMetadata);
      const changeLogCandidates = resolveGeneralChangeLogCandidatePaths().map((relativePath) =>
        join(input.workspaceRoot, relativePath),
      );
      const legacyDocsAbsolute = join(input.workspaceRoot, LEGACY_HOST_DOCS_DIR);
      const legacyFallbackDocsAbsolute = join(input.workspaceRoot, LEGACY_HOST_DOCS_FALLBACK_DIR);
      const changeLogFile = yield* Effect.promise(() =>
        readFirstAvailableFile(changeLogCandidates),
      );
      const changeEntries = parseChangeLogEntries({
        markdown: changeLogFile?.markdown ?? "",
        hosts,
      });

      const legacyDocsDetected =
        ((yield* Effect.promise(() => pathExists(legacyDocsAbsolute)))
          ? (yield* Effect.promise(() => readdir(legacyDocsAbsolute).catch(() => []))).some(
              (entry) => entry.endsWith(".md"),
            )
          : false) ||
        ((yield* Effect.promise(() => pathExists(legacyFallbackDocsAbsolute)))
          ? (yield* Effect.promise(() => readdir(legacyFallbackDocsAbsolute).catch(() => []))).some(
              (entry) => entry.endsWith(".md"),
            )
          : false) ||
        changeLogFile?.path === join(input.workspaceRoot, LEGACY_GENERAL_CHANGELOG_PATH);

      const resolvedHosts = yield* Effect.forEach(
        hosts,
        (host) =>
          Effect.gen(function* () {
            const docCandidates = resolveHostDocCandidatePaths(host.name);
            const docCandidatePaths = docCandidates.map((relativePath) =>
              join(input.workspaceRoot, relativePath),
            );
            const docFile = yield* Effect.promise(() => readFirstAvailableFile(docCandidatePaths));
            const resolvedDocPath =
              docFile === null
                ? (docCandidates[0] ?? `${HOST_DOCS_DIR}/${host.name}.md`)
                : (docCandidates.find(
                    (_relativePath, index) => docCandidatePaths[index] === docFile.path,
                  ) ??
                  docCandidates[0] ??
                  `${HOST_DOCS_DIR}/${host.name}.md`);
            const markdown = docFile?.markdown ?? null;
            const frontmatter = markdown ? parseHostDocumentationFrontmatter(markdown) : null;
            const latestHostSpecificChangeAt = changeEntries
              .filter((entry) => entry.hosts.includes(host.name))
              .reduce<string | null>((latest, entry) => maxIso(latest, entry.completedAt), null);
            const latestAmbiguousChangeAt = changeEntries
              .filter((entry) => entry.ambiguous)
              .reduce<string | null>((latest, entry) => maxIso(latest, entry.completedAt), null);
            const latestRelevantChangeAt = maxIso(
              latestHostSpecificChangeAt,
              latestAmbiguousChangeAt,
            );
            const coverageCutoff =
              frontmatter?.coversChangesThrough ?? frontmatter?.generatedAt ?? null;
            const activeJob = yield* hostDocumentationGenerationRegistry.getJob({
              hostName: host.name,
              workspaceRoot: input.workspaceRoot,
            });
            const status: HostDocumentationStatus =
              activeJob !== null
                ? "generating"
                : markdown === null
                  ? "missing"
                  : latestHostSpecificChangeAt !== null &&
                      (coverageCutoff === null || latestHostSpecificChangeAt > coverageCutoff)
                    ? "stale"
                    : latestAmbiguousChangeAt !== null &&
                        (coverageCutoff === null || latestAmbiguousChangeAt > coverageCutoff)
                      ? "needs-review"
                      : "current";
            return {
              hostName: host.name,
              docPath: resolvedDocPath,
              status,
              generatedAt: frontmatter?.generatedAt ?? null,
              coversChangesThrough: frontmatter?.coversChangesThrough ?? null,
              latestRelevantChangeAt,
            };
          }),
        { concurrency: 4 },
      );

      return {
        docsRoot: HOST_DOCS_DIR,
        legacyDocsDetected,
        hosts: resolvedHosts,
      } satisfies ProjectDocumentationState;
    }).pipe(Effect.orDie);

  return {
    resolve,
  } satisfies DocumentationStatusResolverShape;
});

export const DocumentationStatusResolverLive = Layer.effect(DocumentationStatusResolver, make);
