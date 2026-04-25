import { describe, expect, it } from "vitest";

import { buildThreadScopeCapsule } from "./threadScopeCapsule.ts";

describe("threadScopeCapsule", () => {
  it("builds a locked host capsule", () => {
    expect(
      buildThreadScopeCapsule({
        providerContext: {
          projectKind: "nix-flake",
          workspaceRoot: "/srv/infra",
          scopedHostName: "nexus",
          flake: {
            flakePath: "flake.nix",
            hostFlakeAttr: "nixosConfigurations.nexus",
            documentationPaths: {
              generalChanges: ".t3code/changes.md",
              hostDoc: ".t3code/docs/hosts/nexus.md",
            },
          },
        },
      }),
    ).toContain("scope_status: locked");
  });

  it("builds an unlocked project capsule", () => {
    expect(
      buildThreadScopeCapsule({
        providerContext: {
          projectKind: "nix-flake",
          workspaceRoot: "/srv/infra",
          flake: {
            flakePath: "flake.nix",
          },
        },
      }),
    ).toContain("scope: project");
  });
});
