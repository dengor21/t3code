import { normalizeHostName } from "@t3tools/shared/threadScope";

import type { ResolvedThreadScope } from "./threadScope.ts";

export interface HostFilePattern {
  readonly hostName: string;
  readonly patterns: ReadonlyArray<string>;
}

export type ScopeAction =
  | { readonly kind: "file-change"; readonly path: string }
  | { readonly kind: "command"; readonly command: string; readonly cwd?: string }
  | { readonly kind: "nix-eval"; readonly attr?: string; readonly hostName?: string }
  | { readonly kind: "deploy-host"; readonly hostName?: string; readonly target?: string }
  | { readonly kind: "deploy-fleet"; readonly hosts?: ReadonlyArray<string> };

export type ScopePolicyDecision =
  | { readonly kind: "allow"; readonly resolvedHostName?: string }
  | { readonly kind: "warn"; readonly reason: string; readonly resolvedHostName?: string }
  | {
      readonly kind: "require-explicit-approval";
      readonly reason: string;
      readonly requestedHostName?: string;
    }
  | { readonly kind: "block"; readonly reason: string; readonly requestedHostName?: string };

function normalizePath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .trim();
}

function hostConfigPrefixes(hostName: string): ReadonlyArray<string> {
  return [`hosts/${hostName}/`, `machines/${hostName}/`, `profiles/${hostName}/`];
}

function resolvePathHostName(
  path: string,
  hostFilePatterns: ReadonlyArray<HostFilePattern>,
): string | null {
  const normalizedPath = normalizePath(path).toLowerCase();
  for (const pattern of hostFilePatterns) {
    const normalizedHostName = normalizeHostName(pattern.hostName);
    if (normalizedHostName === null) {
      continue;
    }
    if (
      pattern.patterns.some((entry) =>
        normalizedPath.startsWith(normalizePath(entry).toLowerCase()),
      )
    ) {
      return normalizedHostName;
    }
    if (hostConfigPrefixes(normalizedHostName).some((entry) => normalizedPath.startsWith(entry))) {
      return normalizedHostName;
    }
  }

  const segmentMatch = normalizedPath.match(/(?:^|\/)(hosts|machines|profiles)\/([^/]+)/);
  return segmentMatch?.[2] ?? null;
}

function isSharedConfigPath(path: string): boolean {
  const normalizedPath = normalizePath(path).toLowerCase();
  return (
    normalizedPath === "flake.nix" ||
    normalizedPath.startsWith("modules/common/") ||
    normalizedPath.startsWith("modules/shared/") ||
    normalizedPath.startsWith("overlays/") ||
    normalizedPath.startsWith("packages/") ||
    normalizedPath.startsWith("secrets/")
  );
}

function commandMentionsOtherHost(command: string, scopedHostName: string): string | null {
  const hostAttrMatch =
    command.match(/(?:nixos|darwin|home)Configurations\.([a-z0-9._-]+)/i)?.[1] ??
    command.match(/deploy\.nodes\.([a-z0-9._-]+)/i)?.[1] ??
    null;
  const normalizedMention = normalizeHostName(hostAttrMatch);
  if (normalizedMention === null) {
    return null;
  }
  return normalizedMention === scopedHostName ? null : normalizedMention;
}

export function evaluateActionScope(input: {
  readonly scope: ResolvedThreadScope;
  readonly action: ScopeAction;
  readonly hostFilePatterns?: ReadonlyArray<HostFilePattern>;
}): ScopePolicyDecision {
  if (input.scope.kind !== "host") {
    return { kind: "allow" };
  }

  const scopedHostName = normalizeHostName(input.scope.hostName);
  if (scopedHostName === null) {
    return { kind: "allow" };
  }
  const hostFilePatterns = input.hostFilePatterns ?? [];

  switch (input.action.kind) {
    case "file-change": {
      const requestedHostName = resolvePathHostName(input.action.path, hostFilePatterns);
      if (requestedHostName && requestedHostName !== scopedHostName) {
        return {
          kind: "block",
          reason: `This thread is locked to ${scopedHostName} and cannot modify ${requestedHostName} host files without explicit scope expansion.`,
          requestedHostName,
        };
      }
      if (requestedHostName === scopedHostName) {
        return {
          kind: "allow",
          resolvedHostName: scopedHostName,
        };
      }
      if (isSharedConfigPath(input.action.path)) {
        return {
          kind: "require-explicit-approval",
          reason: "This change touches shared configuration that may affect multiple hosts.",
        };
      }
      return {
        kind: "warn",
        reason:
          "This path is not clearly isolated to the scoped host. Confirm broader impact before applying it.",
        resolvedHostName: scopedHostName,
      };
    }

    case "command": {
      const requestedHostName = commandMentionsOtherHost(input.action.command, scopedHostName);
      if (requestedHostName) {
        return {
          kind: "block",
          reason: `This thread is locked to ${scopedHostName} and cannot target ${requestedHostName} through a command without scope expansion.`,
          requestedHostName,
        };
      }
      if (/nix flake check/i.test(input.action.command)) {
        return {
          kind: "allow",
          resolvedHostName: scopedHostName,
        };
      }
      return {
        kind: "warn",
        reason:
          "Review this command for cross-host or shared configuration impact before running it.",
        resolvedHostName: scopedHostName,
      };
    }

    case "nix-eval": {
      const requestedHostName =
        normalizeHostName(input.action.hostName) ??
        normalizeHostName(
          input.action.attr?.match(/(?:nixos|darwin|home)Configurations\.([a-z0-9._-]+)/i)?.[1],
        );
      if (requestedHostName === null || requestedHostName === scopedHostName) {
        return {
          kind: "allow",
          resolvedHostName: scopedHostName,
        };
      }
      return {
        kind: "block",
        reason: `This thread is locked to ${scopedHostName} and cannot evaluate ${requestedHostName} as a host-specific target without scope expansion.`,
        requestedHostName,
      };
    }

    case "deploy-host": {
      const requestedHostName = normalizeHostName(input.action.hostName) ?? scopedHostName;
      if (requestedHostName === scopedHostName) {
        return {
          kind: "allow",
          resolvedHostName: scopedHostName,
        };
      }
      return {
        kind: "block",
        reason: `This thread is locked to ${scopedHostName} and cannot deploy ${requestedHostName} without explicit scope expansion.`,
        requestedHostName,
      };
    }

    case "deploy-fleet":
      return {
        kind: "require-explicit-approval",
        reason: `Fleet deployment broadens scope beyond ${scopedHostName}.`,
      };
  }
}
