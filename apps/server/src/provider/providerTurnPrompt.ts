import type {
  ProviderInteractionMode,
  ProviderSendTurnInput,
  ProviderTurnContext,
  ThreadWorkflow,
} from "@t3tools/contracts";
import {
  buildHostWorkflowImplementationGuidance,
  buildHostWorkflowPlanningOutcomeGuidance,
  buildHostWorkflowPlanGuidance,
  resolveHostCreationBootstrapMode,
} from "@t3tools/shared/hostWorkflow";

import { buildScopedHostInstructionBlock } from "./hostScopeInstructions.ts";
import { buildThreadScopeCapsule } from "./threadScopeCapsule.ts";

function toThreadWorkflow(workflow: ProviderTurnContext["workflow"]): ThreadWorkflow | undefined {
  if (!workflow) {
    return undefined;
  }

  switch (workflow.kind) {
    case "host-creation":
      return {
        kind: "host-creation",
        hostName: workflow.hostName,
        ...(workflow.target !== undefined ? { target: workflow.target } : {}),
        ...(workflow.osFamily !== undefined ? { osFamily: workflow.osFamily } : {}),
        ...(workflow.bootstrapMode !== undefined ? { bootstrapMode: workflow.bootstrapMode } : {}),
        ...(workflow.sourceSshTarget !== undefined
          ? { sourceSshTarget: workflow.sourceSshTarget }
          : {}),
        ...(workflow.hostType !== undefined ? { hostType: workflow.hostType } : {}),
        ...(workflow.status !== undefined ? { status: workflow.status } : {}),
      };
    case "host-removal":
      return {
        kind: "host-removal",
        hostName: workflow.hostName,
        ...(workflow.target !== undefined ? { target: workflow.target } : {}),
        ...(workflow.hostType !== undefined ? { hostType: workflow.hostType } : {}),
        ...(workflow.status !== undefined ? { status: workflow.status } : {}),
      };
  }
}

function buildFlakeContextLines(providerContext: ProviderTurnContext): ReadonlyArray<string> {
  if (providerContext.projectKind !== "nix-flake") {
    return [];
  }

  const lines = ["- This workspace is a Nix flake repository."];
  if (providerContext.flake?.flakePath) {
    lines.push(`- Primary flake entrypoint: ${providerContext.flake.flakePath}.`);
  }
  if (providerContext.flake?.documentationPaths?.generalChanges) {
    lines.push(
      `- Flake-wide change log path: ${providerContext.flake.documentationPaths.generalChanges}.`,
    );
  }
  if (providerContext.flake?.documentationPaths?.hostDoc) {
    lines.push(`- Host documentation path: ${providerContext.flake.documentationPaths.hostDoc}.`);
  }
  return lines;
}

function buildWorkflowContextLines(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly providerContext: ProviderTurnContext;
}): ReadonlyArray<string> {
  const workflow = toThreadWorkflow(input.providerContext.workflow);
  if (!workflow) {
    return [];
  }

  const implementationMode =
    input.interactionMode !== "plan" && workflow.status === "ready-to-implement";

  switch (workflow.kind) {
    case "host-creation":
      return [
        `- This thread is ${
          implementationMode
            ? "implementing the approved host-creation plan for"
            : "planning creation of"
        } host ${workflow.hostName}${
          resolveHostCreationBootstrapMode(workflow.bootstrapMode) === "existing-via-ssh"
            ? " by importing an existing system over SSH."
            : "."
        }`,
        ...(workflow.target ? [`- Planned deploy target: ${workflow.target}.`] : []),
        ...(workflow.sourceSshTarget
          ? [`- SSH discovery target: ${workflow.sourceSshTarget}.`]
          : []),
        ...(workflow.osFamily ? [`- Target OS family: ${workflow.osFamily}.`] : []),
        ...(workflow.hostType ? [`- Host type hint: ${workflow.hostType}.`] : []),
        ...(implementationMode
          ? buildHostWorkflowImplementationGuidance(workflow)
          : [
              ...buildHostWorkflowPlanGuidance(workflow),
              "- Keep the thread planning-only until implementation is explicitly approved.",
              ...buildHostWorkflowPlanningOutcomeGuidance(workflow),
            ]),
      ];
    case "host-removal":
      return implementationMode
        ? [
            `- This thread is implementing the approved host-removal plan for ${workflow.hostName}.`,
            ...(workflow.target ? [`- Removal target: ${workflow.target}.`] : []),
            ...(workflow.hostType ? [`- Host type hint: ${workflow.hostType}.`] : []),
            ...buildHostWorkflowImplementationGuidance(workflow),
          ]
        : [
            `- This thread is planning removal of host ${workflow.hostName}.`,
            ...(workflow.target ? [`- Removal target: ${workflow.target}.`] : []),
            ...(workflow.hostType ? [`- Host type hint: ${workflow.hostType}.`] : []),
            ...buildHostWorkflowPlanGuidance(workflow),
            "- Keep the thread planning-only until implementation is explicitly approved.",
            ...buildHostWorkflowPlanningOutcomeGuidance(workflow),
          ];
  }
}

export function buildProviderTurnPromptPreamble(input: {
  readonly interactionMode?: ProviderInteractionMode;
  readonly providerContext?: ProviderTurnContext;
}): string | null {
  if (!input.providerContext) {
    return null;
  }

  const sections: Array<string> = [];
  const capsule = buildThreadScopeCapsule({
    providerContext: input.providerContext,
  });
  if (capsule) {
    sections.push(capsule);
  }
  const hostScopeBlock = buildScopedHostInstructionBlock(input.providerContext);
  if (hostScopeBlock) {
    sections.push(hostScopeBlock);
  }
  const flakeContextLines = buildFlakeContextLines(input.providerContext);
  if (flakeContextLines.length > 0) {
    sections.push(["Repository context:", ...flakeContextLines].join("\n"));
  }

  const workflowContextLines = buildWorkflowContextLines({
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    providerContext: input.providerContext,
  });
  if (workflowContextLines.length > 0) {
    sections.push(["Workflow context:", ...workflowContextLines].join("\n"));
  }

  if (sections.length === 0) {
    return null;
  }

  return `Use the following HAL runtime context for this request. Treat it as authoritative for scope resolution.\n\n${sections.join("\n\n")}`;
}

export function applyProviderTurnPromptPreamble(
  input: ProviderSendTurnInput,
): ProviderSendTurnInput {
  const preamble = buildProviderTurnPromptPreamble({
    ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
    ...(input.providerContext !== undefined ? { providerContext: input.providerContext } : {}),
  });
  if (!preamble) {
    return input;
  }

  const trimmedInput = input.input?.trim() ?? "";
  const nextInput =
    trimmedInput.length > 0 ? `${preamble}\n\nUser request:\n${trimmedInput}` : preamble;

  return {
    ...input,
    input: nextInput,
  };
}
