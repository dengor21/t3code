import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { buildCodexDeveloperInstructions } from "./CodexDeveloperInstructions.ts";

describe("CodexDeveloperInstructions", () => {
  it("adds explicit host-scope guidance for host-scoped threads", () => {
    const instructions = buildCodexDeveloperInstructions({
      interactionMode: "default",
      providerContext: {
        projectKind: "generic",
        scopedHostName: "nexus",
      },
    });

    assert.ok(instructions.includes("Host scope:"));
    assert.ok(instructions.includes("This thread is scoped to host nexus."));
    assert.ok(instructions.includes("HAL runtime scope is authoritative"));
    assert.ok(instructions.includes("call hal_current_scope"));
    assert.ok(instructions.includes("The scoped host is the default"));
    assert.ok(instructions.includes("require scope expansion or approval"));
  });
});
