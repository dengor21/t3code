import { describe, expect, it } from "vitest";

import { shouldReuseDraftForThreadStart } from "./threadStartDraftReuse";

describe("shouldReuseDraftForThreadStart", () => {
  it("reuses the draft when no host scope is requested", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: null,
        existingScopedHostName: "bc250",
        existingPrompt: "Host context:\n- name: bc250",
      }),
    ).toBe(true);
  });

  it("reuses the draft when the requested host matches the existing host", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "thinkpad",
        existingScopedHostName: "thinkpad",
        existingPrompt: "Host context:\n- name: thinkpad",
      }),
    ).toBe(true);
  });

  it("starts a fresh draft when a different host is requested and the draft already has content", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "thinkpad",
        existingScopedHostName: "bc250",
        existingPrompt: "Host context:\n- name: bc250",
      }),
    ).toBe(false);
  });

  it("reuses the draft for a different host when the current draft is still empty", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "thinkpad",
        existingScopedHostName: "bc250",
        existingPrompt: "   ",
      }),
    ).toBe(true);
  });
});
