import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, TextGenerationError, type FlakeMetadata } from "@t3tools/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TextGeneration,
  type HostDocumentationGenerationInput,
  type TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import { FlakeMetadataResolver } from "../../project/Services/FlakeMetadataResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  WorkspaceFileSystem,
  type WorkspaceFileSystemShape,
} from "../../workspace/Services/WorkspaceFileSystem.ts";
import { DocumentationStatusResolver } from "../Services/DocumentationStatusResolver.ts";
import { HostDocumentationService } from "../Services/HostDocumentationService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { HostDocumentationGenerationRegistryLive } from "./HostDocumentationGenerationRegistry.ts";
import { HostDocumentationServiceLive } from "./HostDocumentationService.ts";

describe("HostDocumentationService", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("resolves directory imports to default.nix when generating host docs", async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "t3-host-doc-service-"));
    tempDirs.add(workspaceRoot);

    mkdirSync(path.join(workspaceRoot, "hosts/test/hardware"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, "flake.nix"), '{ description = "test"; }\n');
    writeFileSync(
      path.join(workspaceRoot, "hosts/test/default.nix"),
      "{ ... }: { imports = [ ./hardware ]; }\n",
    );
    writeFileSync(
      path.join(workspaceRoot, "hosts/test/hardware/default.nix"),
      "{ pkgs, ... }: { environment.systemPackages = [ pkgs.hello ]; }\n",
    );

    const flakeMetadata: FlakeMetadata = {
      host: null,
      hosts: [
        {
          name: "test",
          target: "test",
          system: "x86_64-linux",
          type: "nixos",
        },
      ],
      source: "parsed-flake",
      flakePath: path.join(workspaceRoot, "flake.nix"),
      diagnostics: [],
    };

    const generateHostDocumentation = vi.fn<TextGenerationShape["generateHostDocumentation"]>(
      (input) =>
        Effect.succeed({
          overview: `Overview for ${input.host.name}`,
          rolesAndPurpose: ["Runs core host duties"],
          appsAndUserEnvironment: ["Provides hello"],
          servicesAndSystemBehavior: ["Uses imported hardware config"],
          networkingAndAccess: ["Networking not documented"],
          storageAndHardware: ["Hardware comes from imported module"],
          deploymentAndOperations: ["Managed in the flake"],
          knownGaps: ["No gaps"],
        }),
    );
    const writeFile = vi.fn<WorkspaceFileSystemShape["writeFile"]>((input) =>
      Effect.succeed({ relativePath: input.relativePath }),
    );

    const layer = HostDocumentationServiceLive.pipe(
      Layer.provideMerge(HostDocumentationGenerationRegistryLive),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () =>
            Effect.succeed({
              snapshotSequence: 1,
              updatedAt: new Date().toISOString(),
              projects: [
                {
                  id: ProjectId.make("project-test"),
                  title: "Test flake",
                  workspaceRoot,
                  defaultModelSelection: {
                    provider: "codex",
                    model: "gpt-5-codex",
                  },
                  scripts: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  deletedAt: null,
                },
              ],
              threads: [],
            }),
          dispatch: () => Effect.succeed({ sequence: 1 }),
        }),
      ),
      Layer.provide(Layer.mock(TextGeneration)({ generateHostDocumentation })),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(
        Layer.mock(FlakeMetadataResolver)({ resolve: () => Effect.succeed(flakeMetadata) }),
      ),
      Layer.provide(Layer.mock(WorkspaceFileSystem)({ writeFile })),
      Layer.provide(
        Layer.mock(DocumentationStatusResolver)({
          resolve: () =>
            Effect.succeed({
              docsRoot: ".t3code/docs/hosts",
              legacyDocsDetected: false,
              hosts: [],
            }),
        }),
      ),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HostDocumentationService;
        return yield* service.generateHostDocumentation({
          projectId: ProjectId.make("project-test"),
          hostName: "test",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.docPath).toBe(".t3code/docs/hosts/test.md");
    expect(result.status).toBe("queued");
    await vi.waitFor(() => {
      expect(generateHostDocumentation).toHaveBeenCalledTimes(1);
      expect(
        generateHostDocumentation.mock.calls[0]?.[0].contextFiles.map((file) => file.path),
      ).toContain("hosts/test/hardware/default.nix");
      expect(writeFile).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps detached host doc generation alive long enough for scoped temp files", async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "t3-host-doc-scope-"));
    tempDirs.add(workspaceRoot);

    mkdirSync(path.join(workspaceRoot, "hosts/test"), { recursive: true });
    writeFileSync(path.join(workspaceRoot, "flake.nix"), '{ description = "test"; }\n');
    writeFileSync(path.join(workspaceRoot, "hosts/test/default.nix"), "{ ... }: { }\n");

    const flakeMetadata: FlakeMetadata = {
      host: null,
      hosts: [
        {
          name: "test",
          target: "test",
          system: "x86_64-linux",
          type: "nixos",
        },
      ],
      source: "parsed-flake",
      flakePath: path.join(workspaceRoot, "flake.nix"),
      diagnostics: [],
    };

    const scopedTempFileGeneration = ((input: HostDocumentationGenerationInput) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const tempFile = yield* fileSystem.makeTempFileScoped({ prefix: "t3-host-doc-temp-" });
        yield* fileSystem.writeFileString(tempFile, `scoped:${input.host.name}`);
        const overview = yield* fileSystem.readFileString(tempFile);
        return {
          overview,
          rolesAndPurpose: ["Runs core host duties"],
          appsAndUserEnvironment: ["Provides hello"],
          servicesAndSystemBehavior: ["Uses scoped temp files"],
          networkingAndAccess: ["Networking not documented"],
          storageAndHardware: ["Hardware comes from imported module"],
          deploymentAndOperations: ["Managed in the flake"],
          knownGaps: ["No gaps"],
        };
      }).pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation: "generateHostDocumentation",
              detail: "Scoped temp file setup failed.",
              cause,
            }),
        ),
      )) as unknown as TextGenerationShape["generateHostDocumentation"];
    const generateHostDocumentation =
      vi.fn<TextGenerationShape["generateHostDocumentation"]>(scopedTempFileGeneration);
    const writeFile = vi.fn<WorkspaceFileSystemShape["writeFile"]>((input) =>
      Effect.succeed({ relativePath: input.relativePath }),
    );

    const layer = HostDocumentationServiceLive.pipe(
      Layer.provideMerge(HostDocumentationGenerationRegistryLive),
      Layer.provide(
        Layer.mock(OrchestrationEngineService)({
          getReadModel: () =>
            Effect.succeed({
              snapshotSequence: 1,
              updatedAt: new Date().toISOString(),
              projects: [
                {
                  id: ProjectId.make("project-scope"),
                  title: "Scoped flake",
                  workspaceRoot,
                  defaultModelSelection: {
                    provider: "codex",
                    model: "gpt-5-codex",
                  },
                  scripts: [],
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                  deletedAt: null,
                },
              ],
              threads: [],
            }),
          dispatch: () => Effect.succeed({ sequence: 1 }),
        }),
      ),
      Layer.provide(Layer.mock(TextGeneration)({ generateHostDocumentation })),
      Layer.provide(ServerSettingsService.layerTest()),
      Layer.provide(
        Layer.mock(FlakeMetadataResolver)({ resolve: () => Effect.succeed(flakeMetadata) }),
      ),
      Layer.provide(Layer.mock(WorkspaceFileSystem)({ writeFile })),
      Layer.provide(
        Layer.mock(DocumentationStatusResolver)({
          resolve: () =>
            Effect.succeed({
              docsRoot: ".t3code/docs/hosts",
              legacyDocsDetected: false,
              hosts: [],
            }),
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* HostDocumentationService;
        return yield* service.generateHostDocumentation({
          projectId: ProjectId.make("project-scope"),
          hostName: "test",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.docPath).toBe(".t3code/docs/hosts/test.md");
    expect(result.status).toBe("queued");
    await vi.waitFor(() => {
      expect(generateHostDocumentation).toHaveBeenCalledTimes(1);
      expect(writeFile).toHaveBeenCalledTimes(1);
      expect(writeFile.mock.calls[0]?.[0].contents).toContain("scoped:test");
    });
  });
});
