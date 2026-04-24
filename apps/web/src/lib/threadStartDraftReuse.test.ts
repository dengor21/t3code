import { describe, expect, it } from "vitest";

import { shouldReuseDraftForThreadStart } from "./threadStartDraftReuse";

describe("shouldReuseDraftForThreadStart", () => {
  it("reuses the draft when no host scope is requested", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: null,
        requestedWorkflow: null,
        existingScopedHostName: "bc250",
        existingWorkflow: null,
        existingPrompt: "Host context:\n- name: bc250",
      }),
    ).toBe(false);
  });

  it("reuses the draft when the requested host matches the existing host", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "thinkpad",
        requestedWorkflow: null,
        existingScopedHostName: "thinkpad",
        existingWorkflow: null,
        existingPrompt: "Host context:\n- name: thinkpad",
      }),
    ).toBe(true);
  });

  it("starts a fresh draft when a different host is requested and the draft already has content", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "thinkpad",
        requestedWorkflow: null,
        existingScopedHostName: "bc250",
        existingWorkflow: null,
        existingPrompt: "Host context:\n- name: bc250",
      }),
    ).toBe(false);
  });

  it("reuses the draft for a different host when the current draft is still empty", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "thinkpad",
        requestedWorkflow: null,
        existingScopedHostName: "bc250",
        existingWorkflow: null,
        existingPrompt: "   ",
      }),
    ).toBe(true);
  });

  it("does not reuse a generic draft for a host-creation workflow", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "nexus",
        requestedWorkflow: {
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          status: "planning",
        },
        existingScopedHostName: "nexus",
        existingWorkflow: null,
        existingPrompt: "   ",
      }),
    ).toBe(false);
  });

  it("reuses a matching host-creation draft", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "nexus",
        requestedWorkflow: {
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          bootstrapMode: "existing-via-ssh",
          sourceSshTarget: "root@nexus.example",
          status: "planning",
        },
        existingScopedHostName: "nexus",
        existingWorkflow: {
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          bootstrapMode: "existing-via-ssh",
          sourceSshTarget: "root@nexus.example",
          status: "planning",
        },
        existingPrompt: "   ",
      }),
    ).toBe(true);
  });

  it("does not reuse a host-creation draft when the bootstrap mode changed", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "nexus",
        requestedWorkflow: {
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          bootstrapMode: "existing-via-ssh",
          sourceSshTarget: "root@nexus.example",
          status: "planning",
        },
        existingScopedHostName: "nexus",
        existingWorkflow: {
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          bootstrapMode: "new-host",
          status: "planning",
        },
        existingPrompt: "   ",
      }),
    ).toBe(false);
  });

  it("reuses a matching host-removal draft", () => {
    expect(
      shouldReuseDraftForThreadStart({
        requestedScopedHostName: "nexus",
        requestedWorkflow: {
          kind: "host-removal",
          hostName: "nexus",
          target: "root@nexus",
          hostType: "server",
          status: "planning",
        },
        existingScopedHostName: "nexus",
        existingWorkflow: {
          kind: "host-removal",
          hostName: "nexus",
          target: "root@nexus",
          hostType: "server",
          status: "planning",
        },
        existingPrompt: "   ",
      }),
    ).toBe(true);
  });
});
