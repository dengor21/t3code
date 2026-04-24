import assert from "node:assert/strict";

import { describe, it } from "vitest";

import { HOST_IMPORT_REMOTE_SCRIPT } from "./hostImportScripts.ts";

describe("hostImportScripts", () => {
  it("uses printf -- for bullet lines that start with dashes", () => {
    assert.ok(HOST_IMPORT_REMOTE_SCRIPT.includes("printf -- '- Remote access succeeded"));
    assert.ok(HOST_IMPORT_REMOTE_SCRIPT.includes("printf -- '- Privileged discovery completed"));
    assert.ok(!HOST_IMPORT_REMOTE_SCRIPT.includes("printf '-"));
  });
});
