import { existsSync } from "node:fs";
import path from "node:path";
import type {
  OrchestrationProject,
  OrchestrationThread,
  ProviderTurnContext,
} from "@t3tools/contracts";
import { FLAKE_REPO_STYLE_RELATIVE_PATH } from "@t3tools/shared/flakeWorkflow";

import {
  HOST_DOCS_DIR,
  GENERAL_CHANGELOG_PATH,
  resolveProjectHosts,
  slugHostName,
} from "../orchestration/DocumentationUtils.ts";
import { resolveThreadScope } from "../orchestration/threadScope.ts";

function isFlakeProject(project: OrchestrationProject): boolean {
  const flakeMetadata = project.flakeMetadata ?? null;
  if (flakeMetadata !== null && flakeMetadata.source !== "missing") {
    return true;
  }
  return existsSync(path.join(project.workspaceRoot, "flake.nix"));
}

export function buildProviderTurnContext(input: {
  readonly project: OrchestrationProject;
  readonly thread: OrchestrationThread;
}): ProviderTurnContext {
  const flakeProject = isFlakeProject(input.project);
  const resolvedScope = resolveThreadScope({
    project: input.project,
    thread: input.thread,
  });
  const scopedHostName = resolvedScope.kind === "host" ? resolvedScope.hostName : null;
  const workflow =
    input.thread.workflow?.kind === "host-creation"
      ? {
          kind: "host-creation" as const,
          hostName: input.thread.workflow.hostName,
          ...(input.thread.workflow.target !== undefined
            ? { target: input.thread.workflow.target }
            : {}),
          ...(input.thread.workflow.osFamily !== undefined
            ? { osFamily: input.thread.workflow.osFamily }
            : {}),
          ...(input.thread.workflow.bootstrapMode !== undefined
            ? { bootstrapMode: input.thread.workflow.bootstrapMode }
            : {}),
          ...(input.thread.workflow.sourceSshTarget !== undefined
            ? { sourceSshTarget: input.thread.workflow.sourceSshTarget }
            : {}),
          ...(input.thread.workflow.hostType !== undefined
            ? { hostType: input.thread.workflow.hostType }
            : {}),
          ...(input.thread.workflow.status !== undefined
            ? { status: input.thread.workflow.status }
            : {}),
        }
      : input.thread.workflow?.kind === "host-removal"
        ? {
            kind: "host-removal" as const,
            hostName: input.thread.workflow.hostName,
            ...(input.thread.workflow.target !== undefined
              ? { target: input.thread.workflow.target }
              : {}),
            ...(input.thread.workflow.hostType !== undefined
              ? { hostType: input.thread.workflow.hostType }
              : {}),
            ...(input.thread.workflow.status !== undefined
              ? { status: input.thread.workflow.status }
              : {}),
          }
        : input.thread.workflow?.kind === "flake-creation"
          ? {
              kind: "flake-creation" as const,
              hostScale: input.thread.workflow.hostScale,
              platformMatrix: input.thread.workflow.platformMatrix,
              homeManager: input.thread.workflow.homeManager,
              moduleStyle: input.thread.workflow.moduleStyle,
              ...(input.thread.workflow.moduleNamespace !== undefined
                ? { moduleNamespace: input.thread.workflow.moduleNamespace }
                : {}),
              layoutPattern: input.thread.workflow.layoutPattern,
              ...(input.thread.workflow.status !== undefined
                ? { status: input.thread.workflow.status }
                : {}),
            }
          : undefined;

  if (!flakeProject) {
    return {
      projectKind: "generic",
      workspaceRoot: input.project.workspaceRoot,
      remoteHostAccessPolicy: input.thread.remoteHostAccessPolicy,
      ...(scopedHostName !== null ? { scopedHostName } : {}),
      ...(workflow !== undefined ? { workflow } : {}),
    };
  }

  const flakeMetadata = input.project.flakeMetadata;
  const hostNames = resolveProjectHosts(flakeMetadata).map((host) => host.name);
  const flakeContext: NonNullable<ProviderTurnContext["flake"]> = {
    flakePath: flakeMetadata?.flakePath ?? null,
    ...(hostNames.length > 0 ? { hostNames } : {}),
    ...(resolvedScope.kind === "host" && resolvedScope.flakeAttr
      ? { hostFlakeAttr: resolvedScope.flakeAttr }
      : {}),
    documentationPaths: {
      generalChanges: GENERAL_CHANGELOG_PATH,
      ...(existsSync(path.join(input.project.workspaceRoot, FLAKE_REPO_STYLE_RELATIVE_PATH))
        ? { repoStyle: FLAKE_REPO_STYLE_RELATIVE_PATH }
        : {}),
      ...(scopedHostName !== null
        ? {
            hostDoc:
              resolvedScope.kind === "host"
                ? (resolvedScope.hostDocPath ??
                  `${HOST_DOCS_DIR}/${slugHostName(scopedHostName)}.md`)
                : `${HOST_DOCS_DIR}/${slugHostName(scopedHostName)}.md`,
          }
        : {}),
    },
  };

  return {
    projectKind: "nix-flake",
    workspaceRoot: input.project.workspaceRoot,
    remoteHostAccessPolicy: input.thread.remoteHostAccessPolicy,
    ...(scopedHostName !== null ? { scopedHostName } : {}),
    ...(workflow !== undefined ? { workflow } : {}),
    flake: flakeContext,
  };
}
