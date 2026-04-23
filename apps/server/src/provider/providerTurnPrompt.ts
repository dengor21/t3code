import type {
  ProviderInteractionMode,
  ProviderSendTurnInput,
  ProviderTurnContext,
  ThreadWorkflow,
} from "@t3tools/contracts";
import {
  buildHostWorkflowImplementationGuidance,
  buildHostWorkflowPlanGuidance,
} from "@t3tools/shared/hostWorkflow";

function toThreadWorkflow(workflow: ProviderTurnContext["workflow"]): ThreadWorkflow | undefined {
  if (!workflow) {
    return undefined;
  }

  switch (workflow.kind) {
    case "host-creation":
      return {
        kind: "host-creation",
        hostName: workflow.hostName,
        ...(workflow.osFamily !== undefined ? { osFamily: workflow.osFamily } : {}),
        ...(workflow.status !== undefined ? { status: workflow.status } : {}),
      };
    case "host-removal":
      return {
        kind: "host-removal",
        hostName: workflow.hostName,
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
  if (providerContext.scopedHostName) {
    lines.push(`- Primary host scope for this thread: ${providerContext.scopedHostName}.`);
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
      return implementationMode
        ? [
            `- This thread is implementing the approved host-creation plan for ${workflow.hostName}.`,
            ...buildHostWorkflowImplementationGuidance(workflow),
          ]
        : [
            `- This thread is planning creation of host ${workflow.hostName}.`,
            ...buildHostWorkflowPlanGuidance(workflow),
            "- Keep the thread planning-only until implementation is explicitly approved.",
            "- Finish planning with a single decision-complete <proposed_plan>.",
          ];
    case "host-removal":
      return implementationMode
        ? [
            `- This thread is implementing the approved host-removal plan for ${workflow.hostName}.`,
            ...buildHostWorkflowImplementationGuidance(workflow),
          ]
        : [
            `- This thread is planning removal of host ${workflow.hostName}.`,
            ...buildHostWorkflowPlanGuidance(workflow),
            "- Keep the thread planning-only until implementation is explicitly approved.",
            "- Finish planning with a single decision-complete <proposed_plan>.",
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

  return `Use the following repo context for this request:\n\n${sections.join("\n\n")}`;
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
