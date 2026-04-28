import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

describe("CodexDeveloperInstructions", () => {
  it("adds explicit host-scope guidance for host-scoped threads", () => {
    const instructions = buildCodexDeveloperInstructions({
      interactionMode: "default",
      providerContext: {
        projectKind: "generic",
        remoteHostAccessPolicy: "hal-managed-only",
        scopedHostName: "nexus",
      },
    });

    assert.ok(instructions.includes("Host scope:"));
    assert.ok(instructions.includes("This thread is scoped to host nexus."));
    assert.ok(instructions.includes("HAL runtime scope is authoritative"));
    assert.ok(instructions.includes("call hal_current_scope"));
    assert.ok(instructions.includes("The scoped host is the default"));
    assert.ok(instructions.includes("require scope expansion or approval"));
    assert.ok(instructions.includes("Remote host access rules:"));
    assert.ok(instructions.includes("Do not initiate direct remote host access from chat."));
    assert.ok(
      instructions.includes(
        "Use HAL deployment actions instead of remote shell deployment commands.",
      ),
    );
  });

  it("adds flake-creation workflow guidance when present", () => {
    const instructions = buildCodexDeveloperInstructions({
      interactionMode: "plan",
      providerContext: {
        projectKind: "nix-flake",
        remoteHostAccessPolicy: "hal-managed-only",
        flake: {
          documentationPaths: {
            repoStyle: ".hal/repo-style.json",
          },
        },
        workflow: {
          kind: "flake-creation",
          hostScale: "2-5",
          platformMatrix: "mixed",
          homeManager: true,
          moduleStyle: "explicit-modules",
          moduleNamespace: "shared",
          layoutPattern: "shared-modules",
          status: "planning",
        },
      },
    });

    assert.ok(instructions.includes("This thread is running the flake-creation workflow"));
    assert.ok(instructions.includes("HAL deploy actions available in this session:"));
    assert.ok(instructions.includes("hal_open_host_deploy_dialog"));
    assert.ok(instructions.includes("hal_open_fleet_rollout"));
    assert.ok(
      instructions.includes(
        "These are HAL client actions, not local CLI commands or MCP resources.",
      ),
    );
    assert.ok(instructions.includes("HAL already bootstrapped a minimal flake"));
    assert.ok(instructions.includes("Consult repo style guidance at .hal/repo-style.json."));
    assert.ok(
      instructions.includes(
        "The repo style guide defines the local halHosts and deploy.nodes bootstrap contract.",
      ),
    );
    assert.ok(instructions.includes("Selected layout pattern: shared-modules."));
  });
});
