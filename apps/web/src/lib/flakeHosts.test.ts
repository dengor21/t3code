import { describe, expect, it } from "vitest";

import { buildHostThreadPrompt } from "./flakeHosts";

describe("buildHostThreadPrompt", () => {
  it("includes the resolved host metadata in the seeded prompt", () => {
    expect(
      buildHostThreadPrompt({
        name: "teletype",
        target: "10.0.0.42",
        system: "x86_64-linux",
        type: "nixos",
      }),
    ).toBe(
      [
        "Host context:",
        "- name: teletype",
        "- target: 10.0.0.42",
        "- system: x86_64-linux",
        "- type: nixos",
        "",
        "Please scope the next change to this host unless I say otherwise.",
      ].join("\n"),
    );
  });

  it("omits optional host fields when they are unavailable", () => {
    expect(
      buildHostThreadPrompt({
        name: "bc250",
        target: "bc250",
      }),
    ).toBe(
      [
        "Host context:",
        "- name: bc250",
        "- target: bc250",
        "",
        "Please scope the next change to this host unless I say otherwise.",
      ].join("\n"),
    );
  });
});
