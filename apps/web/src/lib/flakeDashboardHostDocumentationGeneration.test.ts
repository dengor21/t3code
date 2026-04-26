import type { ProjectDashboardHostSummary } from "@t3tools/contracts";
import { assert, describe, it } from "vitest";

import {
  resolvePendingHostDocGeneration,
  type PendingHostDocGeneration,
} from "./flakeDashboardHostDocumentationGeneration";

const HOST_SUMMARY: ProjectDashboardHostSummary = {
  host: {
    name: "mediaserver",
    system: "x86_64-linux",
    target: "mediaserver",
    type: "server",
  },
  documentation: {
    coversChangesThrough: null,
    docPath: ".hal/docs/hosts/mediaserver.md",
    generatedAt: "2026-04-22T20:00:00.000Z",
    hostName: "mediaserver",
    latestRelevantChangeAt: null,
    status: "current",
  },
  deployment: {
    command: null,
    reason: "missing-deploy-target",
    status: "unavailable",
  },
  latestDeployment: null,
  latestDrift: null,
};

const PENDING: PendingHostDocGeneration = {
  previousGeneratedAt: "2026-04-22T20:00:00.000Z",
  queuedAt: "2026-04-23T09:00:00.000Z",
  baselineDataUpdatedAt: 100,
};

const GRACE_WINDOW_NOW = Date.parse("2026-04-23T09:00:30.000Z");
const POST_TIMEOUT_NOW = Date.parse("2026-04-23T09:01:31.000Z");

describe("resolvePendingHostDocGeneration", () => {
  it("waits for a fresh dashboard snapshot before deciding the job settled", () => {
    assert.deepEqual(
      resolvePendingHostDocGeneration({
        pending: PENDING,
        summary: HOST_SUMMARY,
        dataUpdatedAt: 100,
        now: GRACE_WINDOW_NOW,
      }),
      { kind: "pending" },
    );
  });

  it("keeps polling while the server still reports generation in progress", () => {
    assert.deepEqual(
      resolvePendingHostDocGeneration({
        pending: PENDING,
        summary: {
          ...HOST_SUMMARY,
          documentation: {
            ...HOST_SUMMARY.documentation,
            status: "generating",
          },
        },
        dataUpdatedAt: 101,
        now: GRACE_WINDOW_NOW,
      }),
      { kind: "pending" },
    );
  });

  it("recognizes a fresh generated document", () => {
    assert.deepEqual(
      resolvePendingHostDocGeneration({
        pending: PENDING,
        summary: {
          ...HOST_SUMMARY,
          documentation: {
            ...HOST_SUMMARY.documentation,
            generatedAt: "2026-04-23T09:00:05.000Z",
          },
        },
        dataUpdatedAt: 101,
        now: GRACE_WINDOW_NOW,
      }),
      {
        kind: "succeeded",
        docPath: ".hal/docs/hosts/mediaserver.md",
      },
    );
  });

  it("keeps polling during the settle window when a fresh snapshot is still stale", () => {
    assert.deepEqual(
      resolvePendingHostDocGeneration({
        pending: PENDING,
        summary: HOST_SUMMARY,
        dataUpdatedAt: 101,
        now: GRACE_WINDOW_NOW,
      }),
      { kind: "pending" },
    );
  });

  it("fails after the settle window if no fresh document appears", () => {
    assert.deepEqual(
      resolvePendingHostDocGeneration({
        pending: PENDING,
        summary: HOST_SUMMARY,
        dataUpdatedAt: 101,
        now: POST_TIMEOUT_NOW,
      }),
      { kind: "failed" },
    );
  });
});
