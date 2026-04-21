import { existsSync } from "node:fs";
import path from "node:path";
import type {
  OrchestrationProject,
  OrchestrationThread,
  ProviderTurnContext,
} from "@t3tools/contracts";

import {
  HOST_DOCS_DIR,
  GENERAL_CHANGELOG_PATH,
  resolveProjectHosts,
  slugHostName,
} from "../orchestration/DocumentationUtils.ts";

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
  const scopedHostName = input.thread.scopedHostName ?? null;
  const workflow =
    input.thread.workflow?.kind === "host-creation"
      ? {
          kind: "host-creation" as const,
          hostName: input.thread.workflow.hostName,
          ...(input.thread.workflow.osFamily !== undefined
            ? { osFamily: input.thread.workflow.osFamily }
            : {}),
          ...(input.thread.workflow.status !== undefined
            ? { status: input.thread.workflow.status }
            : {}),
        }
      : input.thread.workflow?.kind === "host-removal"
        ? {
            kind: "host-removal" as const,
            hostName: input.thread.workflow.hostName,
            ...(input.thread.workflow.status !== undefined
              ? { status: input.thread.workflow.status }
              : {}),
          }
        : undefined;

  if (!flakeProject) {
    return {
      projectKind: "generic",
      workspaceRoot: input.project.workspaceRoot,
      ...(scopedHostName !== null ? { scopedHostName } : {}),
      ...(workflow !== undefined ? { workflow } : {}),
    };
  }

  const flakeMetadata = input.project.flakeMetadata;
  const hostNames = resolveProjectHosts(flakeMetadata).map((host) => host.name);
  const flakeContext: NonNullable<ProviderTurnContext["flake"]> = {
    flakePath: flakeMetadata?.flakePath ?? null,
    ...(hostNames.length > 0 ? { hostNames } : {}),
    documentationPaths: {
      generalChanges: GENERAL_CHANGELOG_PATH,
      ...(scopedHostName !== null
        ? { hostDoc: `${HOST_DOCS_DIR}/${slugHostName(scopedHostName)}.md` }
        : {}),
    },
  };

  return {
    projectKind: "nix-flake",
    workspaceRoot: input.project.workspaceRoot,
    ...(scopedHostName !== null ? { scopedHostName } : {}),
    ...(workflow !== undefined ? { workflow } : {}),
    flake: flakeContext,
  };
}
