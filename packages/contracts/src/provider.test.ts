import { describe, expect, it } from "vitest";
import { Schema } from "effect";

import { ProviderSendTurnInput, ProviderSessionStartInput } from "./provider.ts";

const decodeProviderSessionStartInput = Schema.decodeUnknownSync(ProviderSessionStartInput);
const decodeProviderSendTurnInput = Schema.decodeUnknownSync(ProviderSendTurnInput);

describe("ProviderSessionStartInput", () => {
  it("accepts codex-compatible payloads", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "high",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
    });
    expect(parsed.runtimeMode).toBe("full-access");
    expect(parsed.modelSelection?.provider).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    if (parsed.modelSelection?.provider !== "codex") {
      throw new Error("Expected codex modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("high");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });

  it("rejects payloads without runtime mode", () => {
    expect(() =>
      decodeProviderSessionStartInput({
        threadId: "thread-1",
        provider: "codex",
      }),
    ).toThrow();
  });

  it("accepts claude runtime knobs", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "claudeAgent",
      cwd: "/tmp/workspace",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          thinking: true,
          effort: "max",
          fastMode: true,
        },
      },
      runtimeMode: "full-access",
    });
    expect(parsed.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    expect(parsed.modelSelection?.model).toBe("claude-sonnet-4-6");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.thinking).toBe(true);
    expect(parsed.modelSelection.options?.effort).toBe("max");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
    expect(parsed.runtimeMode).toBe("full-access");
  });

  it("accepts cursor provider", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "cursor",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      modelSelection: {
        provider: "cursor",
        model: "composer-2",
        options: { fastMode: true },
      },
    });
    expect(parsed.provider).toBe("cursor");
    expect(parsed.modelSelection?.provider).toBe("cursor");
    expect(parsed.modelSelection?.model).toBe("composer-2");
    if (parsed.modelSelection?.provider === "cursor") {
      expect(parsed.modelSelection.options?.fastMode).toBe(true);
    }
  });

  it("accepts MCP server descriptors and remains backward compatible when omitted", () => {
    const parsed = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      cwd: "/tmp/workspace",
      runtimeMode: "full-access",
      mcpServers: [
        {
          id: "nix-designer",
          transport: "stdio",
          command: "bun",
          args: ["run", "nix-mcp-server"],
          env: {
            T3_NIX_INDEX_DIR: "/tmp/index",
          },
        },
      ],
    });

    expect(parsed.mcpServers).toEqual([
      {
        id: "nix-designer",
        transport: "stdio",
        command: "bun",
        args: ["run", "nix-mcp-server"],
        env: {
          T3_NIX_INDEX_DIR: "/tmp/index",
        },
      },
    ]);

    const withoutMcpServers = decodeProviderSessionStartInput({
      threadId: "thread-1",
      provider: "codex",
      runtimeMode: "full-access",
    });
    expect(withoutMcpServers.mcpServers).toBeUndefined();
  });
});

describe("ProviderSendTurnInput", () => {
  it("accepts codex modelSelection", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "codex",
        model: "gpt-5.3-codex",
        options: {
          reasoningEffort: "xhigh",
          fastMode: true,
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("codex");
    expect(parsed.modelSelection?.model).toBe("gpt-5.3-codex");
    if (parsed.modelSelection?.provider !== "codex") {
      throw new Error("Expected codex modelSelection");
    }
    expect(parsed.modelSelection.options?.reasoningEffort).toBe("xhigh");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });

  it("accepts claude modelSelection including ultrathink", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      modelSelection: {
        provider: "claudeAgent",
        model: "claude-sonnet-4-6",
        options: {
          effort: "ultrathink",
          fastMode: true,
        },
      },
    });

    expect(parsed.modelSelection?.provider).toBe("claudeAgent");
    if (parsed.modelSelection?.provider !== "claudeAgent") {
      throw new Error("Expected claude modelSelection");
    }
    expect(parsed.modelSelection.options?.effort).toBe("ultrathink");
    expect(parsed.modelSelection.options?.fastMode).toBe(true);
  });

  it("accepts provider turn context for flake-backed host threads", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      providerContext: {
        projectKind: "nix-flake",
        workspaceRoot: "/workspace/flake",
        remoteHostAccessPolicy: "hal-managed-only",
        scopedHostName: "nexus",
        flake: {
          flakePath: "flake.nix",
          hostNames: ["nexus", "router"],
          documentationPaths: {
            generalChanges: ".hal/changes.md",
            hostDoc: ".hal/docs/hosts/nexus.md",
          },
        },
        workflow: {
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          bootstrapMode: "existing-via-ssh",
          sourceSshTarget: "root@nexus.example",
          hostType: "server",
          status: "planning",
        },
      },
    });

    expect(parsed.providerContext?.projectKind).toBe("nix-flake");
    expect(parsed.providerContext?.workspaceRoot).toBe("/workspace/flake");
    expect(parsed.providerContext?.remoteHostAccessPolicy).toBe("hal-managed-only");
    expect(parsed.providerContext?.scopedHostName).toBe("nexus");
    expect(parsed.providerContext?.flake?.flakePath).toBe("flake.nix");
    expect(parsed.providerContext?.flake?.hostNames).toEqual(["nexus", "router"]);
    expect(parsed.providerContext?.flake?.documentationPaths?.generalChanges).toBe(
      ".hal/changes.md",
    );
    expect(parsed.providerContext?.flake?.documentationPaths?.hostDoc).toBe(
      ".hal/docs/hosts/nexus.md",
    );
    expect(parsed.providerContext?.workflow).toEqual({
      kind: "host-creation",
      hostName: "nexus",
      target: "nexus",
      osFamily: "nixos",
      bootstrapMode: "existing-via-ssh",
      sourceSshTarget: "root@nexus.example",
      hostType: "server",
      status: "planning",
    });
  });

  it("accepts host-removal workflow context payloads", () => {
    const parsed = decodeProviderSendTurnInput({
      threadId: "thread-1",
      providerContext: {
        scopedHostName: "nexus",
        workflow: {
          kind: "host-removal",
          hostName: "nexus",
          target: "root@nexus",
          hostType: "server",
          status: "planning",
        },
      },
    });

    expect(parsed.providerContext?.workflow).toEqual({
      kind: "host-removal",
      hostName: "nexus",
      target: "root@nexus",
      hostType: "server",
      status: "planning",
    });
  });

  it("rejects malformed workflow context payloads", () => {
    expect(() =>
      decodeProviderSendTurnInput({
        threadId: "thread-1",
        providerContext: {
          workflow: {
            kind: "host-creation",
            hostName: "nexus",
            osFamily: "linux",
          },
        },
      }),
    ).toThrow();
  });
});
