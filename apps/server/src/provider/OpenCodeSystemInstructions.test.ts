import assert from "node:assert/strict";

import { describe, it } from "vitest";

import {
  buildOpenCodeSystemInstructions,
  OPENCODE_DEFAULT_MODE_SYSTEM_INSTRUCTIONS,
  OPENCODE_PLAN_MODE_SYSTEM_INSTRUCTIONS,
} from "./OpenCodeSystemInstructions.ts";

describe("OpenCodeSystemInstructions", () => {
  it("uses OpenCode-native question tool guidance in default mode", () => {
    const instructions = buildOpenCodeSystemInstructions({
      interactionMode: "default",
    });

    assert.equal(instructions, OPENCODE_DEFAULT_MODE_SYSTEM_INSTRUCTIONS);
    assert.ok(instructions.includes("OpenCode exposes a `question` tool."));
    assert.ok(instructions.includes("Do not call `request_user_input`."));
    assert.ok(instructions.includes('"custom":false'));
    assert.ok(instructions.includes("Do not send `id`, `multiSelect`, or nested objects"));
    assert.ok(instructions.includes("OpenCode exposes `todowrite` and `todoread`"));
    assert.ok(instructions.includes('"content":"Describe the task"'));
    assert.ok(
      instructions.includes(
        "Every todo object must include `id`, `content`, `status`, and `priority`",
      ),
    );
    assert.ok(instructions.includes('partial objects like `{ "id": "1", "status": "completed" }`'));
  });

  it("adds planning semantics in plan mode", () => {
    const instructions = buildOpenCodeSystemInstructions({
      interactionMode: "plan",
    });

    assert.equal(instructions, OPENCODE_PLAN_MODE_SYSTEM_INSTRUCTIONS);
    assert.ok(instructions.includes("Do not implement repo changes."));
    assert.ok(instructions.includes("<proposed_plan>"));
    assert.ok(
      instructions.includes("Prefer the `question` tool for concise multiple-choice decisions"),
    );
  });
});
