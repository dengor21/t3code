import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { type FlakeMetadata } from "@t3tools/contracts";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { DocumentationStatusResolver } from "../Services/DocumentationStatusResolver.ts";
import { HostDocumentationGenerationRegistry } from "../Services/HostDocumentationGenerationRegistry.ts";
import { DocumentationStatusResolverLive } from "./DocumentationStatusResolver.ts";
import { HostDocumentationGenerationRegistryLive } from "./HostDocumentationGenerationRegistry.ts";

describe("DocumentationStatusResolver", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const tempDir of tempDirs) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("preserves access to the generation registry after the layer is built", async () => {
    const workspaceRoot = mkdtempSync(path.join(os.tmpdir(), "t3-doc-status-resolver-"));
    tempDirs.add(workspaceRoot);

    mkdirSync(path.join(workspaceRoot, ".t3code/docs/hosts"), { recursive: true });
    writeFileSync(
      path.join(workspaceRoot, ".t3code/docs/hosts/mediaserver.md"),
      `---
kind: host-doc
host: mediaserver
target: mediaserver
generatedAt: 2026-04-19T14:26:33.167Z
coversChangesThrough: 2026-04-18T20:54:26.144Z
---

# Host: mediaserver
`,
      "utf8",
    );

    const flakeMetadata: FlakeMetadata = {
      source: "parsed-flake",
      flakePath: path.join(workspaceRoot, "flake.nix"),
      host: null,
      hosts: [
        {
          name: "mediaserver",
          target: "mediaserver",
          system: "x86_64-linux",
          type: "nixos",
        },
      ],
      diagnostics: [],
    };

    const registryLayer = HostDocumentationGenerationRegistryLive;
    const runtimeLayer = Layer.mergeAll(
      registryLayer,
      DocumentationStatusResolverLive.pipe(Layer.provideMerge(registryLayer)),
    );

    const harness = await Effect.runPromise(
      Effect.gen(function* () {
        return {
          registry: yield* HostDocumentationGenerationRegistry,
          resolver: yield* DocumentationStatusResolver,
        };
      }).pipe(Effect.provide(runtimeLayer)),
    );

    await Effect.runPromise(
      harness.registry.ensureJob({
        hostName: "mediaserver",
        workspaceRoot,
      }),
    );

    const result = await Effect.runPromise(
      harness.resolver.resolve({
        workspaceRoot,
        flakeMetadata,
      }),
    );

    expect(result.hosts).toHaveLength(1);
    expect(result.hosts[0]?.status).toBe("generating");
  });
});
