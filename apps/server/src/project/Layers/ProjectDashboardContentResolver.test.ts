import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  buildDeployRsCommand,
  type FlakeMetadata,
  type OrchestrationProjectShell,
  ProjectId,
} from "@t3tools/contracts";
import { Effect, Layer, Option, Stream } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DocumentationStatusResolverLive } from "../../orchestration/Layers/DocumentationStatusResolver.ts";
import { HostDocumentationGenerationRegistryLive } from "../../orchestration/Layers/HostDocumentationGenerationRegistry.ts";
import { HostDocumentationGenerationRegistry } from "../../orchestration/Services/HostDocumentationGenerationRegistry.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";
import { ProjectDashboardContentResolver } from "../Services/ProjectDashboardContentResolver.ts";
import { DeployRsResolver } from "../Services/DeployRsResolver.ts";
import { HostDeploymentService } from "../Services/HostDeploymentService.ts";
import { FlakeMaintenanceService } from "../Services/FlakeMaintenanceService.ts";
import { ProjectDashboardContentResolverLive } from "./ProjectDashboardContentResolver.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);

function writeFile(targetPath: string, contents: string) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, contents, "utf8");
}

describe("ProjectDashboardContentResolver", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const cwd = tempDirs.pop();
      if (cwd) {
        fs.rmSync(cwd, { recursive: true, force: true });
      }
    }
  });

  function createWorkspace() {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-dashboard-content-"));
    tempDirs.push(cwd);
    writeFile(
      path.join(cwd, "flake.nix"),
      `{
  description = "dashboard test";
}
`,
    );
    writeFile(
      path.join(cwd, ".t3code/changes.md"),
      `# T3code Change Log

## Entries
<!-- t3code:turn:turn-4:start -->
<!-- t3code:meta {"kind":"change","completedAt":"2026-04-19T12:00:00.000Z","hosts":["bc250"],"ambiguous":false} -->
### 2026-04-19T12:00:00.000Z - Add mpv to bc250

bc250 now includes mpv.

- Added mpv to the host package set

Files: \`hosts/bc250/default.nix\`
<!-- t3code:turn:turn-4:end -->

<!-- t3code:turn:turn-3:start -->
### 2026-04-19T11:00:00.000Z - Update bc250 shell aliases

Legacy entry without metadata.

- Refreshed shell aliases for bc250

Files: \`hosts/bc250/default.nix\`
<!-- t3code:turn:turn-3:end -->

<!-- t3code:turn:turn-2:start -->
<!-- t3code:meta {"kind":"change","completedAt":"2026-04-19T10:00:00.000Z","hosts":[],"ambiguous":true} -->
### 2026-04-19T10:00:00.000Z - Change shared flake defaults

Adjusted shared flake settings.

- Updated a shared module

Files: \`flake.nix\`
<!-- t3code:turn:turn-2:end -->

<!-- t3code:bootstrap:initial:start -->
### 2026-04-18T09:00:00.000Z - Initial infrastructure snapshot

Captured the initial flake state.

- Recorded the original host layout

Files: \`flake.nix\`
<!-- t3code:bootstrap:initial:end -->
`,
    );
    writeFile(
      path.join(cwd, ".t3code/docs/hosts/bc250.md"),
      `---
kind: host-doc
host: bc250
target: bc250
system: x86_64-linux
type: nixos
generatedAt: 2026-04-19T13:00:00.000Z
coversChangesThrough: 2026-04-19T13:00:00.000Z
sourceFiles:
  - flake.nix
  - hosts/bc250/default.nix
generatorVersion: 1
---

# Host: bc250

This file is maintained manually by T3code.

## Overview
Current-state documentation for bc250.
`,
    );
    return cwd;
  }

  function makeProjectShell(workspaceRoot: string): OrchestrationProjectShell {
    return {
      id: asProjectId("project-1"),
      title: "nix",
      workspaceRoot,
      repositoryIdentity: null,
      flakeMetadata: null,
      documentationState: null,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-04-19T08:00:00.000Z",
      updatedAt: "2026-04-19T08:00:00.000Z",
    };
  }

  const flakeMetadata: FlakeMetadata = {
    source: "parsed-flake",
    flakePath: "/ignored/flake.nix",
    host: null,
    hosts: [
      {
        name: "bc250",
        target: "bc250",
        system: "x86_64-linux",
        type: "nixos",
      },
      {
        name: "nexus",
        target: "10.0.0.115",
        system: "x86_64-linux",
        type: "nixos",
      },
    ],
    diagnostics: [],
  };

  function makeProjectionSnapshotQuery(
    project: OrchestrationProjectShell | null,
  ): ProjectionSnapshotQueryShape {
    return {
      getSnapshot: () => Effect.die("unused"),
      getShellSnapshot: () => Effect.die("unused"),
      getCounts: () => Effect.die("unused"),
      getActiveProjectByWorkspaceRoot: () => Effect.die("unused"),
      getProjectShellById: () => Effect.succeed(project ? Option.some(project) : Option.none()),
      getFirstActiveThreadIdByProjectId: () => Effect.die("unused"),
      getThreadCheckpointContext: () => Effect.die("unused"),
      getThreadShellById: () => Effect.die("unused"),
      getThreadDetailById: () => Effect.die("unused"),
    };
  }

  function makeLayer(
    workspaceRoot: string,
    options?: {
      project?: OrchestrationProjectShell | null;
    },
  ) {
    const hostDocumentationGenerationRegistryLayer = HostDocumentationGenerationRegistryLive;
    return ProjectDashboardContentResolverLive.pipe(
      Layer.provideMerge(hostDocumentationGenerationRegistryLayer),
      Layer.provideMerge(
        DocumentationStatusResolverLive.pipe(
          Layer.provideMerge(hostDocumentationGenerationRegistryLayer),
        ),
      ),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(
        Layer.succeed(FlakeMetadataResolver, {
          resolve: () => Effect.succeed(flakeMetadata),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(DeployRsResolver, {
          resolveHostDeployments: () =>
            Effect.succeed(
              new Map([
                [
                  "bc250",
                  {
                    status: "deployable" as const,
                    reason: null,
                    command: buildDeployRsCommand("bc250"),
                  },
                ],
                [
                  "nexus",
                  {
                    status: "unavailable" as const,
                    reason: "missing-deploy-target" as const,
                    command: null,
                  },
                ],
              ]),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProjectionSnapshotQuery,
          makeProjectionSnapshotQuery(options?.project ?? makeProjectShell(workspaceRoot)),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(HostDeploymentService, {
          start: () => Effect.die("unused"),
          get: () => Effect.die("unused"),
          listByProjectId: () => Effect.succeed(new Map()),
          stop: () => Effect.die("unused"),
          openTerminal: () => Effect.die("unused"),
          resizeTerminal: () => Effect.die("unused"),
          subscribeTerminalEvents: () => Stream.empty,
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(FlakeMaintenanceService, {
          start: () => Effect.die("unused"),
          get: () => Effect.succeed(null),
          stop: () => Effect.die("unused"),
          openTerminal: () => Effect.die("unused"),
          resizeTerminal: () => Effect.die("unused"),
          subscribeTerminalEvents: () => Stream.empty,
        }),
      ),
      Layer.provide(NodeServices.layer),
    );
  }

  it("returns flake-level dashboard content with the latest 3 general changes", async () => {
    const workspaceRoot = createWorkspace();
    const resolver = await Effect.runPromise(
      Effect.service(ProjectDashboardContentResolver).pipe(
        Effect.provide(makeLayer(workspaceRoot)),
      ),
    );

    const result = await Effect.runPromise(
      resolver.resolveDashboardContent({
        projectId: asProjectId("project-1"),
      }),
    );

    expect(result.mode).toBe("flake");
    expect(result.selectedHostName).toBeNull();
    expect(result.flakeSource.path).toBe("flake.nix");
    expect(result.flakeSource.contents).toContain('description = "dashboard test"');
    expect(result.generalChanges.map((entry) => entry.title)).toEqual([
      "Add mpv to bc250",
      "Update bc250 shell aliases",
      "Change shared flake defaults",
    ]);
    expect(result.generalChanges[1]?.hosts).toEqual(["bc250"]);
    expect(result.hostChanges).toEqual([]);
    expect(result.hostDoc).toBeNull();
    expect(result.hostSummaries).toHaveLength(2);
    expect(result.latestMaintenance).toBeNull();
    expect(
      result.hostSummaries.find((entry) => entry.host.name === "bc250")?.documentation.status,
    ).toBe("current");
    expect(result.hostSummaries.find((entry) => entry.host.name === "bc250")?.deployment).toEqual({
      status: "deployable",
      reason: null,
      command: buildDeployRsCommand("bc250"),
    });
    expect(
      result.hostSummaries.find((entry) => entry.host.name === "nexus")?.documentation.status,
    ).toBe("missing");
    expect(result.hostSummaries.find((entry) => entry.host.name === "nexus")?.deployment).toEqual({
      status: "unavailable",
      reason: "missing-deploy-target",
      command: null,
    });
  });

  it("returns host-level dashboard content with ambiguous and legacy host changes", async () => {
    const workspaceRoot = createWorkspace();
    const resolver = await Effect.runPromise(
      Effect.service(ProjectDashboardContentResolver).pipe(
        Effect.provide(makeLayer(workspaceRoot)),
      ),
    );

    const result = await Effect.runPromise(
      resolver.resolveDashboardContent({
        projectId: asProjectId("project-1"),
        hostName: "bc250",
      }),
    );

    expect(result.mode).toBe("host");
    expect(result.selectedHostName).toBe("bc250");
    expect(result.hostChanges.map((entry) => entry.title)).toEqual([
      "Add mpv to bc250",
      "Update bc250 shell aliases",
      "Change shared flake defaults",
    ]);
    expect(result.hostChanges[2]?.ambiguous).toBe(true);
    expect(result.hostDoc?.path).toBe(".t3code/docs/hosts/bc250.md");
    expect(result.hostDoc?.status).toBe("current");
    expect(result.hostDoc?.markdown).toContain("# Host: bc250");
    expect(result.hostDoc?.markdown.startsWith("---")).toBe(false);
  });

  it("fails with a typed error when the requested host is unknown", async () => {
    const workspaceRoot = createWorkspace();
    const resolver = await Effect.runPromise(
      Effect.service(ProjectDashboardContentResolver).pipe(
        Effect.provide(makeLayer(workspaceRoot)),
      ),
    );

    await expect(
      Effect.runPromise(
        resolver.resolveDashboardContent({
          projectId: asProjectId("project-1"),
          hostName: "missing-host",
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "ProjectGetDashboardContentError",
      message: "Host missing-host was not found in the selected flake.",
    });
  });

  it("resolves live generating status even when the cached project snapshot is stale", async () => {
    const workspaceRoot = createWorkspace();
    const layer = makeLayer(workspaceRoot, {
      project: {
        ...makeProjectShell(workspaceRoot),
        documentationState: {
          docsRoot: ".t3code/docs/hosts",
          legacyDocsDetected: false,
          hosts: [
            {
              hostName: "bc250",
              docPath: ".t3code/docs/hosts/bc250.md",
              status: "current",
              generatedAt: "2026-04-19T13:00:00.000Z",
              coversChangesThrough: "2026-04-19T13:00:00.000Z",
              latestRelevantChangeAt: null,
            },
            {
              hostName: "nexus",
              docPath: ".t3code/docs/hosts/nexus.md",
              status: "missing",
              generatedAt: null,
              coversChangesThrough: null,
              latestRelevantChangeAt: null,
            },
          ],
        },
      },
    }).pipe(Layer.provideMerge(HostDocumentationGenerationRegistryLive));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* HostDocumentationGenerationRegistry;
        yield* registry.ensureJob({
          hostName: "bc250",
          workspaceRoot,
        });

        const resolver = yield* ProjectDashboardContentResolver;
        return yield* resolver.resolveDashboardContent({
          projectId: asProjectId("project-1"),
          hostName: "bc250",
        });
      }).pipe(Effect.provide(layer)),
    );

    expect(result.hostDoc?.status).toBe("generating");
    expect(
      result.hostSummaries.find((entry) => entry.host.name === "bc250")?.documentation.status,
    ).toBe("generating");
  });
});
