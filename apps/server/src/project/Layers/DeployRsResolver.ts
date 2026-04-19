import {
  buildDeployRsCommand,
  type FlakeHost,
  type ProjectDashboardHostDeployment,
} from "@t3tools/contracts";
import { Cache, Duration, Effect, Exit, Layer } from "effect";

import { runProcess } from "../../processRunner.ts";
import { DeployRsResolver, type DeployRsResolverShape } from "../Services/DeployRsResolver.ts";

const DEFAULT_CACHE_CAPACITY = 256;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.seconds(10);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.seconds(5);
const DEFAULT_NIX_EVAL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER_BYTES = 256 * 1024;

interface DeployRsResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly nixCommand?: string;
}

interface DeployNodesResolution {
  readonly status: "available" | "evaluation-failed";
  readonly hostNames: ReadonlySet<string>;
}

function normalizeHostName(value: string): string {
  return value.trim().toLowerCase();
}

function deployable(command: string): ProjectDashboardHostDeployment {
  return {
    status: "deployable",
    reason: null,
    command,
  };
}

function unavailable(
  reason: "missing-deploy-target" | "evaluation-failed",
): ProjectDashboardHostDeployment {
  return {
    status: "unavailable",
    reason,
    command: null,
  };
}

async function evaluateDeployNodes(
  workspaceRoot: string,
  nixCommand: string,
): Promise<DeployNodesResolution> {
  try {
    const args = ["eval", "--json", ".#deploy.nodes", "--apply", "builtins.attrNames"] as const;
    const result = await runProcess(nixCommand, [...args], {
      cwd: workspaceRoot,
      allowNonZeroExit: true,
      timeoutMs: DEFAULT_NIX_EVAL_TIMEOUT_MS,
      maxBufferBytes: DEFAULT_MAX_BUFFER_BYTES,
      outputMode: "truncate",
    });

    if (result.code !== 0) {
      return {
        status: "evaluation-failed",
        hostNames: new Set<string>(),
      };
    }

    const decoded = JSON.parse(result.stdout) as unknown;
    return {
      status: "available",
      hostNames: Array.isArray(decoded)
        ? new Set(
            decoded
              .filter((entry): entry is string => typeof entry === "string")
              .map(normalizeHostName),
          )
        : typeof decoded === "object" && decoded !== null
          ? new Set(Object.keys(decoded).map(normalizeHostName))
          : new Set<string>(),
    };
  } catch {
    return {
      status: "evaluation-failed",
      hostNames: new Set<string>(),
    };
  }
}

export const makeDeployRsResolver = Effect.fn("makeDeployRsResolver")(function* (
  options: DeployRsResolverOptions = {},
) {
  const deployNodesCache = yield* Cache.makeWith<string, DeployNodesResolution>(
    (workspaceRoot) =>
      Effect.promise(() => evaluateDeployNodes(workspaceRoot, options.nixCommand ?? "nix")),
    {
      capacity: options.cacheCapacity ?? DEFAULT_CACHE_CAPACITY,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value.status === "available"
            ? (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL)
            : (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const resolveHostDeployments: DeployRsResolverShape["resolveHostDeployments"] = Effect.fn(
    "DeployRsResolver.resolveHostDeployments",
  )(function* (input: { workspaceRoot: string; hosts: ReadonlyArray<FlakeHost> }) {
    const resolution = yield* Cache.get(deployNodesCache, input.workspaceRoot);

    return new Map(
      input.hosts.map((host) => {
        const key = normalizeHostName(host.name);
        if (resolution.status !== "available") {
          return [key, unavailable("evaluation-failed")] as const;
        }
        return [
          key,
          resolution.hostNames.has(key)
            ? deployable(buildDeployRsCommand(host.name))
            : unavailable("missing-deploy-target"),
        ] as const;
      }),
    );
  });

  return {
    resolveHostDeployments,
  } satisfies DeployRsResolverShape;
});

export const DeployRsResolverLive = Layer.effect(DeployRsResolver, makeDeployRsResolver());
