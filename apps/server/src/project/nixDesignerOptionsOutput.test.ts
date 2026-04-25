import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadNixOptionsJson,
  parseHydraBuildProductsJsonPath,
  resolveNixOptionsJsonPath,
} from "./nixDesignerOptionsOutput.ts";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nix-designer-options-"));
  tempDirs.push(dir);
  return dir;
}

async function writeJsonFile(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseHydraBuildProductsJsonPath", () => {
  it("extracts the json artifact path from hydra build products", () => {
    expect(
      parseHydraBuildProductsJsonPath(
        [
          "file json /nix/store/example/share/doc/nixos/options.json",
          "file json-br /nix/store/example/share/doc/nixos/options.json.br",
        ].join("\n"),
      ),
    ).toBe("/nix/store/example/share/doc/nixos/options.json");
  });
});

describe("resolveNixOptionsJsonPath", () => {
  it("returns the path directly when the output is already a file", async () => {
    const dir = await makeTempDir();
    const jsonPath = join(dir, "options.json");
    await writeJsonFile(jsonPath, "{}");

    await expect(resolveNixOptionsJsonPath(jsonPath)).resolves.toBe(jsonPath);
  });

  it("resolves the json artifact from hydra build products when the output is a directory", async () => {
    const dir = await makeTempDir();
    const jsonPath = join(dir, "share", "doc", "nixos", "options.json");
    await writeJsonFile(jsonPath, "{}");
    await writeJsonFile(
      join(dir, "nix-support", "hydra-build-products"),
      `file json ${jsonPath}\nfile json-br ${jsonPath}.br\n`,
    );

    await expect(resolveNixOptionsJsonPath(dir)).resolves.toBe(jsonPath);
  });

  it("falls back to the standard nixosOptionsDoc json location when hydra metadata is absent", async () => {
    const dir = await makeTempDir();
    const jsonPath = join(dir, "share", "doc", "nixos", "options.json");
    await writeJsonFile(jsonPath, "{}");

    await expect(resolveNixOptionsJsonPath(dir)).resolves.toBe(jsonPath);
  });
});

describe("loadNixOptionsJson", () => {
  it("loads and parses the options json artifact from a realized output directory", async () => {
    const dir = await makeTempDir();
    const jsonPath = join(dir, "share", "doc", "nixos", "options.json");
    await writeJsonFile(
      jsonPath,
      JSON.stringify({
        "services.nginx.enable": {
          description: "Enable nginx.",
        },
      }),
    );

    await expect(loadNixOptionsJson(dir)).resolves.toEqual({
      "services.nginx.enable": {
        description: "Enable nginx.",
      },
    });
  });
});
