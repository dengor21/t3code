import type { HostCreationWorkflow, HostRemovalWorkflow, ThreadWorkflow } from "@t3tools/contracts";

export const HOST_CREATION_WORKFLOW_KIND = "host-creation";
export const HOST_REMOVAL_WORKFLOW_KIND = "host-removal";
export const HOST_CREATION_BADGE_LABEL = "Create host";
export const HOST_REMOVAL_BADGE_LABEL = "Remove host";
export const HOST_CREATION_START_LABEL = "Begin guided setup";
export const HOST_REMOVAL_START_LABEL = "Begin removal plan";
export const HOST_WORKFLOW_HOST_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export const HOST_CREATION_STAGES = [
  { key: "identity", label: "Identity" },
  { key: "hardware", label: "Hardware" },
  { key: "research", label: "Research" },
  { key: "base-system", label: "Base system" },
  { key: "software", label: "Software" },
  { key: "network-access", label: "Network access" },
  { key: "review", label: "Review" },
  { key: "handoff", label: "Handoff" },
] as const;

export const HOST_REMOVAL_STAGES = [
  { key: "audit", label: "Audit" },
  { key: "impact", label: "Impact" },
  { key: "removal", label: "Removal" },
  { key: "cleanup", label: "Cleanup" },
  { key: "review", label: "Review" },
  { key: "handoff", label: "Handoff" },
] as const;

export type HostCreationStageKey = (typeof HOST_CREATION_STAGES)[number]["key"];
export type HostRemovalStageKey = (typeof HOST_REMOVAL_STAGES)[number]["key"];

