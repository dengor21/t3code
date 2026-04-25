import { describe, expect, it } from "vitest";

import { evaluateActionScope, type HostFilePattern } from "./scopePolicy.ts";
import type { ResolvedThreadScope } from "./threadScope.ts";

const hostScope: ResolvedThreadScope = {
  kind: "host",
  projectId: "project-1",
  workspaceRoot: "/srv/infra",
  hostName: "nexus",
  locked: true,
  source: "scopedHostName",
  flakeAttr: "nixosConfigurations.nexus",
  hostDocPath: ".t3code/docs/hosts/nexus.md",
  deployTarget: "root@nexus",
};

const hostFilePatterns: ReadonlyArray<HostFilePattern> = [
  {
    hostName: "nexus",
    patterns: ["hosts/nexus/"],
  },
  {
    hostName: "router",
    patterns: ["hosts/router/"],
  },
];

describe("scopePolicy", () => {
  it("allows deploying the scoped host when host is omitted", () => {
    expect(
      evaluateActionScope({
        scope: hostScope,
        action: {
          kind: "deploy-host",
        },
      }),
    ).toEqual({
      kind: "allow",
      resolvedHostName: "nexus",
    });
  });

  it("blocks deploying a different host", () => {
    expect(
      evaluateActionScope({
        scope: hostScope,
        action: {
          kind: "deploy-host",
          hostName: "router",
        },
      }),
    ).toMatchObject({
      kind: "block",
      requestedHostName: "router",
    });
  });

  it("allows editing scoped host files and blocks other host files", () => {
    expect(
      evaluateActionScope({
        scope: hostScope,
        action: {
          kind: "file-change",
          path: "hosts/nexus/configuration.nix",
        },
        hostFilePatterns,
      }),
    ).toEqual({
      kind: "allow",
      resolvedHostName: "nexus",
    });

    expect(
      evaluateActionScope({
        scope: hostScope,
        action: {
          kind: "file-change",
          path: "hosts/router/configuration.nix",
        },
        hostFilePatterns,
      }),
    ).toMatchObject({
      kind: "block",
      requestedHostName: "router",
    });
  });

  it("requires approval for shared configuration and fleet deploys", () => {
    expect(
      evaluateActionScope({
        scope: hostScope,
        action: {
          kind: "file-change",
          path: "modules/common/users.nix",
        },
      }).kind,
    ).toBe("require-explicit-approval");

    expect(
      evaluateActionScope({
        scope: hostScope,
        action: {
          kind: "deploy-fleet",
          hosts: ["nexus", "router"],
        },
      }).kind,
    ).toBe("require-explicit-approval");
  });
});
