import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  buildDeployRsCommand,
  buildDeployRsInvocation,
  ProjectDashboardContentResult,
  ProjectRebuildNixDesignerIndexResult,
} from "./project.ts";

const decodeProjectDashboardContentResult = Schema.decodeUnknownSync(ProjectDashboardContentResult);
const decodeProjectRebuildNixDesignerIndexResult = Schema.decodeUnknownSync(
  ProjectRebuildNixDesignerIndexResult,
);

describe("buildDeployRsCommand", () => {
  it("builds the default remote-build command", () => {
    expect(buildDeployRsCommand("nexus")).toBe(
      "nix run github:serokell/deploy-rs -- --skip-checks --remote-build .#nexus",
    );
  });

  it("supports deploy-rs verification overrides", () => {
    expect(
      buildDeployRsCommand("nexus", {
        magicRollback: true,
        confirmTimeoutSeconds: 180,
      }),
    ).toBe(
      "nix run github:serokell/deploy-rs -- --skip-checks --remote-build --magic-rollback true --confirm-timeout 180 .#nexus",
    );
  });

  it("omits confirm-timeout when magic rollback is disabled", () => {
    expect(
      buildDeployRsCommand("nexus", {
        magicRollback: false,
        confirmTimeoutSeconds: 180,
      }),
    ).toBe(
      "nix run github:serokell/deploy-rs -- --skip-checks --remote-build --magic-rollback false .#nexus",
    );
  });

  it("supports server-side deploys with magic rollback disabled", () => {
    expect(
      buildDeployRsCommand("nexus", {
        deployOnServer: true,
        magicRollback: false,
      }),
    ).toBe("nix run github:serokell/deploy-rs -- --magic-rollback false .#nexus");
  });

  it("supports staging a deployment for next boot", () => {
    expect(
      buildDeployRsCommand("nexus", {
        activationStrategy: "boot",
      }),
    ).toBe("nix run github:serokell/deploy-rs -- --skip-checks --remote-build --boot .#nexus");
  });

  it("builds a dry-activation invocation for live switch previews", () => {
    expect(
      buildDeployRsInvocation("nexus", {
        dryActivate: true,
        activationStrategy: "switch",
      }),
    ).toEqual({
      command: "nix",
      args: [
        "run",
        "github:serokell/deploy-rs",
        "--",
        "--skip-checks",
        "--remote-build",
        "--dry-activate",
        ".#nexus",
      ],
    });
  });

  it("decodes dashboard content with nix designer status", () => {
    const parsed = decodeProjectDashboardContentResult({
      mode: "flake",
      selectedHostName: null,
      flakeSource: {
        path: "flake.nix",
        language: "nix",
        contents: "{ }",
      },
      nixDesigner: {
        status: "ready",
        revision: "4bd9165a9165d7b5e33ae57f3eecbcb28fb231c9",
        builtAt: "2026-01-01T00:00:00.000Z",
        optionCount: 123,
        packageCount: 456,
        lastError: null,
        staleReason: null,
      },
      generalChanges: [],
      hostChanges: [],
      hostDoc: null,
      hostSummaries: [],
      latestMaintenance: null,
      secrets: null,
    });

    expect(parsed.nixDesigner.status).toBe("ready");
    expect(parsed.nixDesigner.optionCount).toBe(123);
  });

  it("decodes nix designer rebuild results", () => {
    const parsed = decodeProjectRebuildNixDesignerIndexResult({
      status: "stale",
      revision: "4bd9165a9165d7b5e33ae57f3eecbcb28fb231c9",
      builtAt: null,
      optionCount: 0,
      packageCount: 0,
      lastError: null,
      staleReason: "revision-changed",
    });

    expect(parsed.status).toBe("stale");
    expect(parsed.staleReason).toBe("revision-changed");
  });
});