export function normalizeHostWorkflowHostName(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeHostCreationHostName(value: string): string {
  return normalizeHostWorkflowHostName(value);
}

export function isValidHostWorkflowHostName(value: string): boolean {
  return HOST_WORKFLOW_HOST_NAME_PATTERN.test(normalizeHostWorkflowHostName(value));
}

export function isValidHostCreationHostName(value: string): boolean {
  return isValidHostWorkflowHostName(value);
}

export function resolveHostCreationTarget(
  value: string | null | undefined,
  hostName: string,
): string {
  const normalizedValue = value?.trim() ?? "";
  if (normalizedValue.length > 0) {
    return normalizedValue;
  }
  return hostName;
}

export function buildHostCreationThreadTitle(hostName: string): string {
  return `Create host: ${hostName}`;
}

export function buildHostRemovalThreadTitle(hostName: string): string {
  return `Remove host: ${hostName}`;
}

export function buildHostWorkflowThreadTitle(workflow: ThreadWorkflow): string {
  switch (workflow.kind) {
    case "host-creation":
      return buildHostCreationThreadTitle(workflow.hostName);
    case "host-removal":
      return buildHostRemovalThreadTitle(workflow.hostName);
  }
}

export function buildHostWorkflowBadgeLabel(workflow: ThreadWorkflow): string {
  switch (workflow.kind) {
    case "host-creation":
      return HOST_CREATION_BADGE_LABEL;
    case "host-removal":
      return HOST_REMOVAL_BADGE_LABEL;
  }
}

export function buildHostWorkflowStartLabel(workflow: ThreadWorkflow): string {
  switch (workflow.kind) {
    case "host-creation":
      return HOST_CREATION_START_LABEL;
    case "host-removal":
      return HOST_REMOVAL_START_LABEL;
  }
}

function buildHostCreationPlanGuidance(workflow: HostCreationWorkflow): ReadonlyArray<string> {
  return [
    "- Ask hardware questions before recommending partitioning or install details.",
    "- After the hardware picture is clear, browse current official sources before recommending install or partitioning details and state the browsing date explicitly.",
    "- Prefer the NixOS manual, nixos-anywhere, Home Manager, and disko before community sources.",
    `- Treat t3hosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix as mandatory anchors in the final plan.`,
    "- Discover optional scaffold files from this repo instead of assuming a fixed flake layout.",
    "- Avoid broad repo changes unless the plan clearly justifies them.",
  ];
}

function buildHostCreationImplementationGuidance(
  workflow: HostCreationWorkflow,
): ReadonlyArray<string> {
  return [
    "- Treat the approved plan and prior planning decisions as the source of truth.",
    `- Keep writes scoped to ${workflow.hostName} unless the approved plan explicitly requires shared-module changes.`,
    `- Ensure the implementation includes t3hosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix.`,
    "- Discover optional scaffold structure from the repo instead of assuming a fixed flake layout.",
    "- Minimize blast radius and call out any cross-host impact from shared-module edits.",
  ];
}

function buildHostRemovalPlanGuidance(workflow: HostRemovalWorkflow): ReadonlyArray<string> {
  return [
    "- Start by auditing this repo for every reference to the host before proposing deletions.",
    `- Treat t3hosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix as mandatory removal anchors when they exist.`,
    "- Identify deploy targets, documentation, secrets, shared modules, and automation references that may need cleanup.",
    "- Separate safe repo changes from manual follow-up steps such as decommissioning infrastructure, DNS, credentials, or monitoring.",
    "- Avoid broad repo changes unless the plan clearly justifies them.",
  ];
}

function buildHostRemovalImplementationGuidance(
  workflow: HostRemovalWorkflow,
): ReadonlyArray<string> {
  return [
    "- Treat the approved plan and prior planning decisions as the source of truth.",
    `- Remove t3hosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix when the approved plan includes them.`,
    "- Keep cleanup scoped to the approved host-related references and avoid deleting unrelated shared code.",
    "- Minimize blast radius and call out any manual follow-up that still remains after the repo changes land.",
  ];
}

export function buildHostWorkflowPlanGuidance(workflow: ThreadWorkflow): ReadonlyArray<string> {
  switch (workflow.kind) {
    case "host-creation":
      return buildHostCreationPlanGuidance(workflow);
    case "host-removal":
      return buildHostRemovalPlanGuidance(workflow);
  }
}

export function buildHostWorkflowImplementationGuidance(
  workflow: ThreadWorkflow,
): ReadonlyArray<string> {
  switch (workflow.kind) {
    case "host-creation":
      return buildHostCreationImplementationGuidance(workflow);
    case "host-removal":
      return buildHostRemovalImplementationGuidance(workflow);
  }
}

export function buildHostCreationStarterPrompt(workflow: HostCreationWorkflow): string {
  const target = resolveHostCreationTarget(workflow.target ?? null, workflow.hostName);
  const osFamily = workflow.osFamily ?? "nixos";
  const hostType = workflow.hostType?.trim() ? workflow.hostType.trim() : "unspecified";
  const targetIsPlaceholder = (workflow.target?.trim() ?? "").length === 0;

  return [
    "Begin the guided host-creation workflow for this new flake host.",
    "",
    "Seed facts:",
    `- host name: ${workflow.hostName}`,
    `- target: ${target}${targetIsPlaceholder ? " (placeholder until I provide the final target)" : ""}`,
    `- os family: ${osFamily}`,
    `- host type: ${hostType}`,
    "",
    "Work in stages and keep your running plan aligned to these stages:",
    ...HOST_CREATION_STAGES.map((stage) => `- ${stage.key}: ${stage.label}`),
    "",
    "Workflow rules:",
    "- When a decision is missing, ask concise structured follow-up questions.",
    ...buildHostCreationPlanGuidance(workflow),
    "- Keep this planning-only until I approve implementation.",
    "",
    "The final response should be a single decision-complete <proposed_plan> ready for implementation, including install handoff guidance and explicit assumptions.",
  ].join("\n");
}

export function buildHostRemovalStarterPrompt(workflow: HostRemovalWorkflow): string {
  const target = workflow.target?.trim() || null;
  const hostType = workflow.hostType?.trim() ? workflow.hostType.trim() : null;

  return [
    "Begin the guided host-removal workflow for this flake host.",
    "",
    "Seed facts:",
    `- host name: ${workflow.hostName}`,
    ...(target ? [`- target: ${target}`] : []),
    ...(hostType ? [`- host type: ${hostType}`] : []),
    "",
    "Work in stages and keep your running plan aligned to these stages:",
    ...HOST_REMOVAL_STAGES.map((stage) => `- ${stage.key}: ${stage.label}`),
    "",
    "Workflow rules:",
    ...buildHostRemovalPlanGuidance(workflow),
    "- Keep this planning-only until I approve implementation.",
    "",
    "The final response should be a single decision-complete <proposed_plan> ready for implementation, with explicit assumptions and manual follow-up steps.",
  ].join("\n");
}

export function buildHostWorkflowStarterPrompt(workflow: ThreadWorkflow): string {
  switch (workflow.kind) {
    case "host-creation":
      return buildHostCreationStarterPrompt(workflow);
    case "host-removal":
      return buildHostRemovalStarterPrompt(workflow);
  }
}

export function markHostWorkflowReadyToImplement(workflow: ThreadWorkflow): ThreadWorkflow {
  switch (workflow.kind) {
    case "host-creation":
      return {
        ...workflow,
        status: "ready-to-implement",
      };
    case "host-removal":
      return {
        ...workflow,
        status: "ready-to-implement",
      };
  }
}
