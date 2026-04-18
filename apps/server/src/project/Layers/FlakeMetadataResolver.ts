import { constants } from "node:fs";
import { access, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { FlakeHost, FlakeMetadata } from "@t3tools/contracts";
import { Cache, Duration, Effect, Exit, Layer } from "effect";

import { runProcess } from "../../processRunner.ts";
import {
  FlakeMetadataResolver,
  type FlakeMetadataResolverShape,
} from "../Services/FlakeMetadataResolver.ts";

const DEFAULT_FLAKE_METADATA_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.seconds(30);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.seconds(15);
const DEFAULT_NIX_EVAL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;

interface ParsedFlakeMetadataResult {
  readonly hosts: ReadonlyArray<FlakeHost>;
  readonly diagnostics: ReadonlyArray<string>;
  readonly source: "parsed-flake" | "missing" | "error";
}

interface NixEvalResult {
  readonly hosts: ReadonlyArray<FlakeHost>;
  readonly diagnostics: ReadonlyArray<string>;
  readonly source: "nix-eval" | "missing" | "error";
}

interface FlakeMetadataResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly nixCommand?: string;
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function uniqueDiagnostics(diagnostics: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(diagnostics.map((diagnostic) => diagnostic.trim()).filter(Boolean))];
}

function toFlakeMetadata(input: {
  readonly hosts: ReadonlyArray<FlakeHost>;
  readonly source: FlakeMetadata["source"];
  readonly flakePath: string;
  readonly diagnostics?: ReadonlyArray<string>;
}): FlakeMetadata {
  const hosts = [...input.hosts];
  return {
    host: hosts.length === 1 ? (hosts[0] ?? null) : null,
    hosts,
    source: input.source,
    flakePath: input.flakePath,
    diagnostics: [...uniqueDiagnostics(input.diagnostics ?? [])],
  };
}

function decodeHost(value: unknown, fallbackName?: string): FlakeHost | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const name = trimToNull(typeof candidate.name === "string" ? candidate.name : fallbackName);
  const target = trimToNull(typeof candidate.target === "string" ? candidate.target : null);
  const system = trimToNull(typeof candidate.system === "string" ? candidate.system : null);
  const type = trimToNull(typeof candidate.type === "string" ? candidate.type : null);

  if (name === null || target === null) {
    return null;
  }

  return {
    name,
    target,
    ...(system ? { system } : {}),
    ...(type ? { type } : {}),
  };
}

function decodeHosts(value: unknown): ReadonlyArray<FlakeHost> {
  if (Array.isArray(value)) {
    return value
      .map((entry) => decodeHost(entry))
      .filter((host): host is FlakeHost => host !== null);
  }

  if (typeof value !== "object" || value === null) {
    return [];
  }

  return Object.entries(value)
    .map(([key, entry]) => decodeHost(entry, key))
    .filter((host): host is FlakeHost => host !== null);
}

function parseQuotedNixString(source: string): string | null {
  const quoted = /^"((?:[^"\\]|\\.)+)"$/s.exec(source.trim())?.[1];
  if (!quoted) {
    return null;
  }

  try {
    const decoded = JSON.parse(`"${quoted}"`);
    return trimToNull(typeof decoded === "string" ? decoded : null);
  } catch {
    return null;
  }
}

function parseLiteralHostBlock(contents: string): ParsedFlakeMetadataResult {
  const blockMatch = /t3code\s*\.\s*host\s*=\s*\{([\s\S]*?)\};/m.exec(contents);
  if (!blockMatch) {
    return {
      hosts: [],
      diagnostics: ["No literal t3code.host block found in flake.nix."],
      source: "missing",
    };
  }

  const [, block = ""] = blockMatch;
  const nameValue = /\bname\s*=\s*("(?:[^"\\]|\\.)*")\s*;/m.exec(block)?.[1] ?? null;
  const targetValue = /\btarget\s*=\s*("(?:[^"\\]|\\.)*")\s*;/m.exec(block)?.[1] ?? null;
  const systemValue = /\bsystem\s*=\s*("(?:[^"\\]|\\.)*")\s*;/m.exec(block)?.[1] ?? null;
  const typeValue = /\btype\s*=\s*("(?:[^"\\]|\\.)*")\s*;/m.exec(block)?.[1] ?? null;
  const name = nameValue ? parseQuotedNixString(nameValue) : null;
  const target = targetValue ? parseQuotedNixString(targetValue) : null;
  const system = systemValue ? parseQuotedNixString(systemValue) : null;
  const type = typeValue ? parseQuotedNixString(typeValue) : null;

  if (name !== null && target !== null) {
    return {
      hosts: [
        {
          name,
          target,
          ...(system ? { system } : {}),
          ...(type ? { type } : {}),
        },
      ],
      diagnostics: [],
      source: "parsed-flake",
    };
  }

  const diagnostics = [];
  if (name === null) {
    diagnostics.push("The literal t3code.host block is missing a string name.");
  }
  if (target === null) {
    diagnostics.push("The literal t3code.host block is missing a string target.");
  }

  return {
    hosts: [],
    diagnostics,
    source: "error",
  };
}

