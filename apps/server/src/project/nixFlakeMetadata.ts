import { runProcess } from "../processRunner.ts";

const DEFAULT_NIX_FLAKE_METADATA_TIMEOUT_MS = 60_000;
const DEFAULT_NIX_FLAKE_METADATA_BUFFER_BYTES = 8 * 1024 * 1024;

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

export async function loadNixFlakeMetadataJson(
  workspaceRoot: string,
  nixCommand = "nix",
): Promise<unknown> {
  const result = await runProcess(nixCommand, ["flake", "metadata", "--json", workspaceRoot], {
    cwd: workspaceRoot,
    timeoutMs: DEFAULT_NIX_FLAKE_METADATA_TIMEOUT_MS,
    maxBufferBytes: DEFAULT_NIX_FLAKE_METADATA_BUFFER_BYTES,
  });
  if ((result.code ?? 1) !== 0) {
    throw new Error(result.stderr.trim() || "Failed to resolve flake metadata.");
  }
  return JSON.parse(result.stdout) as unknown;
}

export function decodeNixFlakeSourcePath(metadata: unknown): string | null {
  if (typeof metadata !== "object" || metadata === null) {
    return null;
  }

  const path = (metadata as Record<string, unknown>).path;
  return typeof path === "string" ? trimToNull(path) : null;
}
