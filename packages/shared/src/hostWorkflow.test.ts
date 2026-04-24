import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  buildHostCreationStarterPrompt,
  buildHostImportFindingsPrompt,
  buildHostRemovalStarterPrompt,
} from "./hostWorkflow.ts";

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

  it("guides SSH-import host creation without provider-specific tool references", () => {
    const prompt = buildHostCreationStarterPrompt({
      kind: "host-creation",
      hostName: "nexus",
      target: "nexus",
      osFamily: "nixos",
      bootstrapMode: "existing-via-ssh",
      sourceSshTarget: "root@nexus.example",
      hostType: "server",
      status: "planning",
    });

    assert.ok(prompt.includes("importing an existing system over SSH"));
    assert.ok(prompt.includes("ssh-agent"));
    assert.ok(prompt.includes("secure password prompt UI"));
    assert.ok(prompt.includes("Never ask the user to paste passwords into chat"));
    assert.ok(!prompt.includes("Require the user to preload a usable SSH key"));
    assert.ok(prompt.includes("Present a findings summary before locking the translation plan."));
    assert.ok(prompt.includes("Do not rush to a final plan in the first response."));
    assert.ok(!prompt.includes("update_plan"));
    assert.ok(!prompt.includes("request_user_input"));
  });

  it("builds a sanitized findings handoff prompt for SSH-import workflows", () => {
    const prompt = buildHostImportFindingsPrompt(
      {
        kind: "host-creation",
        hostName: "nexus",
        target: "nexus",
        osFamily: "nixos",
        bootstrapMode: "existing-via-ssh",
        sourceSshTarget: "root@nexus.example",
        status: "planning",
      },
      "# Host Import Findings\n\n- Hostname: nexus\n- Services: nginx",
    );

    assert.ok(prompt.includes("sanitized findings below as the source of truth"));
    assert.ok(prompt.includes("Present the findings first."));
    assert.ok(prompt.includes("translate the system into Nix"));
    assert.ok(prompt.includes("Services: nginx"));
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
