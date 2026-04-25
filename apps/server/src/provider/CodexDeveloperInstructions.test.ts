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
    assert.ok(
      instructions.includes(
        "Unless the user explicitly broadens the request, treat nexus as the default host",
      ),
    );
    assert.ok(
      instructions.includes(
        "Before touching other hosts or shared cross-host configuration, call out that wider impact explicitly.",
      ),
    );
  });
});
