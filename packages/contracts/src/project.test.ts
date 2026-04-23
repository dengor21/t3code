import { describe, expect, it } from "vitest";

import { buildDeployRsCommand } from "./project.ts";

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
});
