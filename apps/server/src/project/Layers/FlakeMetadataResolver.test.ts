import { realpathSync } from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, FileSystem, Layer } from "effect";
import { writeFile as writeFileNode } from "node:fs/promises";
import { TestClock } from "effect/testing";

import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";
import { makeFlakeMetadataResolver, FlakeMetadataResolverLive } from "./FlakeMetadataResolver.ts";

const makeFlakeMetadataResolverTestLayer = (options: {
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly nixCommand?: string;
}) =>
  Layer.effect(
    FlakeMetadataResolver,
    makeFlakeMetadataResolver({
      cacheCapacity: 16,
      ...options,
    }),
  );

const writeFile = (path: string, contents: string) =>
  Effect.promise(async () => {
    await writeFileNode(path, contents, "utf8");
  });

it.layer(NodeServices.layer)("FlakeMetadataResolverLive", (it) => {
  it.effect("reads host metadata from nix eval when the flake exports t3code.host", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-flake-metadata-nix-" });

      yield* writeFile(
        `${cwd}/flake.nix`,
        `{
  description = "test";

  outputs = { self }: {
    t3code.host = {
      name = "web-01";
      target = "192.168.1.10";
      sshUser = "deployer";
      activationUser = "root";
    };
  };
}
`,
      );

      const resolver = yield* FlakeMetadataResolver;
      const metadata = yield* resolver.resolve(cwd);

      expect(["nix-eval", "parsed-flake"]).toContain(metadata.source);
      expect(metadata.host).toEqual({
        name: "web-01",
        target: "192.168.1.10",
        sshUser: "deployer",
        activationUser: "root",
      });
      expect(metadata.hosts).toEqual([
        {
          name: "web-01",
          target: "192.168.1.10",
          sshUser: "deployer",
          activationUser: "root",
        },
      ]);
      expect(normalizePath(metadata.flakePath)).toBe(normalizePath(`${cwd}/flake.nix`));
    }).pipe(Effect.provide(FlakeMetadataResolverLive)),
  );

  it.effect("falls back to parsing flake.nix when nix eval is unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-flake-metadata-fallback-",
      });

      yield* writeFile(
        `${cwd}/flake.nix`,
        `{
  outputs = { self }: {
    t3code.host = {
      name = "db-01";
      target = "db.internal";
    };
  };
}
`,
      );

      const resolver = yield* FlakeMetadataResolver;
      const metadata = yield* resolver.resolve(cwd);

      expect(metadata.source).toBe("parsed-flake");
      expect(metadata.host).toEqual({
        name: "db-01",
        target: "db.internal",
      });
      expect(metadata.hosts).toEqual([
        {
          name: "db-01",
          target: "db.internal",
        },
      ]);
      expect(metadata.diagnostics).toEqual([]);
    }).pipe(
      Effect.provide(
        makeFlakeMetadataResolverTestLayer({
          nixCommand: "__missing_nix__",
        }),
      ),
    ),
  );

  it.effect("reads multiple hosts from t3hosts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-flake-metadata-t3hosts-",
      });

      yield* writeFile(
        `${cwd}/flake.nix`,
        `{
  outputs = { self }: {
    t3hosts = {
      nexus = {
        name = "nexus";
        target = "10.0.0.115";
        sshUser = "deployer";
        activationUser = "root";
        system = "x86_64-linux";
        type = "nixos";
      };
      valhalla = {
        target = "valhalla";
        system = "aarch64-darwin";
        type = "darwin";
      };
    };
  };
}
`,
      );

      const resolver = yield* FlakeMetadataResolver;
      const metadata = yield* resolver.resolve(cwd);

      expect(metadata.source).toBe("nix-eval");
      expect(metadata.host).toBeNull();
      expect(metadata.hosts).toEqual([
        {
          name: "nexus",
          target: "10.0.0.115",
          sshUser: "deployer",
          activationUser: "root",
          system: "x86_64-linux",
          type: "nixos",
        },
        {
          name: "valhalla",
          target: "valhalla",
          system: "aarch64-darwin",
          type: "darwin",
        },
      ]);
    }).pipe(Effect.provide(FlakeMetadataResolverLive)),
  );

  it.effect("reports missing metadata when the flake has no t3code.host block", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-flake-metadata-missing-",
      });

      yield* writeFile(
        `${cwd}/flake.nix`,
        `{
  outputs = { self }: {
    packages.default = "noop";
  };
}
`,
      );

      const resolver = yield* FlakeMetadataResolver;
      const metadata = yield* resolver.resolve(cwd);

      expect(metadata.source).toBe("missing");
      expect(metadata.host).toBeNull();
      expect(metadata.hosts).toEqual([]);
      expect(metadata.diagnostics.join("\n")).toContain("No literal t3code.host block found");
      expect(metadata.diagnostics.join("\n")).toContain("No literal t3hosts block found");
    }).pipe(
      Effect.provide(
        makeFlakeMetadataResolverTestLayer({
          nixCommand: "__missing_nix__",
        }),
      ),
    ),
  );

  it.effect("keeps negative results cached until the TTL expires", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-flake-metadata-negative-cache-",
      });

      yield* writeFile(
        `${cwd}/flake.nix`,
        `{
  outputs = { self }: {
    packages.default = "noop";
  };
}
`,
      );

      const resolver = yield* FlakeMetadataResolver;
      const initial = yield* resolver.resolve(cwd);
      expect(initial.source).toBe("missing");

      yield* writeFile(
        `${cwd}/flake.nix`,
        `{
  outputs = { self }: {
    t3code.host = {
      name = "cache-refresh";
      target = "10.0.0.5";
    };
  };
}
`,
      );

      const cached = yield* resolver.resolve(cwd);
      expect(cached.source).toBe("missing");

      yield* TestClock.adjust(Duration.millis(120));

      const refreshed = yield* resolver.resolve(cwd);
      expect(refreshed.source).toBe("parsed-flake");
      expect(refreshed.host).toEqual({
        name: "cache-refresh",
        target: "10.0.0.5",
      });
      expect(refreshed.hosts).toEqual([
        {
          name: "cache-refresh",
          target: "10.0.0.5",
        },
      ]);
    }).pipe(
      Effect.provide(
        Layer.merge(
          TestClock.layer(),
          makeFlakeMetadataResolverTestLayer({
            nixCommand: "__missing_nix__",
            negativeCacheTtl: Duration.millis(50),
            positiveCacheTtl: Duration.seconds(1),
          }),
        ),
      ),
    ),
  );
});
const normalizePath = (value: string) => realpathSync.native(value).replaceAll("\\", "/");
