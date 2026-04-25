import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

vi.mock("~/environmentApi", () => ({
  ensureEnvironmentApi: vi.fn(),
}));

import {
  EnvironmentId,
  ProjectId,
  type ProjectDashboardContentResult,
  type ProjectDashboardNixDesigner,
} from "@t3tools/contracts";

import {
  projectDashboardContentQueryOptions,
  setProjectDashboardNixDesignerQueryData,
} from "./projectReactQuery";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const PROJECT_A = ProjectId.make("project-a");
const PROJECT_B = ProjectId.make("project-b");

const ERROR_STATUS: ProjectDashboardNixDesigner = {
  status: "error",
  revision: "rev-error",
  builtAt: "2026-01-01T00:00:00.000Z",
  optionCount: 0,
  packageCount: 0,
  lastError: "build failed",
  staleReason: null,
};

const READY_STATUS: ProjectDashboardNixDesigner = {
  status: "ready",
  revision: "rev-ready",
  builtAt: "2026-01-02T00:00:00.000Z",
  optionCount: 100,
  packageCount: 200,
  lastError: null,
  staleReason: null,
};

function makeDashboardResult(
  nixDesigner: ProjectDashboardNixDesigner,
  selectedHostName: string | null,
): ProjectDashboardContentResult {
  return {
    mode: selectedHostName ? "host" : "flake",
    selectedHostName,
    flakeSource: {
      path: "flake.nix",
      language: "nix",
      contents: "{ }",
    },
    nixDesigner,
    generalChanges: [],
    hostChanges: [],
    hostDoc: null,
    hostSummaries: [],
    latestMaintenance: null,
    secrets: null,
  };
}

describe("setProjectDashboardNixDesignerQueryData", () => {
  it("updates all dashboard cache entries for the selected project", () => {
    const queryClient = new QueryClient();
    const projectAFlakeKey = projectDashboardContentQueryOptions({
      environmentId: ENVIRONMENT_A,
      projectId: PROJECT_A,
      hostName: null,
    }).queryKey;
    const projectAHostKey = projectDashboardContentQueryOptions({
      environmentId: ENVIRONMENT_A,
      projectId: PROJECT_A,
      hostName: "web-01",
    }).queryKey;
    const projectBKey = projectDashboardContentQueryOptions({
      environmentId: ENVIRONMENT_A,
      projectId: PROJECT_B,
      hostName: null,
    }).queryKey;

    queryClient.setQueryData(projectAFlakeKey, makeDashboardResult(ERROR_STATUS, null));
    queryClient.setQueryData(projectAHostKey, makeDashboardResult(ERROR_STATUS, "web-01"));
    queryClient.setQueryData(projectBKey, makeDashboardResult(ERROR_STATUS, null));

    setProjectDashboardNixDesignerQueryData(queryClient, {
      environmentId: ENVIRONMENT_A,
      projectId: PROJECT_A,
      nixDesigner: READY_STATUS,
    });

    expect(
      queryClient.getQueryData<ProjectDashboardContentResult>(projectAFlakeKey)?.nixDesigner,
    ).toEqual(READY_STATUS);
    expect(
      queryClient.getQueryData<ProjectDashboardContentResult>(projectAHostKey)?.nixDesigner,
    ).toEqual(READY_STATUS);
    expect(
      queryClient.getQueryData<ProjectDashboardContentResult>(projectBKey)?.nixDesigner,
    ).toEqual(ERROR_STATUS);
  });
});
