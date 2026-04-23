import type { ProjectDashboardHostSummary } from "@t3tools/contracts";

const HOST_DOC_GENERATION_SETTLE_TIMEOUT_MS = 90_000;

export interface PendingHostDocGeneration {
  readonly previousGeneratedAt: string | null;
  readonly queuedAt: string;
  readonly baselineDataUpdatedAt: number;
}

export type PendingHostDocGenerationResolution =
  | {
      readonly kind: "pending";
    }
  | {
      readonly kind: "succeeded";
      readonly docPath: string;
    }
  | {
      readonly kind: "failed";
    };

export function resolvePendingHostDocGeneration(input: {
  pending: PendingHostDocGeneration;
  summary: ProjectDashboardHostSummary | null;
  dataUpdatedAt: number;
  now: number;
}): PendingHostDocGenerationResolution {
  if (input.dataUpdatedAt <= input.pending.baselineDataUpdatedAt) {
    return { kind: "pending" };
  }

  if (input.summary === null) {
    return { kind: "failed" };
  }

  if (input.summary.documentation.status === "generating") {
    return { kind: "pending" };
  }

  const generatedAt = input.summary.documentation.generatedAt;
  if (
    generatedAt !== null &&
    generatedAt >= input.pending.queuedAt &&
    generatedAt !== input.pending.previousGeneratedAt
  ) {
    return {
      kind: "succeeded",
      docPath: input.summary.documentation.docPath,
    };
  }

  const queuedAtMs = Date.parse(input.pending.queuedAt);
  if (
    Number.isFinite(queuedAtMs) &&
    input.now < queuedAtMs + HOST_DOC_GENERATION_SETTLE_TIMEOUT_MS
  ) {
    return { kind: "pending" };
  }

  return { kind: "failed" };
}
