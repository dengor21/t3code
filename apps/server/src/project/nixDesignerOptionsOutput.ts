import { access, readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const HYDRA_BUILD_PRODUCTS_RELATIVE_PATH = join("nix-support", "hydra-build-products");
const FALLBACK_OPTIONS_JSON_RELATIVE_PATH = join("share", "doc", "nixos", "options.json");

export function parseHydraBuildProductsJsonPath(contents: string): string | null {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    const match = /^file\s+json\s+(.+)$/.exec(line);
    if (match?.[1]) {
      return match[1].trim() || null;
    }
  }
  return null;
}

export async function resolveNixOptionsJsonPath(outputPath: string): Promise<string> {
  const outputStat = await stat(outputPath);
  if (outputStat.isFile()) {
    return outputPath;
  }
  if (!outputStat.isDirectory()) {
    throw new Error(
      `Evaluated Nix options output is neither a file nor a directory: ${outputPath}`,
    );
  }

  try {
    const hydraBuildProducts = await readFile(
      join(outputPath, HYDRA_BUILD_PRODUCTS_RELATIVE_PATH),
      "utf8",
    );
    const hydraJsonPath = parseHydraBuildProductsJsonPath(hydraBuildProducts);
    if (hydraJsonPath) {
      const resolvedHydraJsonPath = isAbsolute(hydraJsonPath)
        ? hydraJsonPath
        : join(outputPath, hydraJsonPath);
      await access(resolvedHydraJsonPath);
      return resolvedHydraJsonPath;
    }
  } catch {
    // Fall back to the standard nixosOptionsDoc output layout below.
  }

  const fallbackJsonPath = join(outputPath, FALLBACK_OPTIONS_JSON_RELATIVE_PATH);
  await access(fallbackJsonPath);
  return fallbackJsonPath;
}

export async function loadNixOptionsJson(outputPath: string): Promise<unknown> {
  const jsonPath = await resolveNixOptionsJsonPath(outputPath);
  return JSON.parse(await readFile(jsonPath, "utf8"));
}
