import type { FlakeHost } from "@t3tools/contracts";
import type {
  NixDesignerScope,
  OrchestrationProject,
  OrchestrationThread,
} from "@t3tools/contracts";
import {
  designerFromScopedHostName,
  designerScopesEqual,
  normalizeHostName,
} from "@t3tools/shared/threadScope";

import { HOST_DOCS_DIR, resolveProjectHosts, slugHostName } from "./DocumentationUtils.ts";

export type ResolvedThreadScope =
  | {
      readonly kind: "project";
      readonly projectId: string;
      readonly workspaceRoot: string;
      readonly locked: false;
      readonly source: "default" | "designer";
    }
  | {
      readonly kind: "host";
      readonly projectId: string;
      readonly workspaceRoot: string;
      readonly hostName: string;
      readonly locked: true;
      readonly source: "scopedHostName" | "designer" | "workflow" | "derived";
      readonly flakeAttr?: string;
      readonly hostDocPath?: string;
      readonly deployTarget?: string;
    };

function normalizeHostType(host: FlakeHost): string | null {
  const explicit = normalizeHostName(host.type ?? null)?.toLowerCase() ?? null;
  if (explicit) {
    return explicit;
  }

  const system = normalizeHostName(host.system ?? null)?.toLowerCase() ?? null;
  if (system?.endsWith("-linux")) {
    return "nixos";
  }
  if (system?.endsWith("-darwin")) {
    return "darwin";
  }
  return null;
}

function resolveHostFlakeAttr(host: FlakeHost | null, hostName: string): string | undefined {
  const resolvedHostName = host?.name ?? hostName;
  const normalizedType = host ? normalizeHostType(host) : null;
  switch (normalizedType) {
    case "nixos":
      return `nixosConfigurations.${resolvedHostName}`;
    case "darwin":
    case "nix-darwin":
      return `darwinConfigurations.${resolvedHostName}`;
    case "home":
    case "home-manager":
      return `homeConfigurations.${resolvedHostName}`;
    default:
      return `nixosConfigurations.${resolvedHostName}`;
  }
}

function resolveProjectHost(project: OrchestrationProject, hostName: string): FlakeHost | null {
  const normalizedHostName = normalizeHostName(hostName);
  if (normalizedHostName === null) {
    return null;
  }

  return (
    resolveProjectHosts(project.flakeMetadata ?? null).find(
      (host) => normalizeHostName(host.name) === normalizedHostName,
    ) ?? null
  );
}

function resolveHostDocPath(project: OrchestrationProject, hostName: string): string | undefined {
  const normalizedHostName = normalizeHostName(hostName);
  if (normalizedHostName === null) {
    return undefined;
  }

  const documentedHost =
    project.documentationState?.hosts.find(
      (host) => normalizeHostName(host.hostName) === normalizedHostName,
    ) ?? null;

  return documentedHost?.docPath ?? `${HOST_DOCS_DIR}/${slugHostName(normalizedHostName)}.md`;
}

export { normalizeHostName, designerFromScopedHostName, designerScopesEqual };

export function resolveThreadScope(input: {
  readonly project: OrchestrationProject;
  readonly thread: OrchestrationThread;
}): ResolvedThreadScope {
  const scopedHostName = normalizeHostName(input.thread.scopedHostName ?? null);
  const designerHostName =
    input.thread.designer?.kind === "host"
      ? normalizeHostName(input.thread.designer.hostName)
      : null;
  const hostName = scopedHostName ?? designerHostName;

  if (hostName !== null) {
    const projectHost = resolveProjectHost(input.project, hostName);
    const flakeAttr = resolveHostFlakeAttr(projectHost, hostName);
    const hostDocPath = resolveHostDocPath(input.project, hostName);
    return {
      kind: "host",
      projectId: input.project.id,
      workspaceRoot: input.project.workspaceRoot,
      hostName: projectHost?.name ?? hostName,
      locked: true,
      source: scopedHostName !== null ? "scopedHostName" : "designer",
      ...(flakeAttr !== undefined ? { flakeAttr } : {}),
      ...(hostDocPath !== undefined ? { hostDocPath } : {}),
      ...(projectHost?.target ? { deployTarget: projectHost.target } : {}),
    };
  }

  return {
    kind: "project",
    projectId: input.project.id,
    workspaceRoot: input.project.workspaceRoot,
    locked: false,
    source: input.thread.designer?.kind === "project" ? "designer" : "default",
  };
}

export function resolveEffectiveDesigner(input: {
  readonly thread: OrchestrationThread;
  readonly requestedDesigner?: NixDesignerScope | null;
}): NixDesignerScope | null {
  const scopedDesigner = designerFromScopedHostName(input.thread.scopedHostName ?? null);

  if (
    scopedDesigner &&
    input.requestedDesigner &&
    !designerScopesEqual(scopedDesigner, input.requestedDesigner)
  ) {
    throw new Error(
      `Thread '${input.thread.id}' is scoped to host '${scopedDesigner.hostName}' and cannot use designer '${JSON.stringify(input.requestedDesigner)}'.`,
    );
  }

  if (scopedDesigner) {
    return scopedDesigner;
  }
  if (input.requestedDesigner !== undefined) {
    return input.requestedDesigner;
  }
  return input.thread.designer ?? null;
}

export function assertThreadScopeCoherent(input: {
  readonly threadId: string;
  readonly scopedHostName?: string | null;
  readonly currentDesigner?: NixDesignerScope | null;
  readonly requestedDesigner?: NixDesignerScope | null;
}): void {
  const scopedDesigner = designerFromScopedHostName(input.scopedHostName ?? null);
  if (scopedDesigner === null) {
    return;
  }

  if (
    input.requestedDesigner !== undefined &&
    input.requestedDesigner !== null &&
    !designerScopesEqual(scopedDesigner, input.requestedDesigner)
  ) {
    throw new Error(
      `Thread '${input.threadId}' is scoped to host '${scopedDesigner.hostName}' and cannot use designer '${JSON.stringify(input.requestedDesigner)}'.`,
    );
  }

  if (
    input.currentDesigner !== undefined &&
    input.currentDesigner !== null &&
    !designerScopesEqual(scopedDesigner, input.currentDesigner)
  ) {
    const repairingLegacyState =
      input.requestedDesigner === undefined ||
      input.requestedDesigner === null ||
      designerScopesEqual(scopedDesigner, input.requestedDesigner);

    if (!repairingLegacyState) {
      throw new Error(
        `Thread '${input.threadId}' has scopedHostName '${scopedDesigner.hostName}' but designer '${JSON.stringify(input.currentDesigner)}'.`,
      );
    }
  }
}
