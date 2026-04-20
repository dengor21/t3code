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
  scopedHostName: null,
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
        documentationPaths: {
          generalChanges: ".t3code/changes.md",
          hostDoc: ".t3code/docs/hosts/bc250.md",
        },
      },
    });
  });
});
