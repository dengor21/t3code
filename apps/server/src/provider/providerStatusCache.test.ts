import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ServerProvider } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import {
  hydrateCachedProvider,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";

const makeProvider = (
  provider: ServerProvider["provider"],
  overrides?: Partial<ServerProvider>,
): ServerProvider => ({
  provider,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-11T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

it.layer(NodeServices.layer)("providerStatusCache", (it) => {
  it.effect("writes and reads provider status snapshots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-" });
      const codexProvider = makeProvider("codex");
      const claudeProvider = makeProvider("claudeAgent", {
        status: "warning",
        auth: { status: "unknown" },
      });
      const openCodeProvider = makeProvider("opencode", {
        status: "warning",
        auth: { status: "unknown", type: "opencode" },
      });
      const codexPath = resolveProviderStatusCachePath({
        cacheDir: tempDir,
        provider: "codex",
      });
      const claudePath = resolveProviderStatusCachePath({
        cacheDir: tempDir,
        provider: "claudeAgent",
      });
      const openCodePath = resolveProviderStatusCachePath({
        cacheDir: tempDir,
        provider: "opencode",
      });

      yield* writeProviderStatusCache({
        filePath: codexPath,
        provider: codexProvider,
      });
      yield* writeProviderStatusCache({
        filePath: claudePath,
        provider: claudeProvider,
      });
      yield* writeProviderStatusCache({
        filePath: openCodePath,
        provider: openCodeProvider,
      });

      assert.deepStrictEqual(yield* readProviderStatusCache(codexPath), codexProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(claudePath), claudeProvider);
      assert.deepStrictEqual(yield* readProviderStatusCache(openCodePath), openCodeProvider);
    }),
  );

  it.effect("uses unique temp paths when the same cache file is written concurrently", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-provider-cache-race-" });
      const filePath = resolveProviderStatusCachePath({
        cacheDir: tempDir,
        provider: "claudeAgent",
      });
      const originalDateNow = Date.now;
      Date.now = () => 1_776_607_307_129;

      try {
        const readyProvider = makeProvider("claudeAgent", {
          status: "ready",
          auth: { status: "authenticated" },
        });
        const warningProvider = makeProvider("claudeAgent", {
          status: "warning",
          auth: { status: "unknown" },
        });

        yield* Effect.all(
          [
            writeProviderStatusCache({
              filePath,
              provider: readyProvider,
            }),
            writeProviderStatusCache({
              filePath,
              provider: warningProvider,
            }),
          ],
          { concurrency: "unbounded" },
        );

        const cached = yield* readProviderStatusCache(filePath);
        assert.isDefined(cached);
        assert.strictEqual(cached?.provider, "claudeAgent");
        assert.ok(cached?.status === "ready" || cached?.status === "warning");
      } finally {
        Date.now = originalDateNow;
      }
    }),
  );

  it("hydrates cached provider status onto current settings-derived models", () => {
    const cachedCodex = makeProvider("codex", {
      checkedAt: "2026-04-10T12:00:00.000Z",
      models: [
        {
          slug: "gpt-5-mini",
          name: "GPT-5 Mini",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [],
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ],
      message: "Cached message",
      skills: [
        {
          name: "github:gh-fix-ci",
          path: "/tmp/skills/gh-fix-ci/SKILL.md",
          enabled: true,
          displayName: "CI Debug",
        },
      ],
    });
    const fallbackCodex = makeProvider("codex", {
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          capabilities: {
            reasoningEffortLevels: [],
            supportsFastMode: false,
            supportsThinkingToggle: false,
            contextWindowOptions: [],
            promptInjectedEffortLevels: [],
          },
        },
      ],
      message: "Pending refresh",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: fallbackCodex,
      }),
      {
        ...fallbackCodex,
        models: [
          ...fallbackCodex.models,
          {
            slug: "gpt-5-mini",
            name: "GPT-5 Mini",
            isCustom: false,
            capabilities: {
              reasoningEffortLevels: [],
              supportsFastMode: false,
              supportsThinkingToggle: false,
              contextWindowOptions: [],
              promptInjectedEffortLevels: [],
            },
          },
        ],
        installed: cachedCodex.installed,
        version: cachedCodex.version,
        status: cachedCodex.status,
        auth: cachedCodex.auth,
        checkedAt: cachedCodex.checkedAt,
        slashCommands: cachedCodex.slashCommands,
        skills: cachedCodex.skills,
        message: cachedCodex.message,
      },
    );
  });

  it("ignores stale cached enabled state when the provider is now disabled", () => {
    const cachedCodex = makeProvider("codex", {
      checkedAt: "2026-04-10T12:00:00.000Z",
      message: "Cached ready status",
    });
    const disabledFallback = makeProvider("codex", {
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      message: "Codex is disabled in HAL settings.",
    });

    assert.deepStrictEqual(
      hydrateCachedProvider({
        cachedProvider: cachedCodex,
        fallbackProvider: disabledFallback,
      }),
      disabledFallback,
    );
  });
});
