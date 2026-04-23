import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { buildHostCreationStarterPrompt, buildHostRemovalStarterPrompt } from "./hostWorkflow.ts";

describe("hostWorkflow starter prompts", () => {
  it("keeps the host-creation starter prompt provider-neutral", () => {
    const prompt = buildHostCreationStarterPrompt({
      kind: "host-creation",
      hostName: "nexus",
      osFamily: "nixos",
      status: "planning",
    });

    assert.ok(prompt.includes("keep your running plan aligned"));
    assert.ok(prompt.includes("ask concise structured follow-up questions"));
    assert.ok(!prompt.includes("update_plan"));
    assert.ok(!prompt.includes("request_user_input"));
  });

  it("keeps the host-removal starter prompt provider-neutral", () => {
    const prompt = buildHostRemovalStarterPrompt({
      kind: "host-removal",
      hostName: "nexus",
      status: "planning",
    });

    assert.ok(prompt.includes("keep your running plan aligned"));
    assert.ok(!prompt.includes("update_plan"));
    assert.ok(!prompt.includes("request_user_input"));
  });
});
