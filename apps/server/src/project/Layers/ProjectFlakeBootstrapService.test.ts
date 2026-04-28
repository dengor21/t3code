import { readFile } from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option, Ref, Stream } from "effect";

import { GitCore } from "../../git/Services/GitCore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "../../workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { ProjectFlakeBootstrapService } from "../Services/ProjectFlakeBootstrapService.ts";
import { ProjectFlakeBootstrapServiceLive } from "./ProjectFlakeBootstrapService.ts";

const baseProjectId = ProjectId.make("project-flake-bootstrap");

function makeProjectShell(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: baseProjectId,
    title: "Bootstrap project",
    workspaceRoot,
    repositoryIdentity: null,
    flakeMetadata: {
      host: null,
      hosts: [],
      source: "missing",
      flakePath: `${workspaceRoot}/flake.nix`,
      diagnostics: ["flake.nix was not found."],
    },
    documentationState: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

const workspaceEntriesLayer = WorkspaceEntriesLive.pipe(
  Layer.provide(WorkspacePathsLive),
  Layer.provide(
    Layer.mock(GitCore)({
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
    }),
  ),
);

const workspaceLayer = Layer.mergeAll(
  WorkspacePathsLive,
  workspaceEntriesLayer,
  WorkspaceFileSystemLive.pipe(
    Layer.provide(WorkspacePathsLive),
    Layer.provide(workspaceEntriesLayer),
  ),
);

it.layer(NodeServices.layer)("ProjectFlakeBootstrapServiceLive", (it) => {
  it.effect("writes the bootstrap files and dispatches a project metadata refresh", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-flake-bootstrap-",
      });
      const dispatchedRef = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);

      const serviceLayer = ProjectFlakeBootstrapServiceLive.pipe(
        Layer.provide(workspaceLayer),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: (projectId) =>
              Effect.succeed(
                projectId === baseProjectId
                  ? Option.some(makeProjectShell(workspaceRoot))
                  : Option.none(),
              ),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            getReadModel: () => Effect.die("not used"),
            readEvents: () => Stream.empty,
            streamDomainEvents: Stream.empty,
            dispatch: (command) =>
              Ref.update(dispatchedRef, (existing) => [...existing, command]).pipe(
                Effect.as({ sequence: 1 }),
              ),
          }),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* ProjectFlakeBootstrapService;
        const result = yield* service.bootstrapFlake({
          projectId: baseProjectId,
          hostScale: "6+",
          platformMatrix: "mixed",
          homeManager: true,
          moduleStyle: "explicit-modules",
          moduleNamespace: "fleet",
        });

        expect(result.layoutPattern).toBe("fleet-layered");
        expect(result.flakePath).toBe("flake.nix");
        expect(result.repoStylePath).toBe(".hal/repo-style.json");
        expect(result.createdSkeletonPaths).toEqual([
          ".hal",
          "hosts",
          "modules",
          "modules/fleet",
          "modules/fleet/shared",
          "modules/fleet/nixos",
          "modules/fleet/darwin",
          "profiles",
          "profiles/base",
          "profiles/roles",
          "homes",
        ]);

        const flakeContents = yield* Effect.promise(() =>
          readFile(`${workspaceRoot}/flake.nix`, "utf8"),
        );
        expect(flakeContents).toContain('nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";');
        expect(flakeContents).toContain('deploy-rs.url = "github:serokell/deploy-rs";');
        expect(flakeContents).toContain("halHosts = {};");
        expect(flakeContents).toContain("deploy.nodes = {};");

        const repoStyleContents = yield* Effect.promise(() =>
          readFile(`${workspaceRoot}/.hal/repo-style.json`, "utf8"),
        );
        expect(JSON.parse(repoStyleContents)).toMatchObject({
          schemaVersion: 1,
          projectTitle: "Bootstrap project",
          layoutPattern: "fleet-layered",
          questionnaire: {
            hostScale: "6+",
            platformMatrix: "mixed",
            homeManager: true,
            moduleStyle: "explicit-modules",
            moduleNamespace: "fleet",
          },
          bootstrapContracts: {
            halHosts: {
              attributePath: "halHosts",
              bootstrapEmptyLiteral: "{}",
            },
            deployNodes: {
              attributePath: "deploy.nodes",
              bootstrapEmptyLiteral: "{}",
            },
          },
        });

        const gitkeepStat = yield* fileSystem.stat(
          `${workspaceRoot}/modules/fleet/shared/.gitkeep`,
        );
        expect(gitkeepStat.type).toBe("File");

        const dispatched = yield* Ref.get(dispatchedRef);
        expect(dispatched).toHaveLength(1);
        expect(dispatched[0]).toMatchObject({
          type: "project.meta.update",
          projectId: baseProjectId,
        });
        expect(typeof dispatched[0]?.commandId).toBe("string");
      }).pipe(Effect.provide(serviceLayer));
    }),
  );

  it.effect("fails when flake.nix already exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-flake-bootstrap-existing-",
      });
      yield* fileSystem.writeFileString(`${workspaceRoot}/flake.nix`, "{ }\n");

      const serviceLayer = ProjectFlakeBootstrapServiceLive.pipe(
        Layer.provide(workspaceLayer),
        Layer.provide(
          Layer.mock(ProjectionSnapshotQuery)({
            getProjectShellById: () => Effect.succeed(Option.some(makeProjectShell(workspaceRoot))),
          }),
        ),
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            getReadModel: () => Effect.die("not used"),
            readEvents: () => Stream.empty,
            streamDomainEvents: Stream.empty,
            dispatch: () => Effect.die("not used"),
          }),
        ),
      );

      const error = yield* Effect.gen(function* () {
        const service = yield* ProjectFlakeBootstrapService;
        return yield* Effect.flip(
          service.bootstrapFlake({
            projectId: baseProjectId,
            hostScale: "1",
            platformMatrix: "nixos",
            homeManager: false,
            moduleStyle: "inline-first",
            moduleNamespace: null,
          }),
        );
      }).pipe(Effect.provide(serviceLayer));
      expect(error.message).toBe("flake.nix already exists for this project.");
    }),
  );
});
