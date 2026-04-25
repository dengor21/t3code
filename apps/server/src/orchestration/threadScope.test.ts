import { describe, expect, it } from "vitest";
import {
  ProjectId,
  ThreadId,
  type OrchestrationProject,
  type OrchestrationThread,
} from "@t3tools/contracts";

import { resolveEffectiveDesigner, resolveThreadScope } from "./threadScope.ts";

const project: OrchestrationProject = {
  id: ProjectId.make("project-1"),
  title: "Infra",
  workspaceRoot: "/srv/infra",
  repositoryIdentity: null,
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
  documentationState: {
    docsRoot: ".t3code/docs/hosts",
    legacyDocsDetected: false,
    hosts: [
      {
        hostName: "nexus",
        docPath: ".t3code/docs/hosts/nexus.md",
        status: "current",
        generatedAt: "2026-01-01T00:00:00.000Z",
        coversChangesThrough: null,
        latestRelevantChangeAt: null,
      },
    ],
  },
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
};

const baseThread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: project.id,
  title: "Thread",
  modelSelection: {
    provider: "codex",
    model: "gpt-5-codex",
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

describe("threadScope", () => {
  it("prefers scopedHostName as the authoritative host scope", () => {
    expect(
      resolveThreadScope({
        project,
        thread: {
          ...baseThread,
          designer: { kind: "host", hostName: "router" },
          scopedHostName: "nexus",
        },
      }),
    ).toEqual({
      kind: "host",
      projectId: "project-1",
      workspaceRoot: "/srv/infra",
      hostName: "nexus",
      locked: true,
      source: "scopedHostName",
      flakeAttr: "nixosConfigurations.nexus",
      hostDocPath: ".t3code/docs/hosts/nexus.md",
      deployTarget: "root@nexus",
    });
  });

  it("resolves a host designer when scopedHostName is absent", () => {
    expect(
      resolveThreadScope({
        project,
        thread: {
          ...baseThread,
          designer: { kind: "host", hostName: "nexus" },
        },
      }),
    ).toMatchObject({
      kind: "host",
      hostName: "nexus",
      source: "designer",
      locked: true,
    });
  });

  it("rejects a requested designer that conflicts with scopedHostName", () => {
    expect(() =>
      resolveEffectiveDesigner({
        thread: {
          ...baseThread,
          scopedHostName: "nexus",
        },
        requestedDesigner: { kind: "project" },
      }),
    ).toThrow("scoped to host 'nexus'");
  });
});
