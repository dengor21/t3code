import { describe, expect, it } from "vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { buildProviderTurnContext } from "./providerContext.ts";

const baseProject: OrchestrationProject = {
  id: ProjectId.make("project-1"),
  title: "Project",
  workspaceRoot: "/workspace/flake",
  repositoryIdentity: null,
  flakeMetadata: null,
  documentationState: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Thread",
  modelSelection: {
    provider: "codex",
    model: "gpt-5.3-codex",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  designer: null,
  scopedHostName: null,
  workflow: null,
  changeTracking: null,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};

describe("buildProviderTurnContext", () => {
  it("returns generic context for non-flake threads", () => {
    expect(
      buildProviderTurnContext({
        project: baseProject,
        thread: baseThread,
      }),
    ).toEqual({
      projectKind: "generic",
      workspaceRoot: "/workspace/flake",
    });
  });

  it("includes scoped host name even when the project is not flake-backed", () => {
    expect(
      buildProviderTurnContext({
        project: baseProject,
        thread: {
          ...baseThread,
          scopedHostName: "nexus",
        },
      }),
    ).toEqual({
      projectKind: "generic",
      workspaceRoot: "/workspace/flake",
      scopedHostName: "nexus",
    });
  });

  it("returns flake context for flake-backed projects", () => {
    expect(
      buildProviderTurnContext({
        project: {
          ...baseProject,
          flakeMetadata: {
            host: null,
            hosts: [
              {
                name: "nexus",
                target: "10.0.0.10",
              },
              {
                name: "router",
                target: "10.0.0.11",
              },
            ],
            source: "parsed-flake",
            flakePath: "flake.nix",
            diagnostics: [],
          },
        },
        thread: baseThread,
      }),
    ).toEqual({
      projectKind: "nix-flake",
      workspaceRoot: "/workspace/flake",
      flake: {
        flakePath: "flake.nix",
        hostNames: ["nexus", "router"],
        documentationPaths: {
          generalChanges: ".t3code/changes.md",
        },
      },
    });
  });

  it("adds host documentation path for scoped host threads", () => {
    expect(
      buildProviderTurnContext({
        project: {
          ...baseProject,
          flakeMetadata: {
            host: null,
            hosts: [],
            source: "error",
            flakePath: "flake.nix",
            diagnostics: ["eval failed"],
          },
        },
        thread: {
          ...baseThread,
          scopedHostName: "bc250",
        },
      }),
    ).toEqual({
      projectKind: "nix-flake",
      workspaceRoot: "/workspace/flake",
      scopedHostName: "bc250",
      flake: {
        flakePath: "flake.nix",
        hostFlakeAttr: "nixosConfigurations.bc250",
        documentationPaths: {
          generalChanges: ".t3code/changes.md",
          hostDoc: ".t3code/docs/hosts/bc250.md",
        },
      },
    });
  });

  it("derives scoped provider context from a host designer when scopedHostName is absent", () => {
    expect(
      buildProviderTurnContext({
        project: {
          ...baseProject,
          flakeMetadata: {
            host: null,
            hosts: [
              {
                name: "nexus",
                target: "root@nexus",
                type: "nixos",
              },
            ],
            source: "parsed-flake",
            flakePath: "flake.nix",
            diagnostics: [],
          },
        },
        thread: {
          ...baseThread,
          designer: {
            kind: "host",
            hostName: "nexus",
          },
        },
      }),
    ).toEqual({
      projectKind: "nix-flake",
      workspaceRoot: "/workspace/flake",
      scopedHostName: "nexus",
      flake: {
        flakePath: "flake.nix",
        hostNames: ["nexus"],
        hostFlakeAttr: "nixosConfigurations.nexus",
        documentationPaths: {
          generalChanges: ".t3code/changes.md",
          hostDoc: ".t3code/docs/hosts/nexus.md",
        },
      },
    });
  });

  it("includes host-creation workflow metadata for workflow threads", () => {
    expect(
      buildProviderTurnContext({
        project: baseProject,
        thread: {
          ...baseThread,
          scopedHostName: "nexus",
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
      }),
    ).toEqual({
      projectKind: "generic",
      workspaceRoot: "/workspace/flake",
      scopedHostName: "nexus",
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
    });
  });

  it("includes host-removal workflow metadata for workflow threads", () => {
    expect(
      buildProviderTurnContext({
        project: baseProject,
        thread: {
          ...baseThread,
          scopedHostName: "nexus",
          workflow: {
            kind: "host-removal",
            hostName: "nexus",
            target: "root@nexus",
            hostType: "server",
            status: "planning",
          },
        },
      }),
    ).toEqual({
      projectKind: "generic",
      workspaceRoot: "/workspace/flake",
      scopedHostName: "nexus",
      workflow: {
        kind: "host-removal",
        hostName: "nexus",
        target: "root@nexus",
        hostType: "server",
        status: "planning",
      },
    });
  });
});
