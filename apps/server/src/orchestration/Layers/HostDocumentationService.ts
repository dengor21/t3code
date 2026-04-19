import { access, constants, readFile, stat } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

import {
  CommandId,
  type FlakeHost,
  type ModelSelection,
  ProjectGenerateHostDocumentationError,
} from "@t3tools/contracts";
import { Effect, Layer, Schema } from "effect";

import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { FlakeMetadataResolver } from "../../project/Services/FlakeMetadataResolver.ts";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem.ts";
import {
  HostDocumentationService,
  type HostDocumentationServiceShape,
} from "../Services/HostDocumentationService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { DocumentationStatusResolver } from "../Services/DocumentationStatusResolver.ts";
import { HOST_DOCS_DIR, resolveProjectHosts, slugHostName } from "../DocumentationUtils.ts";

const MAX_CONTEXT_FILES = 20;
const MAX_CONTEXT_FILE_CHARS = 12_000;
const MAX_TOTAL_CONTEXT_CHARS = 60_000;
const MAX_IMPORT_DEPTH = 2;
const GENERATOR_VERSION = 1;

interface ContextFile {
  readonly path: string;
  readonly contents: string;
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRelativePath(value: string): string {
  return posix.normalize(value).replace(/^\.\/+/, "");
}

function truncateContents(contents: string): string {
  return contents.length <= MAX_CONTEXT_FILE_CHARS
    ? contents
    : `${contents.slice(0, MAX_CONTEXT_FILE_CHARS)}\n... [truncated]`;
}

async function resolveReadableWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
): Promise<string | null> {
  const normalizedRelativePath = normalizeRelativePath(relativePath);
  const absolutePath = join(workspaceRoot, normalizedRelativePath);
  try {
    const entry = await stat(absolutePath);
    if (entry.isFile()) {
      return normalizedRelativePath;
    }
    if (entry.isDirectory()) {
      const defaultNixRelativePath = normalizeRelativePath(
        posix.join(normalizedRelativePath, "default.nix"),
      );
      const defaultNixAbsolutePath = join(workspaceRoot, defaultNixRelativePath);
      const defaultEntry = await stat(defaultNixAbsolutePath).catch(() => null);
      return defaultEntry?.isFile() ? defaultNixRelativePath : null;
    }
    return null;
  } catch {
    return null;
  }
}

