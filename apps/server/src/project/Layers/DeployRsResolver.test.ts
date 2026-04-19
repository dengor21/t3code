import { chmod, writeFile as writeFileNode } from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { buildDeployRsCommand } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";

import { DeployRsResolver } from "../Services/DeployRsResolver.ts";
import { makeDeployRsResolver } from "./DeployRsResolver.ts";

const writeExecutable = (path: string, contents: string) =>
  Effect.promise(async () => {
    await writeFileNode(path, contents, { encoding: "utf8", mode: 0o755 });
    await chmod(path, 0o755);
  });

const makeDeployRsResolverTestLayer = (nixCommand: string) =>
  Layer.effect(
    DeployRsResolver,
    makeDeployRsResolver({
      cacheCapacity: 16,
      nixCommand,
    }),
  );

it.layer(NodeServices.layer)("DeployRsResolver", (it) => {
  it.effect("marks hosts deployable when deploy.nodes includes the host", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-deploy-rs-resolver-" });
      const fakeNixPath = `${cwd}/fake-nix`;

      yield* writeExecutable(
        fakeNixPath,
        `#!/bin/sh
if [ "$1" = "eval" ] && [ "$2" = "--json" ] && [ "$3" = ".#deploy.nodes" ]; then
  printf '%s' '{"bc250":{},"thinkpad":{}}'
  exit 0
fi
echo "unexpected invocation" >&2
exit 1
`,
      );

      const resolver = yield* Effect.service(DeployRsResolver).pipe(
        Effect.provide(makeDeployRsResolverTestLayer(fakeNixPath)),
      );
      const result = yield* resolver.resolveHostDeployments({
        workspaceRoot: cwd,
        hosts: [
          { name: "bc250", target: "bc250" },
          { name: "nexus", target: "10.0.0.115" },
        ],
      });

      expect(result.get("bc250")).toEqual({
        status: "deployable",
        reason: null,
        command: buildDeployRsCommand("bc250"),
      });
      expect(result.get("nexus")).toEqual({
        status: "unavailable",
        reason: "missing-deploy-target",
        command: null,
      });
    }),
  );

  it.effect("marks all hosts unavailable when deploy-rs evaluation fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-deploy-rs-resolver-failure-",
      });
      const fakeNixPath = `${cwd}/fake-nix`;

      yield* writeExecutable(
        fakeNixPath,
        `#!/bin/sh
echo "attribute 'deploy' missing" >&2
exit 1
`,
      );

      const resolver = yield* Effect.service(DeployRsResolver).pipe(
        Effect.provide(makeDeployRsResolverTestLayer(fakeNixPath)),
      );
      const result = yield* resolver.resolveHostDeployments({
        workspaceRoot: cwd,
        hosts: [
          { name: "bc250", target: "bc250" },
          { name: "nexus", target: "10.0.0.115" },
        ],
      });

      expect(result.get("bc250")).toEqual({
        status: "unavailable",
        reason: "evaluation-failed",
        command: null,
      });
      expect(result.get("nexus")).toEqual({
        status: "unavailable",
        reason: "evaluation-failed",
        command: null,
      });
    }),
  );
});
