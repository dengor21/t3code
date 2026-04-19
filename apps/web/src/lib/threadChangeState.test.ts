import { describe, expect, it } from "vitest";

import {
  isThreadChangeCommitted,
  isThreadChangeOngoing,
  resolveThreadChangeTracking,
} from "./threadChangeState";

describe("threadChangeState", () => {
  it("defaults missing change tracking to ongoing", () => {
    expect(resolveThreadChangeTracking({})).toBeNull();
    expect(isThreadChangeCommitted({})).toBe(false);
    expect(isThreadChangeOngoing({})).toBe(true);
  });

  it("recognizes committed change tracking", () => {
    const changeTracking = {
      baselineHeadSha: "abc1234",
      lastCommit: {
        sha: "abc1234",
        subject: "Commit subject",
        recordedAt: "2026-04-19T10:00:00.000Z",
        source: "ui" as const,
      },
      state: "committed" as const,
    };

    expect(resolveThreadChangeTracking({ changeTracking })).toEqual(changeTracking);
    expect(isThreadChangeCommitted({ changeTracking })).toBe(true);
    expect(isThreadChangeOngoing({ changeTracking })).toBe(false);
  });
});
