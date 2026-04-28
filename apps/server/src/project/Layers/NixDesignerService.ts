import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { ProjectDashboardNixDesigner, ProjectId } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import {
  NIX_DESIGNER_INDEX_SCHEMA_VERSION,
  defaultIndexManifest,
  normalizeNixOptionDocs,
  normalizeNixPackageDocs,
  resolveLockedNixpkgsRevision,
  scopeToLabel,
  type NixDesignerIndexManifest,
} from "@t3tools/nix-knowledge";

import { ServerConfig } from "../../config.ts";
import { runProcess } from "../../processRunner.ts";
import { loadNixFlakeMetadataJson } from "../nixFlakeMetadata.ts";
import { loadNixOptionsJson } from "../nixDesignerOptionsOutput.ts";
import {
  NixDesignerService,
  NixDesignerServiceError,
  type NixDesignerServiceShape,
} from "../Services/NixDesignerService.ts";

const INDEX_BUILD_TIMEOUT_MS = 10 * 60_000;
const INDEX_BUILD_BUFFER_BYTES = 512 * 1024 * 1024;
const MCP_SERVER_ID = "t3-nix-designer";

function toServiceError(message: string, cause?: unknown): NixDesignerServiceError {
  return new NixDesignerServiceError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function projectHash(projectId: ProjectId, workspaceRoot: string): string {
  return createHash("sha256").update(`${projectId}:${workspaceRoot}`).digest("hex").slice(0, 16);
}

function optionsExpr(flakeRef: string): string {
  return [
    "let",
    `  flake = builtins.getFlake "${flakeRef}";`,
    "  pkgs = import flake.outPath { system = builtins.currentSystem; };",
    '  modules = (import "${flake.outPath}/nixos/modules/module-list.nix") ++ [',
    "    ({ ... }: { _module.check = false; nixpkgs.hostPlatform = builtins.currentSystem; })",
    "  ];",
    "  eval = pkgs.lib.evalModules { inherit modules; };",
    "in",
    "  (pkgs.nixosOptionsDoc { options = eval.options; }).optionsJSON",
  ].join("\n");
}

function normalizeStatus(input: {
  readonly manifest: NixDesignerIndexManifest | null;
  readonly revision: string;
}): ProjectDashboardNixDesigner {
  if (input.manifest === null) {
    return {
      status: "missing",
      revision: input.revision,
      builtAt: null,
      optionCount: 0,
      packageCount: 0,
      lastError: null,
      staleReason: null,
    };
  }

  if (input.manifest.schemaVersion !== NIX_DESIGNER_INDEX_SCHEMA_VERSION) {
    return {
      status: "stale",
      revision: input.manifest.revision,
      builtAt: input.manifest.builtAt,
      optionCount: input.manifest.optionCount,
      packageCount: input.manifest.packageCount,
      lastError: input.manifest.lastError,
      staleReason: "schema-version-changed",
    };
  }

  if (input.manifest.revision !== input.revision) {
    return {
      status: "stale",
      revision: input.manifest.revision,
      builtAt: input.manifest.builtAt,
      optionCount: input.manifest.optionCount,
      packageCount: input.manifest.packageCount,
      lastError: input.manifest.lastError,
      staleReason: "revision-changed",
    };
  }

  return {
    status: input.manifest.lastError ? "error" : "ready",
    revision: input.manifest.revision,
    builtAt: input.manifest.builtAt,
    optionCount: input.manifest.optionCount,
    packageCount: input.manifest.packageCount,
    lastError: input.manifest.lastError,
    staleReason: input.manifest.staleReason,
  };
}

function errorStatus(message: string): ProjectDashboardNixDesigner {
  return {
    status: "error",
    revision: null,
    builtAt: null,
    optionCount: 0,
    packageCount: 0,
    lastError: message,
    staleReason: null,
  };
}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig;
  const indexRootDir = join(serverConfig.providerStatusCacheDir, "nix-designer");
  const cliPath = resolve(import.meta.dirname, "../../../../packages/nix-mcp-server/src/cli.ts");

  const readManifest = async (
    projectId: ProjectId,
    workspaceRoot: string,
    revision: string,
  ): Promise<{ manifest: NixDesignerIndexManifest | null; indexDir: string }> => {
    const indexDir = join(
      indexRootDir,
      projectHash(projectId, workspaceRoot),
      revision,
      String(NIX_DESIGNER_INDEX_SCHEMA_VERSION),
    );
    try {
      const manifest = JSON.parse(await readFile(join(indexDir, "manifest.json"), "utf8"));
      return { manifest: manifest as NixDesignerIndexManifest, indexDir };
    } catch {
      return { manifest: null, indexDir };
    }
  };

  const resolveRevision = (workspaceRoot: string) =>
    Effect.tryPromise({
      try: async () => resolveLockedNixpkgsRevision(await loadNixFlakeMetadataJson(workspaceRoot)),
      catch: (cause) => toServiceError("Failed to resolve locked nixpkgs revision.", cause),
    });

  const persistIndexFiles = (input: {
    readonly indexDir: string;
    readonly manifest: NixDesignerIndexManifest;
    readonly options: ReadonlyArray<unknown>;
    readonly packages: ReadonlyArray<unknown>;
    readonly errorMessage: string;
  }) =>
    Effect.tryPromise({
      try: async () => {
        await writeFile(
          join(input.indexDir, "manifest.json"),
          `${JSON.stringify(input.manifest)}\n`,
        );
        await writeFile(join(input.indexDir, "options.json"), `${JSON.stringify(input.options)}\n`);
        await writeFile(
          join(input.indexDir, "packages.json"),
          `${JSON.stringify(input.packages)}\n`,
        );
      },
      catch: (cause) => toServiceError(input.errorMessage, cause),
    });

  const getStatus: NixDesignerServiceShape["getStatus"] = (input) =>
    Effect.gen(function* () {
      const lockedRevision = yield* resolveRevision(input.workspaceRoot);
      const existing = yield* Effect.tryPromise({
        try: () => readManifest(input.projectId, input.workspaceRoot, lockedRevision.revision),
        catch: (cause) => toServiceError("Failed to read Nix designer manifest.", cause),
      });
      return normalizeStatus({
        manifest: existing.manifest,
        revision: lockedRevision.revision,
      });
    }).pipe(Effect.catch((failure) => Effect.succeed(errorStatus(failure.message))));

  const rebuildIndex: NixDesignerServiceShape["rebuildIndex"] = (input) =>
    Effect.gen(function* () {
      const lockedRevision = yield* resolveRevision(input.workspaceRoot);
      const { indexDir } = yield* Effect.tryPromise({
        try: () => readManifest(input.projectId, input.workspaceRoot, lockedRevision.revision),
        catch: (cause) => toServiceError("Failed to prepare Nix designer index directory.", cause),
      });
      const builtAt = new Date().toISOString();
      yield* Effect.tryPromise({
        try: async () => {
          await rm(indexDir, { recursive: true, force: true });
          await mkdir(indexDir, { recursive: true });
        },
        catch: (cause) => toServiceError("Failed to reset Nix designer cache directory.", cause),
      });

      const manifestBase = defaultIndexManifest({
        revision: lockedRevision.revision,
        channel: lockedRevision.channel,
        builtAt,
      });

      const buildIndex = Effect.gen(function* () {
        const optionsPathResult = yield* Effect.tryPromise({
          try: () =>
            runProcess(
              "nix",
              [
                "build",
                "--no-link",
                "--print-out-paths",
                "--impure",
                "--expr",
                optionsExpr(lockedRevision.flakeRef),
              ],
              {
                cwd: input.workspaceRoot,
                timeoutMs: INDEX_BUILD_TIMEOUT_MS,
                maxBufferBytes: 8 * 1024 * 1024,
              },
            ),
          catch: (cause) => toServiceError("Failed to evaluate the Nix options corpus.", cause),
        });
        if ((optionsPathResult.code ?? 1) !== 0) {
          return yield* toServiceError(
            optionsPathResult.stderr.trim() || "Failed to evaluate options corpus.",
          );
        }
        const optionsPath = optionsPathResult.stdout.trim();
        const optionsRaw = yield* Effect.tryPromise({
          try: () => loadNixOptionsJson(optionsPath),
          catch: (cause) => toServiceError("Failed to load evaluated Nix options JSON.", cause),
        });
        const options = normalizeNixOptionDocs(optionsRaw);

        const packagesResult = yield* Effect.tryPromise({
          try: () =>
            runProcess("nix", ["search", "--quiet", "--json", lockedRevision.flakeRef, ".*"], {
              cwd: input.workspaceRoot,
              timeoutMs: INDEX_BUILD_TIMEOUT_MS,
              maxBufferBytes: INDEX_BUILD_BUFFER_BYTES,
            }),
          catch: (cause) => toServiceError("Failed to evaluate the nixpkgs package corpus.", cause),
        });
        if ((packagesResult.code ?? 1) !== 0) {
          return yield* toServiceError(
            packagesResult.stderr.trim() || "Failed to build package corpus.",
          );
        }
        const packages = normalizeNixPackageDocs(JSON.parse(packagesResult.stdout));

        const manifest: NixDesignerIndexManifest = {
          ...manifestBase,
          optionCount: options.length,
          packageCount: packages.length,
        };

        yield* persistIndexFiles({
          indexDir,
          manifest,
          options,
          packages,
          errorMessage: "Failed to persist the Nix designer index.",
        });

        return normalizeStatus({
          manifest,
          revision: lockedRevision.revision,
        });
      });

      return yield* buildIndex.pipe(
        Effect.catch((failure) => {
          const failedManifest: NixDesignerIndexManifest = {
            ...manifestBase,
            lastError: failure.message,
          };
          return persistIndexFiles({
            indexDir,
            manifest: failedManifest,
            options: [],
            packages: [],
            errorMessage: "Failed to persist the failed Nix designer manifest.",
          }).pipe(
            Effect.catch(() => Effect.void),
            Effect.as({
              status: "error",
              revision: lockedRevision.revision,
              builtAt,
              optionCount: 0,
              packageCount: 0,
              lastError: failure.message,
              staleReason: null,
            } satisfies ProjectDashboardNixDesigner),
          );
        }),
      );
    });

  const ensureIndex: NixDesignerServiceShape["ensureIndex"] = (input) =>
    getStatus(input).pipe(
      Effect.flatMap((status) =>
        status.status === "ready" ? Effect.succeed(status) : rebuildIndex(input),
      ),
    );

  const createDescriptor: NixDesignerServiceShape["createDescriptor"] = (input) =>
    Effect.gen(function* () {
      const status = yield* ensureIndex({
        projectId: input.projectId,
        workspaceRoot: input.workspaceRoot,
      });
      if (status.status !== "ready") {
        return yield* toServiceError("Nix designer index is not ready for MCP attachment.");
      }
      const revision = status.revision ?? "nixpkgs";
      const indexDir = join(
        indexRootDir,
        projectHash(input.projectId, input.workspaceRoot),
        revision,
        String(NIX_DESIGNER_INDEX_SCHEMA_VERSION),
      );

      return {
        id: MCP_SERVER_ID,
        transport: "stdio",
        command: process.execPath,
        args: [cliPath],
        cwd: input.workspaceRoot,
        env: {
          T3_NIX_INDEX_DIR: indexDir,
          T3_NIX_PROJECT_ROOT: input.workspaceRoot,
          T3_NIX_DESIGNER_SCOPE: scopeToLabel(input.scope),
          T3_NIX_VALIDATION_BUDGET: "5",
          T3_NIX_VALIDATION_TIMEOUT_MS: "30000",
        },
      } as const;
    });

  return {
    getStatus,
    ensureIndex,
    rebuildIndex,
    createDescriptor,
  } satisfies NixDesignerServiceShape;
});

export const NixDesignerServiceLive = Layer.effect(NixDesignerService, make);