function parseLiteralT3HostsBlock(contents: string): ParsedFlakeMetadataResult {
  const blockMatch = /t3hosts\s*=\s*\{([\s\S]*?)\};/m.exec(contents);
  if (!blockMatch) {
    return {
      hosts: [],
      diagnostics: ["No literal t3hosts block found in flake.nix."],
      source: "missing",
    };
  }

  const [, block = ""] = blockMatch;
  const entryRegex = /([a-zA-Z0-9._-]+)\s*=\s*\{([\s\S]*?)\};/g;
  const hosts: FlakeHost[] = [];
  let sawEntry = false;

  for (const match of block.matchAll(entryRegex)) {
    const [, key = "", entryBody = ""] = match;
    sawEntry = true;
    const nameValue = /\bname\s*=\s*("(?:[^"\\]|\\.)*")\s*;/m.exec(entryBody)?.[1] ?? null;
    const targetValue = /\btarget\s*=\s*("(?:[^"\\]|\\.)*")\s*;/m.exec(entryBody)?.[1] ?? null;
    const systemValue = /\bsystem\s*=\s*("(?:[^"\\]|\\.)*")\s*;/m.exec(entryBody)?.[1] ?? null;
    const typeValue = /\btype\s*=\s*("(?:[^"\\]|\\.)*")\s*;/m.exec(entryBody)?.[1] ?? null;
    const name = nameValue ? parseQuotedNixString(nameValue) : trimToNull(key);
    const target = targetValue ? parseQuotedNixString(targetValue) : null;
    const system = systemValue ? parseQuotedNixString(systemValue) : null;
    const type = typeValue ? parseQuotedNixString(typeValue) : null;

    if (name !== null && target !== null) {
      hosts.push({
        name,
        target,
        ...(system ? { system } : {}),
        ...(type ? { type } : {}),
      });
    }
  }

  if (hosts.length > 0) {
    return {
      hosts,
      diagnostics: [],
      source: "parsed-flake",
    };
  }

  return {
    hosts: [],
    diagnostics: [
      sawEntry
        ? "The literal t3hosts block was found, but no host entries had string name/target pairs."
        : "No host entries were found inside the literal t3hosts block.",
    ],
    source: "error",
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function classifyNixEvalFailure(stderr: string, stdout: string): "missing" | "error" {
  const detail = `${stderr}\n${stdout}`;
  return /does not provide attribute|attribute ['"][^'"]+['"] missing|undefined variable/i.test(
    detail,
  )
    ? "missing"
    : "error";
}

async function resolveNixEvalHosts(
  cwd: string,
  nixCommand: string,
  attributePath: ".#t3code.host" | ".#t3hosts",
): Promise<NixEvalResult> {
  try {
    const result = await runProcess(nixCommand, ["eval", "--json", attributePath], {
      cwd,
      allowNonZeroExit: true,
      timeoutMs: DEFAULT_NIX_EVAL_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      outputMode: "truncate",
    });

    if (result.code !== 0) {
      const detail = trimToNull(result.stderr) ?? trimToNull(result.stdout);
      return {
        hosts: [],
        diagnostics: uniqueDiagnostics([
          detail ? `nix eval failed: ${detail}` : "nix eval failed.",
        ]),
        source: classifyNixEvalFailure(result.stderr, result.stdout),
      };
    }

    const hosts = decodeHosts(JSON.parse(result.stdout) as unknown);
    if (hosts.length > 0) {
      return {
        hosts,
        diagnostics: [],
        source: "nix-eval",
      };
    }

    return {
      hosts: [],
      diagnostics: [
        `nix eval returned ${attributePath.slice(2)}, but it did not decode into host entries with string name and target fields.`,
      ],
      source: "error",
    };
  } catch (error) {
    return {
      hosts: [],
      diagnostics: [
        error instanceof Error
          ? `nix eval could not run: ${error.message}`
          : "nix eval could not run.",
      ],
      source: "error",
    };
  }
}

async function resolveFlakeMetadataFromCacheKey(
  cwd: string,
  nixCommand: string,
): Promise<FlakeMetadata> {
  const flakePath = join(cwd, "flake.nix");

  const t3codeHostEval = await resolveNixEvalHosts(cwd, nixCommand, ".#t3code.host");
  if (t3codeHostEval.hosts.length > 0) {
    return toFlakeMetadata({
      hosts: t3codeHostEval.hosts,
      source: "nix-eval",
      flakePath,
    });
  }

  const t3hostsEval = await resolveNixEvalHosts(cwd, nixCommand, ".#t3hosts");
  if (t3hostsEval.hosts.length > 0) {
    return toFlakeMetadata({
      hosts: t3hostsEval.hosts,
      source: "nix-eval",
      flakePath,
    });
  }

  if (!(await fileExists(flakePath))) {
    return toFlakeMetadata({
      hosts: [],
      source: "missing",
      flakePath,
      diagnostics: [
        ...uniqueDiagnostics([
          ...t3codeHostEval.diagnostics,
          ...t3hostsEval.diagnostics,
          "flake.nix was not found.",
        ]),
      ],
    });
  }

  try {
    const contents = await readFile(flakePath, "utf8");
    const parsedHost = parseLiteralHostBlock(contents);
    if (parsedHost.hosts.length > 0) {
      return toFlakeMetadata({
        hosts: parsedHost.hosts,
        source: "parsed-flake",
        flakePath,
      });
    }

    const parsedHosts = parseLiteralT3HostsBlock(contents);
    if (parsedHosts.hosts.length > 0) {
      return toFlakeMetadata({
        hosts: parsedHosts.hosts,
        source: "parsed-flake",
        flakePath,
      });
    }

    return toFlakeMetadata({
      hosts: [],
      source: parsedHost.source === "error" || parsedHosts.source === "error" ? "error" : "missing",
      flakePath,
      diagnostics: [
        ...uniqueDiagnostics([
          ...t3codeHostEval.diagnostics,
          ...t3hostsEval.diagnostics,
          ...parsedHost.diagnostics,
          ...parsedHosts.diagnostics,
        ]),
      ],
    });
  } catch (error) {
    return toFlakeMetadata({
      hosts: [],
      source: "error",
      flakePath,
      diagnostics: [
        ...uniqueDiagnostics([
          ...t3codeHostEval.diagnostics,
          ...t3hostsEval.diagnostics,
          error instanceof Error
            ? `Failed to read flake.nix: ${error.message}`
            : "Failed to read flake.nix.",
        ]),
      ],
    });
  }
}

async function resolveFlakeMetadataCacheKey(cwd: string): Promise<string> {
  try {
    return await realpath(cwd);
  } catch {
    return cwd;
  }
}

export const makeFlakeMetadataResolver = Effect.fn("makeFlakeMetadataResolver")(function* (
  options: FlakeMetadataResolverOptions = {},
) {
  const flakeMetadataCache = yield* Cache.makeWith<string, FlakeMetadata>(
    (cacheKey) =>
      Effect.promise(() => resolveFlakeMetadataFromCacheKey(cacheKey, options.nixCommand ?? "nix")),
    {
      capacity: options.cacheCapacity ?? DEFAULT_FLAKE_METADATA_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value.source === "nix-eval" || value.source === "parsed-flake"
            ? (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL)
            : (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolve: FlakeMetadataResolverShape["resolve"] = Effect.fn("FlakeMetadataResolver.resolve")(
    function* (cwd) {
      const cacheKey = yield* Effect.promise(() => resolveFlakeMetadataCacheKey(cwd));
      return yield* Cache.get(flakeMetadataCache, cacheKey);
    },
  );

  return {
    resolve,
  } satisfies FlakeMetadataResolverShape;
});

export const FlakeMetadataResolverLive = Layer.effect(
  FlakeMetadataResolver,
  makeFlakeMetadataResolver(),
);
