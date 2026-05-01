import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { buildSidebarProjectSnapshots } from "./sidebarProjectGrouping";
import type { Project } from "./types";

function environmentId(value: string): EnvironmentId {
  return value as EnvironmentId;
}

function projectId(value: string): ProjectId {
  return value as ProjectId;
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: projectId("project-1"),
    environmentId: environmentId("local"),
    name: "Test Project",
    cwd: "/repo",
    repositoryIdentity: null,
    flakeMetadata: null,
    documentationState: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

const repositoryGroupingSettings = {
  sidebarProjectGroupingMode: "repository",
  sidebarProjectGroupingOverrides: {},
} as const;

describe("buildSidebarProjectSnapshots", () => {
  it("returns one sidebar snapshot for one project", () => {
    const snapshots = buildSidebarProjectSnapshots({
      projects: [
        project({
          id: projectId("project-local"),
          environmentId: environmentId("local"),
          name: "Local Project",
          cwd: "/repo",
        }),
      ],
      settings: repositoryGroupingSettings,
      primaryEnvironmentId: environmentId("local"),
      resolveEnvironmentLabel: (environmentId) => (environmentId === "local" ? "Local" : "Remote"),
    });

    expect(snapshots).toHaveLength(1);

    expect(snapshots[0]).toMatchObject({
      id: projectId("project-local"),
      environmentId: environmentId("local"),
      name: "Local Project",
      projectKey: "local:/repo",
      displayName: "Local Project",
      groupedProjectCount: 1,
      environmentPresence: "local-only",
      remoteEnvironmentLabels: [],
    });

    expect(snapshots[0]?.memberProjects).toHaveLength(1);
    expect(snapshots[0]?.memberProjectRefs).toEqual([
      {
        environmentId: environmentId("local"),
        projectId: projectId("project-local"),
      },
    ]);
  });

  it("groups local and remote projects that share a repository identity", () => {
    const snapshots = buildSidebarProjectSnapshots({
      projects: [
        project({
          id: projectId("project-local"),
          environmentId: environmentId("local"),
          name: "Local Checkout",
          cwd: "/Users/me/t3code",
          repositoryIdentity: {
            canonicalKey: "github:dengor21/t3code",
            name: "t3code",
            displayName: "t3code",
            rootPath: "/Users/me/t3code",
            locator: {
              source: "git-remote",
              remoteName: "Remote Checkout",
              remoteUrl: "https://github.com/dengor21/t3code",
            },
          },
        }),
        project({
          id: projectId("project-remote"),
          environmentId: environmentId("remote"),
          name: "Remote Checkout",
          cwd: "/home/me/t3code",
          repositoryIdentity: {
            canonicalKey: "github:dengor21/t3code",
            name: "t3code",
            displayName: "t3code",
            rootPath: "/home/me/t3code",
            locator: {
              source: "git-remote",
              remoteName: "Remote Checkout",
              remoteUrl: "https://github.com/dengor21/t3code",
            },
          },
        }),
      ],
      settings: repositoryGroupingSettings,
      primaryEnvironmentId: environmentId("local"),
      resolveEnvironmentLabel: (environmentId) =>
        environmentId === "local" ? "Local" : "Remote VM",
    });

    expect(snapshots).toHaveLength(1);

    expect(snapshots[0]).toMatchObject({
      id: projectId("project-local"),
      environmentId: environmentId("local"),
      projectKey: "github:dengor21/t3code",
      displayName: "t3code",
      groupedProjectCount: 2,
      environmentPresence: "mixed",
      remoteEnvironmentLabels: ["Remote VM"],
    });

    expect(snapshots[0]?.memberProjectRefs).toEqual([
      {
        environmentId: environmentId("local"),
        projectId: projectId("project-local"),
      },
      {
        environmentId: environmentId("remote"),
        projectId: projectId("project-remote"),
      },
    ]);
  });

  it("uses the first project as representative when there is no primary environment", () => {
    const snapshots = buildSidebarProjectSnapshots({
      projects: [
        project({
          id: projectId("project-remote-a"),
          environmentId: environmentId("remote-a"),
          name: "Remote A",
          cwd: "/repo-a",
          repositoryIdentity: {
            canonicalKey: "repo-key",
            name: "repo",
            displayName: "Repo",
            rootPath: "/repo-a",
            locator: {
              source: "git-remote",
              remoteName: "Remote A",
              remoteUrl: "https://example.org/project-a",
            },
          },
        }),
        project({
          id: projectId("project-remote-b"),
          environmentId: environmentId("remote-b"),
          name: "Remote B",
          cwd: "/repo-b",
          repositoryIdentity: {
            canonicalKey: "repo-key",
            name: "repo",
            displayName: "Repo",
            rootPath: "/repo-b",
            locator: {
              source: "git-remote",
              remoteName: "Remote B",
              remoteUrl: "https://example.org/project-b",
            },
          },
        }),
      ],
      settings: repositoryGroupingSettings,
      primaryEnvironmentId: null,
      resolveEnvironmentLabel: () => "Remote",
    });

    expect(snapshots).toHaveLength(1);

    expect(snapshots[0]).toMatchObject({
      id: projectId("project-remote-a"),
      environmentId: environmentId("remote-a"),
      displayName: "Repo",
      groupedProjectCount: 2,
      environmentPresence: "local-only",
    });
  });
});
