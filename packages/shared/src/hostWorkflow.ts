import type {
  HostCreationWorkflow,
  HostCreationWorkflowBootstrapMode,
  HostRemovalWorkflow,
  ThreadWorkflow,
} from "@t3tools/contracts";

export const HOST_CREATION_WORKFLOW_KIND = "host-creation";
export const HOST_REMOVAL_WORKFLOW_KIND = "host-removal";
export const HOST_CREATION_BADGE_LABEL = "Create host";
export const HOST_REMOVAL_BADGE_LABEL = "Remove host";
export const HOST_CREATION_START_LABEL = "Begin guided setup";
export const HOST_CREATION_SSH_IMPORT_START_LABEL = "Begin SSH analysis";
export const HOST_REMOVAL_START_LABEL = "Begin removal plan";
export const HOST_WORKFLOW_HOST_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
export const DEFAULT_HOST_CREATION_BOOTSTRAP_MODE = "new-host";

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

export const HOST_CREATION_SSH_IMPORT_STAGES = [
  { key: "access", label: "SSH access" },
  { key: "discovery", label: "Discovery" },
  { key: "findings", label: "Findings" },
  { key: "translation", label: "Translation" },
  { key: "improvements", label: "Improvements" },
  { key: "deployment", label: "Deployment" },
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

type HostCreationStage =
  | (typeof HOST_CREATION_STAGES)[number]
  | (typeof HOST_CREATION_SSH_IMPORT_STAGES)[number];

export type HostCreationStageKey = HostCreationStage["key"];
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

export function resolveHostCreationBootstrapMode(
  value: HostCreationWorkflowBootstrapMode | null | undefined,
): HostCreationWorkflowBootstrapMode {
  return value === "existing-via-ssh" ? value : DEFAULT_HOST_CREATION_BOOTSTRAP_MODE;
}

export function resolveHostCreationStages(
  workflow: HostCreationWorkflow,
): ReadonlyArray<HostCreationStage> {
  return resolveHostCreationBootstrapMode(workflow.bootstrapMode) === "existing-via-ssh"
    ? HOST_CREATION_SSH_IMPORT_STAGES
    : HOST_CREATION_STAGES;
}

function isSshImportHostCreation(workflow: HostCreationWorkflow): boolean {
  return resolveHostCreationBootstrapMode(workflow.bootstrapMode) === "existing-via-ssh";
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
      return isSshImportHostCreation(workflow)
        ? HOST_CREATION_SSH_IMPORT_START_LABEL
        : HOST_CREATION_START_LABEL;
    case "host-removal":
      return HOST_REMOVAL_START_LABEL;
  }
}

function buildHostCreationPlanGuidance(workflow: HostCreationWorkflow): ReadonlyArray<string> {
  if (isSshImportHostCreation(workflow)) {
    return [
      "- Treat SSH discovery as part of planning, not as a later implementation follow-up.",
      "- Prefer a usable SSH key loaded into the local ssh-agent when available, but allow the secure password prompt fallback when key auth is unavailable or fails.",
      "- Try ssh-agent-backed key auth first when available, but if authentication blocks discovery use the secure password prompt UI instead of chat or terminal input.",
      "- Never ask the user to paste passwords into chat or type passwords into a thread terminal.",
      "- Use the server-owned secure host-import job for remote discovery instead of raw interactive SSH from the agent terminal when passwords may be needed.",
      "- Do not start raw model-driven SSH discovery before the secure host-import flow has produced findings or surfaced a precise blocker.",
      "- Verify remote access early and stop with a precise blocker if the connection cannot be established safely.",
      "- Use SSH to inspect the current system's software, services, filesystems, networking, users, timers, and relevant configuration files before proposing the Nix translation.",
      "- Present a findings summary before locking the translation plan.",
      "- After secure import completes, use the sanitized findings summary as the source of truth for the next response.",
      "- Clearly separate observed current state from suggested improvements or intentional changes.",
      "- Preserve required system behavior by default; propose improvements as explicit, reviewable deltas.",
      `- Treat halHosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix as mandatory anchors in the final plan.`,
      "- Discover optional scaffold files from this repo instead of assuming a fixed flake layout.",
      "- Avoid broad repo changes unless the plan clearly justifies them.",
    ];
  }

  return [
    "- Ask hardware questions before recommending partitioning or install details.",
    "- After the hardware picture is clear, browse current official sources before recommending install or partitioning details and state the browsing date explicitly.",
    "- Prefer the NixOS manual, nixos-anywhere, Home Manager, and disko before community sources.",
    `- Treat halHosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix as mandatory anchors in the final plan.`,
    "- Discover optional scaffold files from this repo instead of assuming a fixed flake layout.",
    "- Avoid broad repo changes unless the plan clearly justifies them.",
  ];
}

