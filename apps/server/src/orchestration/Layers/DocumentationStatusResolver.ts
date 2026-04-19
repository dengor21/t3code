import { access, constants, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, Layer } from "effect";
import type { HostDocumentationStatus, ProjectDocumentationState } from "@t3tools/contracts";

import {
  DocumentationStatusResolver,
  type DocumentationStatusResolverShape,
} from "../Services/DocumentationStatusResolver.ts";
import {
  GENERAL_CHANGELOG_PATH,
  HOST_DOCS_DIR,
  LEGACY_HOST_DOCS_DIR,
  parseChangeLogEntries,
  parseHostDocumentationFrontmatter,
  resolveProjectHosts,
  slugHostName,
} from "../DocumentationUtils.ts";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
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
  const resolve: DocumentationStatusResolverShape["resolve"] = (input) =>
    Effect.tryPromise(async () => {
      const hosts = resolveProjectHosts(input.flakeMetadata);
      const changeLogPath = join(input.workspaceRoot, GENERAL_CHANGELOG_PATH);
      const docsRootAbsolute = join(input.workspaceRoot, HOST_DOCS_DIR);
      const legacyDocsAbsolute = join(input.workspaceRoot, LEGACY_HOST_DOCS_DIR);
      const changeLogMarkdown = (await pathExists(changeLogPath))
        ? await readFile(changeLogPath, "utf8")
        : "";
      const changeEntries = parseChangeLogEntries({
        markdown: changeLogMarkdown,
        hosts,
      });

      let legacyDocsDetected = false;
      if (await pathExists(legacyDocsAbsolute)) {
        const legacyEntries = await readdir(legacyDocsAbsolute).catch(() => []);
        legacyDocsDetected = legacyEntries.some((entry) => entry.endsWith(".md"));
      }

      return {
        docsRoot: HOST_DOCS_DIR,
        legacyDocsDetected,
        hosts: await Promise.all(
          hosts.map(async (host) => {
            const docPath = `${HOST_DOCS_DIR}/${slugHostName(host.name)}.md`;
            const absoluteDocPath = join(input.workspaceRoot, docPath);
            const markdown = (await pathExists(absoluteDocPath))
              ? await readFile(absoluteDocPath, "utf8")
              : null;
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
            const status: HostDocumentationStatus =
              markdown === null
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
              docPath,
              status,
              generatedAt: frontmatter?.generatedAt ?? null,
              coversChangesThrough: frontmatter?.coversChangesThrough ?? null,
              latestRelevantChangeAt,
            };
          }),
        ),
      } satisfies ProjectDocumentationState;
    }).pipe(Effect.orDie);

  return {
    resolve,
  } satisfies DocumentationStatusResolverShape;
});

export const DocumentationStatusResolverLive = Layer.effect(DocumentationStatusResolver, make);