function parseImportPaths(contents: string): ReadonlyArray<string> {
  const matches: string[] = [];
  const importBlockRegex = /imports\s*=\s*\[([\s\S]*?)\];/g;
  for (const blockMatch of contents.matchAll(importBlockRegex)) {
    const block = blockMatch[1] ?? "";
    for (const entry of block.matchAll(/(?:\.{1,2}\/[^\s\]"';]+|\/[^\s\]"';]+)/g)) {
      const importPath = entry[0]?.trim() ?? "";
      if (importPath.length > 0 && !importPath.startsWith("/nix/store/")) {
        matches.push(importPath);
      }
    }
  }
  return [...new Set(matches)];
}

function buildSeedPaths(hostName: string): ReadonlyArray<string> {
  return [
    "flake.nix",
    "flake.lock",
    "README.md",
    `hosts/${hostName}/default.nix`,
    `hosts/${hostName}.nix`,
    `machines/${hostName}/default.nix`,
    `machines/${hostName}.nix`,
    `profiles/${hostName}.nix`,
  ];
}

function renderSection(title: string, value: string | ReadonlyArray<string>): string {
  if (typeof value === "string") {
    const body = value.trim().length > 0 ? value.trim() : "Not documented.";
    return [`## ${title}`, body, ""].join("\n");
  }
  const lines = value
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => `- ${entry}`);
  return [`## ${title}`, ...(lines.length > 0 ? lines : ["- Not documented."]), ""].join("\n");
}

function renderHostDocumentation(input: {
  host: FlakeHost;
  generatedAt: string;
  coversChangesThrough: string;
  sourceFiles: ReadonlyArray<string>;
  generated: {
    overview: string;
    rolesAndPurpose: ReadonlyArray<string>;
    appsAndUserEnvironment: ReadonlyArray<string>;
    servicesAndSystemBehavior: ReadonlyArray<string>;
    networkingAndAccess: ReadonlyArray<string>;
    storageAndHardware: ReadonlyArray<string>;
    deploymentAndOperations: ReadonlyArray<string>;
    knownGaps: ReadonlyArray<string>;
  };
}): string {
  const frontmatter = [
    "---",
    "kind: host-doc",
    `host: ${input.host.name}`,
    `target: ${input.host.target}`,
    ...(input.host.system ? [`system: ${input.host.system}`] : []),
    ...(input.host.type ? [`type: ${input.host.type}`] : []),
    `generatedAt: ${input.generatedAt}`,
    `coversChangesThrough: ${input.coversChangesThrough}`,
    "sourceFiles:",
    ...input.sourceFiles.map((file) => `  - ${file}`),
    `generatorVersion: ${GENERATOR_VERSION.toString()}`,
    "---",
    "",
  ];
  return [
    ...frontmatter,
    `# Host: ${input.host.name}`,
    "",
    "This file is maintained manually by T3code.",
    "",
    renderSection("Overview", input.generated.overview),
    renderSection("Roles And Purpose", input.generated.rolesAndPurpose),
    renderSection("Apps And User Environment", input.generated.appsAndUserEnvironment),
    renderSection("Services And System Behavior", input.generated.servicesAndSystemBehavior),
    renderSection("Networking And Access", input.generated.networkingAndAccess),
    renderSection("Storage And Hardware", input.generated.storageAndHardware),
    renderSection("Deployment And Operations", input.generated.deploymentAndOperations),
    renderSection("Known Gaps", input.generated.knownGaps),
    "## Source Files",
    ...input.sourceFiles.map((file) => `- \`${file}\``),
    "",
  ].join("\n");
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const textGeneration = yield* TextGeneration;
  const serverSettings = yield* ServerSettingsService;
  const flakeMetadataResolver = yield* FlakeMetadataResolver;
  const workspaceFileSystem = yield* WorkspaceFileSystem;
  const documentationStatusResolver = yield* DocumentationStatusResolver;

  const readWorkspaceFile = (workspaceRoot: string, relativePath: string) =>
    Effect.tryPromise(async () => {
      const readableRelativePath = await resolveReadableWorkspacePath(workspaceRoot, relativePath);
      if (readableRelativePath === null) {
        return null;
      }
      const absolutePath = join(workspaceRoot, readableRelativePath);
      return await readFile(absolutePath, "utf8");
    }).pipe(Effect.catch(() => Effect.succeed(null)));

  const resolveModelSelection = (input: {
    projectDefaultModelSelection: ModelSelection | null;
  }): Effect.Effect<ModelSelection, never, never> =>
    Effect.gen(function* () {
      if (input.projectDefaultModelSelection) {
        return input.projectDefaultModelSelection;
      }
      const settings = yield* serverSettings.getSettings.pipe(Effect.orDie);
      return settings.textGenerationModelSelection;
    });

  const collectContextFiles = (input: {
    workspaceRoot: string;
    host: FlakeHost;
  }): Effect.Effect<ReadonlyArray<ContextFile>, never, never> =>
    Effect.gen(function* () {
      const orderedPaths: string[] = [];
      const seen = new Set<string>();
      let totalChars = 0;

      const enqueuePath = (relativePath: string) => {
        const normalized = normalizeRelativePath(relativePath);
        if (
          normalized.length === 0 ||
          seen.has(normalized) ||
          orderedPaths.length >= MAX_CONTEXT_FILES
        ) {
          return;
        }
        seen.add(normalized);
        orderedPaths.push(normalized);
      };

      const walkImports = (
        relativePath: string,
        depth: number,
      ): Effect.Effect<void, never, never> =>
        Effect.gen(function* () {
          if (depth > MAX_IMPORT_DEPTH) {
            return;
          }
          const contents = yield* readWorkspaceFile(input.workspaceRoot, relativePath);
          if (contents === null) {
            return;
          }
          const baseDir = dirname(relativePath);
          for (const importPath of parseImportPaths(contents)) {
            if (importPath.startsWith("/")) {
              continue;
            }
            const nestedImportPath = normalizeRelativePath(posix.join(baseDir, importPath));
            const nestedRelativePath = yield* Effect.promise(() =>
              resolveReadableWorkspacePath(input.workspaceRoot, nestedImportPath),
            );
            if (nestedRelativePath === null) {
              continue;
            }
            enqueuePath(nestedRelativePath);
            yield* walkImports(nestedRelativePath, depth + 1);
          }
        });

      for (const seedPath of buildSeedPaths(input.host.name)) {
        enqueuePath(seedPath);
      }

      for (const seedPath of buildSeedPaths(input.host.name)) {
        if (
          seedPath.startsWith(`hosts/${input.host.name}`) ||
          seedPath.startsWith(`machines/${input.host.name}`) ||
          seedPath.startsWith(`profiles/${input.host.name}`)
        ) {
          yield* walkImports(seedPath, 1);
        }
      }

      const flakeContents = yield* readWorkspaceFile(input.workspaceRoot, "flake.nix");
      if (
        flakeContents &&
        (flakeContents.includes(`nixosConfigurations.${input.host.name}`) ||
          flakeContents.includes(`darwinConfigurations.${input.host.name}`) ||
          flakeContents.includes(`deploy.nodes.${input.host.name}`) ||
          flakeContents.includes(`"${input.host.name}"`) ||
          flakeContents.includes(`${input.host.name} =`))
      ) {
        enqueuePath("flake.nix");
      }

      const contextFiles: ContextFile[] = [];
      for (const relativePath of orderedPaths) {
        if (contextFiles.length >= MAX_CONTEXT_FILES || totalChars >= MAX_TOTAL_CONTEXT_CHARS) {
          break;
        }
        const contents = yield* readWorkspaceFile(input.workspaceRoot, relativePath);
        if (contents === null || contents.trim().length === 0) {
          continue;
        }
        const truncated = truncateContents(contents);
        totalChars += truncated.length;
        contextFiles.push({
          path: relativePath,
          contents: truncated,
        });
      }

      return contextFiles;
    });

  const generateHostDocumentation: HostDocumentationServiceShape["generateHostDocumentation"] = (
    input,
  ) =>
    Effect.gen(function* () {
      const readModel = yield* orchestrationEngine.getReadModel();
      const project = readModel.projects.find((entry) => entry.id === input.projectId);
      if (!project) {
        return yield* new ProjectGenerateHostDocumentationError({
          message: `Flake ${input.projectId} was not found.`,
        });
      }

      const flakeMetadata = yield* flakeMetadataResolver.resolve(project.workspaceRoot);
      const host = resolveProjectHosts(flakeMetadata).find(
        (entry) => entry.name.toLowerCase() === input.hostName.trim().toLowerCase(),
      );
      if (!host) {
        return yield* new ProjectGenerateHostDocumentationError({
          message: `Host ${input.hostName} was not found in the selected flake.`,
        });
      }

      const contextFiles = yield* collectContextFiles({
        workspaceRoot: project.workspaceRoot,
        host,
      });
      const documentationState = yield* documentationStatusResolver.resolve({
        workspaceRoot: project.workspaceRoot,
        flakeMetadata,
      });
      const hostDocState =
        documentationState.hosts.find((entry) => entry.hostName === host.name) ?? null;
      const generatedAt = new Date().toISOString();
      const coversChangesThrough = hostDocState?.latestRelevantChangeAt ?? generatedAt;
      const modelSelection = yield* resolveModelSelection({
        projectDefaultModelSelection: project.defaultModelSelection,
      });
      const generated = yield* textGeneration.generateHostDocumentation({
        cwd: project.workspaceRoot,
        projectTitle: project.title,
        host,
        contextFiles,
        modelSelection,
      });
      const docPath = `${HOST_DOCS_DIR}/${slugHostName(host.name)}.md`;
      yield* workspaceFileSystem.writeFile({
        cwd: project.workspaceRoot,
        relativePath: docPath,
        contents: renderHostDocumentation({
          host,
          generatedAt,
          coversChangesThrough,
          sourceFiles: contextFiles.map((file) => file.path),
          generated,
        }),
      });
      yield* orchestrationEngine.dispatch({
        type: "project.meta.update",
        commandId: CommandId.make(`server:host-doc-refresh:${crypto.randomUUID()}`),
        projectId: project.id,
      });

      return {
        docPath,
        generatedAt,
      };
    }).pipe(
      Effect.mapError((cause) =>
        Schema.is(ProjectGenerateHostDocumentationError)(cause)
          ? cause
          : new ProjectGenerateHostDocumentationError({
              message: "Failed to generate host documentation.",
              cause,
            }),
      ),
    );

  return {
    generateHostDocumentation,
  } satisfies HostDocumentationServiceShape;
});

export const HostDocumentationServiceLive = Layer.effect(HostDocumentationService, make);
