import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, type FlakeMetadata, type OrchestrationProjectShell } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { afterEach, vi } from "vitest";

vi.mock("../../processRunner.ts", () => ({
  runProcess: vi.fn(),
}));

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runProcess } from "../../processRunner.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";
import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";
import { ProjectSecretsService } from "../Services/ProjectSecretsService.ts";
import { ProjectSecretsServiceLive } from "./ProjectSecretsService.ts";

const mockedRunProcess = vi.mocked(runProcess);
const baseProjectId = ProjectId.make("project-secrets");
const flakeMetadata: FlakeMetadata = {
  source: "parsed-flake",
  flakePath: "/ignored/flake.nix",
  host: {
    name: "chatserver",
    target: "chatserver",
    system: "x86_64-linux",
    type: "nixos",
  },
  hosts: [
    {
      name: "chatserver",
      target: "chatserver",
      system: "x86_64-linux",
      type: "nixos",
    },
  ],
  diagnostics: [],
};

const tempDirs: string[] = [];

function createWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-project-secrets-"));
  tempDirs.push(cwd);
  fs.mkdirSync(path.join(cwd, "hosts", "chatserver"), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, "flake.nix"),
    `{
  description = "project secrets test";
}
`,
    "utf8",
  );
  fs.writeFileSync(path.join(cwd, "hosts", "chatserver", "secrets.yaml"), "encrypted: true\n");
  return cwd;
}

function makeProjectShell(workspaceRoot: string): OrchestrationProjectShell {
  return {
    id: baseProjectId,
    title: "Secrets project",
    workspaceRoot,
    repositoryIdentity: null,
    flakeMetadata: null,
    documentationState: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-04-28T00:00:00.000Z",
    updatedAt: "2026-04-28T00:00:00.000Z",
  };
}

function makeLayer(workspaceRoot: string) {
  return ProjectSecretsServiceLive.pipe(
    Layer.provideMerge(WorkspacePathsLive),
    Layer.provideMerge(
      Layer.succeed(FlakeMetadataResolver, {
        resolve: () => Effect.succeed(flakeMetadata),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (projectId) =>
          Effect.succeed(
            projectId === baseProjectId
              ? Option.some(makeProjectShell(workspaceRoot))
              : Option.none(),
          ),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

afterEach(() => {
  mockedRunProcess.mockReset();
  while (tempDirs.length > 0) {
    const cwd = tempDirs.pop();
    if (cwd) {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }
});

it.effect("maps current flake store source paths back into the workspace", () =>
  Effect.gen(function* () {
    const workspaceRoot = createWorkspace();
    mockedRunProcess.mockResolvedValueOnce({
      stdout: JSON.stringify({
        path: "/nix/store/current-flake-source",
      }),
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    mockedRunProcess.mockResolvedValueOnce({
      stdout: JSON.stringify({
        "matrix/form_secret": {
          sopsFile: "/nix/store/current-flake-source/hosts/chatserver/secrets.yaml",
        },
      }),
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    mockedRunProcess.mockResolvedValueOnce({
      stdout: "null\n",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    const result = yield* Effect.gen(function* () {
      const service = yield* ProjectSecretsService;
      return yield* service.getSummary({
        projectId: baseProjectId,
      });
    }).pipe(Effect.provide(makeLayer(workspaceRoot)));

    const inventory = result.hostInventories[0];
    expect(inventory?.secrets[0]).toEqual({
      name: "matrix/form_secret",
      encryptedSourcePath: "/nix/store/current-flake-source/hosts/chatserver/secrets.yaml",
      workspaceRelativeEncryptedSourcePath: "hosts/chatserver/secrets.yaml",
    });
    expect(inventory?.validationChecks.map((check) => check.result)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
  }),
);

it.effect("reports both evaluated and workspace paths when store paths cannot be mapped", () =>
  Effect.gen(function* () {
    const workspaceRoot = createWorkspace();
    mockedRunProcess.mockResolvedValueOnce({
      stdout: JSON.stringify({
        path: "/nix/store/current-flake-source",
      }),
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    mockedRunProcess.mockResolvedValueOnce({
      stdout: JSON.stringify({
        "matrix/form_secret": {
          sopsFile: "/nix/store/other-flake-source/hosts/chatserver/secrets.yaml",
        },
      }),
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });
    mockedRunProcess.mockResolvedValueOnce({
      stdout: "null\n",
      stderr: "",
      code: 0,
      signal: null,
      timedOut: false,
    });

    const result = yield* Effect.gen(function* () {
      const service = yield* ProjectSecretsService;
      return yield* service.getSummary({
        projectId: baseProjectId,
      });
    }).pipe(Effect.provide(makeLayer(workspaceRoot)));

    const sourceExistsCheck = result.hostInventories[0]?.validationChecks[1];
    expect(sourceExistsCheck?.result).toBe("fail");
    expect(sourceExistsCheck?.detail).toContain(
      "matrix/form_secret: source path is outside the workspace",
    );
    expect(sourceExistsCheck?.detail).toContain(
      "evaluatedPath: /nix/store/other-flake-source/hosts/chatserver/secrets.yaml",
    );
    expect(sourceExistsCheck?.detail).toContain("workspacePath: unresolved");
  }),
);
