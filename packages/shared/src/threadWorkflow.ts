import type { ThreadWorkflow } from "@t3tools/contracts";

import {
  buildFlakeCreationBadgeLabel,
  buildFlakeCreationStartLabel,
  buildFlakeCreationStarterPrompt,
  buildFlakeCreationThreadTitle,
  markFlakeWorkflowReadyToImplement,
} from "./flakeWorkflow.ts";
import {
  buildHostWorkflowBadgeLabel,
  buildHostWorkflowStartLabel,
  buildHostWorkflowStarterPrompt,
  buildHostWorkflowThreadTitle,
  markHostWorkflowReadyToImplement,
} from "./hostWorkflow.ts";

export function buildThreadWorkflowTitle(workflow: ThreadWorkflow): string {
  switch (workflow.kind) {
    case "host-creation":
    case "host-removal":
      return buildHostWorkflowThreadTitle(workflow);
    case "flake-creation":
      return buildFlakeCreationThreadTitle();
  }
}

export function buildThreadWorkflowBadgeLabel(workflow: ThreadWorkflow): string {
  switch (workflow.kind) {
    case "host-creation":
    case "host-removal":
      return buildHostWorkflowBadgeLabel(workflow);
    case "flake-creation":
      return buildFlakeCreationBadgeLabel();
  }
}

export function buildThreadWorkflowStartLabel(workflow: ThreadWorkflow): string {
  switch (workflow.kind) {
    case "host-creation":
    case "host-removal":
      return buildHostWorkflowStartLabel(workflow);
    case "flake-creation":
      return buildFlakeCreationStartLabel();
  }
}

export function buildThreadWorkflowStarterPrompt(workflow: ThreadWorkflow): string {
  switch (workflow.kind) {
    case "host-creation":
    case "host-removal":
      return buildHostWorkflowStarterPrompt(workflow);
    case "flake-creation":
      return buildFlakeCreationStarterPrompt(workflow);
  }
}

export function markThreadWorkflowReadyToImplement(workflow: ThreadWorkflow): ThreadWorkflow {
  switch (workflow.kind) {
    case "host-creation":
    case "host-removal":
      return markHostWorkflowReadyToImplement(workflow);
    case "flake-creation":
      return markFlakeWorkflowReadyToImplement(workflow);
  }
}
