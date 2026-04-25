import { describe, expect, it } from "vitest";

import {
  buildSearchIndex,
  defaultIndexManifest,
  findOptionDoc,
  normalizeNixOptionDocs,
  normalizeNixPackageDocs,
  parseNixDiagnostics,
  resolveLockedNixpkgsRevision,
  scopeToLabel,
  searchOptionDocs,
} from "./index.ts";

describe("resolveLockedNixpkgsRevision", () => {
  it("prefers the named nixpkgs input and returns the locked nixpkgs flake ref", () => {
    const revision = resolveLockedNixpkgsRevision({
      url: "github:t3tools/example?dir=infra",
      locks: {
        nodes: {
          root: {
            inputs: {
              nixpkgs: "nixpkgs",
            },
          },
          nixpkgs: {
            locked: {
              type: "github",
              owner: "NixOS",
              repo: "nixpkgs",
              rev: "abcdef123456",
            },
            original: {
              ref: "nixos-unstable",
            },
          },
          fallback: {
            locked: {
              type: "github",
              owner: "NixOS",
              repo: "nixpkgs",
              rev: "should-not-win",
            },
          },
        },
      },
    });

    expect(revision).toEqual({
      revision: "abcdef123456",
      channel: "nixos-unstable",
      flakeRef: "github:NixOS/nixpkgs/abcdef123456",
    });
  });

  it("prefers the root nixpkgs input even when the node name is aliased", () => {
    const revision = resolveLockedNixpkgsRevision({
      locks: {
        nodes: {
          root: {
            inputs: {
              nixpkgs: "stablePkgs",
            },
          },
          stablePkgs: {
            locked: {
              type: "github",
              owner: "NixOS",
              repo: "nixpkgs",
              rev: "1234stable",
            },
            original: {
              ref: "nixos-24.11",
            },
          },
          nixpkgs: {
            locked: {
              type: "github",
              owner: "NixOS",
              repo: "nixpkgs",
              rev: "wrong-node",
            },
          },
        },
      },
    });

    expect(revision).toEqual({
      revision: "1234stable",
      channel: "nixos-24.11",
      flakeRef: "github:NixOS/nixpkgs/1234stable",
    });
  });
});

describe("normalizeNixOptionDocs", () => {
  it("normalizes and sorts option records", () => {
    const options = normalizeNixOptionDocs({
      "services.nginx.enable": {
        description: "Enable nginx.",
        type: "boolean",
        default: "false",
        example: "true",
        declarations: ["/etc/nixos/nginx.nix"],
        loc: "/workspace/modules/nginx.nix",
      },
      "boot.loader.systemd-boot.enable": {
        text: "Enable systemd-boot.",
        declarations: [],
      },
    });

    expect(options.map((option) => option.name)).toEqual([
      "boot.loader.systemd-boot.enable",
      "services.nginx.enable",
    ]);
    expect(options[1]).toEqual({
      name: "services.nginx.enable",
      description: "Enable nginx.",
      type: "boolean",
      default: "false",
      example: "true",
      declarations: ["/etc/nixos/nginx.nix"],
      sourcePath: "/workspace/modules/nginx.nix",
    });
  });
});

describe("normalizeNixPackageDocs", () => {
  it("normalizes package metadata and license values", () => {
    const packages = normalizeNixPackageDocs({
      "legacyPackages.x86_64-linux.nginx": {
        pname: "nginx",
        version: "1.27.0",
        description: "HTTP and reverse proxy server",
        license: [{ name: "BSD-2-Clause" }],
      },
      "legacyPackages.x86_64-linux.fd": {
        pname: "fd",
        license: {
          fullName: "MIT",
        },
      },
    });

    expect(packages).toEqual([
      {
        attr: "legacyPackages.x86_64-linux.fd",
        pname: "fd",
        license: ["MIT"],
      },
      {
        attr: "legacyPackages.x86_64-linux.nginx",
        pname: "nginx",
        version: "1.27.0",
        description: "HTTP and reverse proxy server",
        license: ["BSD-2-Clause"],
      },
    ]);
  });
});

describe("search helpers", () => {
  it("combines prefix and content ranking for option lookups", () => {
    const options = normalizeNixOptionDocs({
      "programs.zsh.enable": {
        description: "Enable the Z shell.",
      },
      "services.nginx.enable": {
        description: "Enable the nginx web server.",
      },
    });

    const index = buildSearchIndex(options, (document) => ({
      key: document.name,
      searchText: [document.name, document.description, ...(document.declarations ?? [])].join(" "),
    }));

    expect(searchOptionDocs(index, "ngin", 1)[0]?.name).toBe("services.nginx.enable");
    expect(findOptionDoc(options, " SERVICES.NGINX.ENABLE ")).toEqual(options[1]);
  });
});

describe("parseNixDiagnostics", () => {
  it("parses structured diagnostics, deduplicates them, and enforces workspace scoping", () => {
    const diagnostics = parseNixDiagnostics(
      [
        "/workspace/flake.nix:12:5: error: undefined variable 'pkgs'",
        "/workspace/flake.nix:12:5: error: undefined variable 'pkgs'",
        "/outside/flake.nix:4:2: warning: filtered",
        "warning: evaluation cache is disabled",
      ].join("\n"),
      "/workspace",
    );

    expect(diagnostics).toEqual([
      {
        severity: "error",
        filePath: "/workspace/flake.nix",
        line: 12,
        column: 5,
        message: "undefined variable 'pkgs'",
      },
      {
        severity: "warning",
        message: "evaluation cache is disabled",
      },
    ]);
  });
});

describe("defaultIndexManifest", () => {
  it("builds a zeroed manifest with the current schema version", () => {
    expect(
      defaultIndexManifest({
        revision: "abc123",
        channel: "nixos-unstable",
        builtAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      schemaVersion: 1,
      revision: "abc123",
      channel: "nixos-unstable",
      builtAt: "2026-01-01T00:00:00.000Z",
      optionCount: 0,
      packageCount: 0,
      lastError: null,
      staleReason: null,
    });
    expect(scopeToLabel({ kind: "project" })).toBe("project");
    expect(scopeToLabel({ kind: "host", hostName: "builder" })).toBe("host:builder");
  });
});
