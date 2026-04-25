import assert from "node:assert/strict";

import { ThreadId } from "@t3tools/contracts";
import { describe, it } from "vitest";

import {
  applyProviderTurnPromptPreamble,
  buildProviderTurnPromptPreamble,
} from "./providerTurnPrompt.ts";

describe("providerTurnPrompt", () => {
  it("builds a nix flake planning preamble for host-creation workflows", () => {
    const preamble = buildProviderTurnPromptPreamble({
      interactionMode: "plan",
      providerContext: {
        projectKind: "nix-flake",
        scopedHostName: "nexus",
        flake: {
          flakePath: "flake.nix",
          documentationPaths: {
            generalChanges: "docs/general-changes.md",
            hostDoc: "docs/hosts/nexus.md",
          },
        },
        workflow: {
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          bootstrapMode: "existing-via-ssh",
          sourceSshTarget: "root@nexus.example",
          hostType: "server",
          status: "planning",
        },
      },
    });

    assert.ok(preamble?.includes("Host scope:"));
    assert.ok(preamble?.includes("This thread is scoped to host nexus."));
    assert.ok(preamble?.includes("This workspace is a Nix flake repository."));
    assert.ok(
      preamble?.includes(
        "planning creation of host nexus by importing an existing system over SSH.",
      ),
    );
    assert.ok(preamble?.includes("SSH discovery target: root@nexus.example."));
    assert.ok(preamble?.includes("t3hosts.nexus and hosts/nexus/default.nix"));
    assert.ok(preamble?.includes("secure password prompt UI"));
    assert.ok(preamble?.includes("Never ask the user to paste passwords into chat"));
    assert.ok(
      preamble?.includes("Present a findings summary before locking the translation plan."),
    );
    assert.ok(preamble?.includes("Keep the thread planning-only"));
  });

  it("wraps the user request with an implementation preamble when the workflow is ready", () => {
    const prepared = applyProviderTurnPromptPreamble({
      threadId: ThreadId.make("thread-1"),
      input: "Apply the approved removal plan",
      interactionMode: "default",
      providerContext: {
        projectKind: "nix-flake",
        workflow: {
          kind: "host-removal",
          hostName: "nexus",
          status: "ready-to-implement",
        },
      },
    });

    assert.ok(prepared.input?.includes("implementing the approved host-removal plan for nexus."));
    assert.ok(prepared.input?.includes("User request:\nApply the approved removal plan"));
    assert.ok(!prepared.input?.includes("Keep the thread planning-only"));
  });

  it("builds a host-scope preamble for generic host-scoped threads", () => {
    const preamble = buildProviderTurnPromptPreamble({
      providerContext: {
        projectKind: "generic",
        scopedHostName: "router",
      },
    });

    assert.equal(
      preamble,
      [
        "Use the following repo context for this request:",
        "",
        "Host scope:",
        "- This thread is scoped to host router.",
        "- Unless the user explicitly broadens the request, treat router as the default host for investigation, planning, implementation, and answers.",
        "- Before touching other hosts or shared cross-host configuration, call out that wider impact explicitly.",
      ].join("\n"),
    );
  });
});