function buildHostCreationImplementationGuidance(
  workflow: HostCreationWorkflow,
): ReadonlyArray<string> {
  if (isSshImportHostCreation(workflow)) {
    return [
      "- Treat the approved findings, translation decisions, and prior planning discussion as the source of truth.",
      "- Prefer the secure host-import job for further remote discovery when authentication is still unresolved.",
      "- Never ask for passwords in conversation and never tell the user to type a password into a terminal.",
      "- If secure import findings are available, treat the sanitized findings summary as the source of truth for follow-up reasoning.",
      `- Keep writes scoped to ${workflow.hostName} unless the approved plan explicitly requires shared-module changes.`,
      `- Ensure the implementation includes halHosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix.`,
      "- Preserve observed system behavior unless the approved plan explicitly changes it.",
      "- Call out any intentional improvements or simplifications separately from parity-preserving translation work.",
      "- Discover optional scaffold structure from the repo instead of assuming a fixed flake layout.",
      "- Keep deployment and validation steps explicit, conservative, and easy to review.",
      "- Minimize blast radius and call out any cross-host impact from shared-module edits.",
    ];
  }

  return [
    "- Treat the approved plan and prior planning decisions as the source of truth.",
    `- Keep writes scoped to ${workflow.hostName} unless the approved plan explicitly requires shared-module changes.`,
    `- Ensure the implementation includes halHosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix.`,
    "- Discover optional scaffold structure from the repo instead of assuming a fixed flake layout.",
    "- Minimize blast radius and call out any cross-host impact from shared-module edits.",
  ];
}

function buildHostRemovalPlanGuidance(workflow: HostRemovalWorkflow): ReadonlyArray<string> {
  return [
    "- Start by auditing this repo for every reference to the host before proposing deletions.",
    `- Treat halHosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix as mandatory removal anchors when they exist.`,
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
    `- Remove halHosts.${workflow.hostName} and hosts/${workflow.hostName}/default.nix when the approved plan includes them.`,
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

export function buildHostWorkflowPlanningOutcomeGuidance(
  workflow: ThreadWorkflow,
): ReadonlyArray<string> {
  switch (workflow.kind) {
    case "host-creation":
      return isSshImportHostCreation(workflow)
        ? [
            "- Use the first substantial response after discovery to present SSH findings, blockers, and follow-up questions.",
            "- Finish with a single decision-complete <proposed_plan> only after the findings have been reviewed and the desired translation changes are clear.",
          ]
        : [
            "- Finish with a single decision-complete <proposed_plan> that is ready for implementation.",
          ];
    case "host-removal":
      return [
        "- Finish with a single decision-complete <proposed_plan> that is ready for implementation.",
      ];
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
  const sshImport = isSshImportHostCreation(workflow);
  const target = resolveHostCreationTarget(workflow.target ?? null, workflow.hostName);
  const osFamily = workflow.osFamily ?? "nixos";
  const hostType = workflow.hostType?.trim() ? workflow.hostType.trim() : "unspecified";
  const targetIsPlaceholder = (workflow.target?.trim() ?? "").length === 0;
  const sourceSshTarget = workflow.sourceSshTarget?.trim() ?? "";
  const sourceSshTargetIsMissing = sourceSshTarget.length === 0;
  const stages = resolveHostCreationStages(workflow);
  const finalResponseInstruction = sshImport
    ? "Do not rush to a final plan in the first response. After discovery, first present the SSH findings and any blockers, then finish with a single decision-complete <proposed_plan> once the translation direction is settled."
    : "The final response should be a single decision-complete <proposed_plan> ready for implementation, including install handoff guidance and explicit assumptions.";

  return [
    sshImport
      ? "Begin the guided host-creation workflow by importing an existing system over SSH."
      : "Begin the guided host-creation workflow for this new flake host.",
    "",
    "Seed facts:",
    `- host name: ${workflow.hostName}`,
    `- bootstrap mode: ${sshImport ? "import existing system via SSH" : "new host"}`,
    `- deploy target: ${target}${targetIsPlaceholder ? " (placeholder until I provide the final target)" : ""}`,
    ...(sshImport
      ? [
          `- ssh discovery target: ${sourceSshTargetIsMissing ? "missing (ask for it before attempting analysis)" : sourceSshTarget}`,
        ]
      : []),
    `- os family: ${osFamily}`,
    `- host type: ${hostType}`,
    "",
    "Work in stages and keep your running plan aligned to these stages:",
    ...stages.map((stage) => `- ${stage.key}: ${stage.label}`),
    "",
    "Workflow rules:",
    "- When a decision is missing, ask concise structured follow-up questions.",
    ...buildHostCreationPlanGuidance(workflow),
    "- Keep this planning-only until I approve implementation.",
    "",
    finalResponseInstruction,
  ].join("\n");
}

export function buildHostImportFindingsPrompt(
  workflow: HostCreationWorkflow,
  findingsSummary: string,
): string {
  return [
    `Secure host analysis for ${workflow.hostName} is complete.`,
    "",
    "Use the sanitized findings below as the source of truth for the next response.",
    "- Present the findings first.",
    "- Separate observed system state from suggested improvements.",
    "- Help translate the system into Nix with room for deliberate changes before deployment.",
    "",
    findingsSummary.trim(),
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
