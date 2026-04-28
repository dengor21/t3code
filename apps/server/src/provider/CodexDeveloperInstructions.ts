import type { ProviderTurnContext } from "@t3tools/contracts";
import {
  buildHostWorkflowImplementationGuidance,
  buildHostWorkflowPlanningOutcomeGuidance,
  buildHostWorkflowPlanGuidance,
  HOST_REMOVAL_STAGES,
  resolveHostCreationBootstrapMode,
  resolveHostCreationStages,
} from "@t3tools/shared/hostWorkflow";
import {
  buildFlakeCreationImplementationGuidance,
  buildFlakeCreationPlanGuidance,
  buildFlakeCreationPlanningOutcomeGuidance,
  FLAKE_CREATION_STAGES,
} from "@t3tools/shared/flakeWorkflow";

import { buildScopedHostInstructionBlock } from "./hostScopeInstructions.ts";

const CODEX_HAL_SCOPE_TOOL_RULES = `HAL scope rules:
- HAL runtime scope is authoritative. If runtime context says the thread is scoped to a host, use that host for omitted references such as "it", "this host", "the machine", or "deploy it".
- Do not ask which host is meant unless the runtime context has no host scope.
- Before asking which host is meant, call hal_current_scope when that tool is available. If it returns kind=host, use that host.
- Before modifying or deploying a different host, or shared configuration that may affect multiple hosts, call out the wider impact and require explicit scope expansion or approval.`;

const CODEX_REMOTE_HOST_ACCESS_RULES = `Remote host access rules:
- Do not initiate direct remote host access from chat. This includes ssh, scp, sftp, rsync, mosh, nixos-rebuild --target-host, nixos-anywhere, or direct deploy-rs commands against a target host.
- Use HAL deployment actions instead of remote shell deployment commands.
- When HAL deploy tools are available, use hal_open_host_deploy_dialog for a single clear host and hal_open_fleet_rollout for multi-host deploys.
- If the deploy target is not one clear host, ask whether the user wants a single host deploy or a fleet rollout before proceeding.
- HAL-managed SSH import workflows are exempt because they run outside the agent terminal.`;

function buildHalDeployToolInstructions(providerContext?: ProviderTurnContext): string | null {
  if (!providerContext || providerContext.projectKind !== "nix-flake") {
    return null;
  }

  return [
    "HAL deploy actions available in this session:",
    "- `hal_open_host_deploy_dialog` opens HAL's host deploy dialog. Use it for a single clear host deploy.",
    "- `hal_open_fleet_rollout` opens HAL's fleet rollout flow. Use it for multi-host deploys.",
    "- These are HAL client actions, not local CLI commands or MCP resources. Invoke them by exact name even if they do not appear in shell tool listings.",
    ...(providerContext.scopedHostName
      ? [
          `- This thread is scoped to host ${providerContext.scopedHostName}. For a deploy request targeting that host, call \`hal_open_host_deploy_dialog\` immediately; omitting hostName is valid.`,
        ]
      : [
          "- If the user requests a deploy for one named host, call `hal_open_host_deploy_dialog` with that host.",
        ]),
  ].join("\n");
}

export const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode (Conversational)

You work in 3 phases, and you should *chat your way* to a great plan before finalizing it. A great plan is very detailed-intent- and implementation-wise-so that it can be handed to another engineer or agent to be implemented right away. It must be **decision complete**, where the implementer does not need to make any decisions.

## Mode rules (strict)

You are in **Plan Mode** until a developer message explicitly ends it.

Plan Mode is not changed by user intent, tone, or imperative language. If a user asks for execution while still in Plan Mode, treat it as a request to **plan the execution**, not perform it.

## Plan Mode vs update_plan tool

Plan Mode is a collaboration mode that can involve requesting user input and eventually issuing a \`<proposed_plan>\` block.

Separately, \`update_plan\` is a checklist/progress/TODOs tool; it does not enter or exit Plan Mode. Do not confuse it with Plan mode or try to use it while in Plan mode. If you try to use \`update_plan\` in Plan mode, it will return an error.

## Execution vs. mutation in Plan Mode

You may explore and execute **non-mutating** actions that improve the plan. You must not perform **mutating** actions.

### Allowed (non-mutating, plan-improving)

Actions that gather truth, reduce ambiguity, or validate feasibility without changing repo-tracked state. Examples:

* Reading or searching files, configs, schemas, types, manifests, and docs
* Static analysis, inspection, and repo exploration
* Dry-run style commands when they do not edit repo-tracked files
* Tests, builds, or checks that may write to caches or build artifacts (for example, \`target/\`, \`.cache/\`, or snapshots) so long as they do not edit repo-tracked files

### Not allowed (mutating, plan-executing)

Actions that implement the plan or change repo-tracked state. Examples:

* Editing or writing files
* Running formatters or linters that rewrite files
* Applying patches, migrations, or codegen that updates repo-tracked files
* Side-effectful commands whose purpose is to carry out the plan rather than refine it

When in doubt: if the action would reasonably be described as "doing the work" rather than "planning the work," do not do it.

## PHASE 1 - Ground in the environment (explore first, ask second)

Begin by grounding yourself in the actual environment. Eliminate unknowns in the prompt by discovering facts, not by asking the user. Resolve all questions that can be answered through exploration or inspection. Identify missing or ambiguous details only if they cannot be derived from the environment. Silent exploration between turns is allowed and encouraged.

Before asking the user any question, perform at least one targeted non-mutating exploration pass (for example: search relevant files, inspect likely entrypoints/configs, confirm current implementation shape), unless no local environment/repo is available.

Exception: you may ask clarifying questions about the user's prompt before exploring, ONLY if there are obvious ambiguities or contradictions in the prompt itself. However, if ambiguity might be resolved by exploring, always prefer exploring first.

Do not ask questions that can be answered from the repo or system (for example, "where is this struct?" or "which UI component should we use?" when exploration can make it clear). Only ask once you have exhausted reasonable non-mutating exploration.

## PHASE 2 - Intent chat (what they actually want)

* Keep asking until you can clearly state: goal + success criteria, audience, in/out of scope, constraints, current state, and the key preferences/tradeoffs.
* Bias toward questions over guessing: if any high-impact ambiguity remains, do NOT plan yet-ask.

## PHASE 3 - Implementation chat (what/how we'll build)

* Once intent is stable, keep asking until the spec is decision complete: approach, interfaces (APIs/schemas/I/O), data flow, edge cases/failure modes, testing + acceptance criteria, rollout/monitoring, and any migrations/compat constraints.

## Asking questions

Critical rules:

* Strongly prefer using the \`request_user_input\` tool to ask any questions.
* Offer only meaningful multiple-choice options; don't include filler choices that are obviously wrong or irrelevant.
* In rare cases where an unavoidable, important question can't be expressed with reasonable multiple-choice options (due to extreme ambiguity), you may ask it directly without the tool.

You SHOULD ask many questions, but each question must:

* materially change the spec/plan, OR
* confirm/lock an assumption, OR
* choose between meaningful tradeoffs.
* not be answerable by non-mutating commands.

Use the \`request_user_input\` tool only for decisions that materially change the plan, for confirming important assumptions, or for information that cannot be discovered via non-mutating exploration.

## Two kinds of unknowns (treat differently)

1. **Discoverable facts** (repo/system truth): explore first.

   * Before asking, run targeted searches and check likely sources of truth (configs/manifests/entrypoints/schemas/types/constants).
   * Ask only if: multiple plausible candidates; nothing found but you need a missing identifier/context; or ambiguity is actually product intent.
   * If asking, present concrete candidates (paths/service names) + recommend one.
   * Never ask questions you can answer from your environment (e.g., "where is this struct").

2. **Preferences/tradeoffs** (not discoverable): ask early.

   * These are intent or implementation preferences that cannot be derived from exploration.
   * Provide 2-4 mutually exclusive options + a recommended default.
   * If unanswered, proceed with the recommended option and record it as an assumption in the final plan.

## Finalization rule

Only output the final plan when it is decision complete and leaves no decisions to the implementer.

When you present the official plan, wrap it in a \`<proposed_plan>\` block so the client can render it specially:

1) The opening tag must be on its own line.
2) Start the plan content on the next line (no text on the same line as the tag).
3) The closing tag must be on its own line.
4) Use Markdown inside the block.
5) Keep the tags exactly as \`<proposed_plan>\` and \`</proposed_plan>\` (do not translate or rename them), even if the plan content is in another language.

Example:

<proposed_plan>
plan content
</proposed_plan>

plan content should be human and agent digestible. The final plan must be plan-only and include:

* A clear title
* A brief summary section
* Important changes or additions to public APIs/interfaces/types
* Test cases and scenarios
* Explicit assumptions and defaults chosen where needed

Do not ask "should I proceed?" in the final output. The user can easily switch out of Plan mode and request implementation if you have included a \`<proposed_plan>\` block in your response. Alternatively, they can decide to stay in Plan mode and continue refining the plan.

Only produce at most one \`<proposed_plan>\` block per turn, and only when you are presenting a complete spec.
</collaboration_mode>`;

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are now in Default mode. Any previous instructions for other modes (e.g. Plan mode) are no longer active.

Your active mode changes only when new developer instructions with a different \`<collaboration_mode>...</collaboration_mode>\` change it; user requests or tool descriptions do not change mode by themselves. Known mode names are Default and Plan.

## request_user_input availability

The \`request_user_input\` tool is unavailable in Default mode. If you call it while in Default mode, it will return an error.

In Default mode, strongly prefer making reasonable assumptions and executing the user's request rather than stopping to ask questions. If you absolutely must ask a question because the answer cannot be discovered from local context and a reasonable assumption would be risky, ask the user directly with a concise plain-text question. Never write a multiple choice question as a textual assistant message.
</collaboration_mode>`;

function buildCodexWorkflowInstructions(input: {
  readonly interactionMode: "default" | "plan";
  readonly providerContext?: ProviderTurnContext;
}): string | null {
  const workflow = input.providerContext?.workflow;
  const repoStylePath = input.providerContext?.flake?.documentationPaths?.repoStyle ?? null;
  if (!workflow) {
    return null;
  }

  switch (workflow.kind) {
    case "host-creation": {
      const stageLines = resolveHostCreationStages(workflow).map(
        (stage) => `- ${stage.key}: ${stage.label}`,
      );
      return input.interactionMode === "plan"
        ? [
            `This thread is running the host-creation workflow for ${workflow.hostName}${
              resolveHostCreationBootstrapMode(workflow.bootstrapMode) === "existing-via-ssh"
                ? " by importing an existing system over SSH."
                : "."
            }`,
            "",
            "Workflow rules:",
            "- Work in stages and keep the plan sidebar current with update_plan.",
            ...stageLines,
            "- Use request_user_input for concise structured choices when it fits.",
            ...(workflow.target ? [`- Planned deploy target: ${workflow.target}.`] : []),
            ...(workflow.sourceSshTarget
              ? [`- SSH discovery target: ${workflow.sourceSshTarget}.`]
              : []),
            ...(workflow.osFamily ? [`- Target OS family: ${workflow.osFamily}.`] : []),
            ...(workflow.hostType ? [`- Host type hint: ${workflow.hostType}.`] : []),
            ...(repoStylePath
              ? [
                  `- Consult repo style guidance at ${repoStylePath} before reshaping shared structure.`,
                ]
              : []),
            ...buildHostWorkflowPlanGuidance(workflow),
            ...buildHostWorkflowPlanningOutcomeGuidance(workflow),
          ].join("\n")
        : [
            `This thread is implementing an approved host-creation plan for ${workflow.hostName}.`,
            "",
            "Execution rules:",
            "- Treat the approved proposed plan and any sourceProposedPlan reference as the source of truth.",
            ...(workflow.target ? [`- Planned deploy target: ${workflow.target}.`] : []),
            ...(workflow.sourceSshTarget
              ? [`- SSH discovery target: ${workflow.sourceSshTarget}.`]
              : []),
            ...(workflow.osFamily ? [`- Target OS family: ${workflow.osFamily}.`] : []),
            ...(workflow.hostType ? [`- Host type hint: ${workflow.hostType}.`] : []),
            ...(repoStylePath
              ? [
                  `- Consult repo style guidance at ${repoStylePath} before reshaping shared structure.`,
                ]
              : []),
            ...buildHostWorkflowImplementationGuidance(workflow),
          ].join("\n");
    }
    case "host-removal": {
      const stageLines = HOST_REMOVAL_STAGES.map((stage) => `- ${stage.key}: ${stage.label}`);
      return input.interactionMode === "plan"
        ? [
            `This thread is running the host-removal workflow for ${workflow.hostName}.`,
            "",
            "Workflow rules:",
            "- Work in stages and keep the plan sidebar current with update_plan.",
            ...stageLines,
            ...(repoStylePath
              ? [
                  `- Consult repo style guidance at ${repoStylePath} before removing shared structure.`,
                ]
              : []),
            ...buildHostWorkflowPlanGuidance(workflow),
            "- Finish with a single decision-complete <proposed_plan> that is ready for implementation.",
          ].join("\n")
        : [
            `This thread is implementing an approved host-removal plan for ${workflow.hostName}.`,
            "",
            "Execution rules:",
            "- Treat the approved proposed plan and any sourceProposedPlan reference as the source of truth.",
            ...(repoStylePath
              ? [
                  `- Consult repo style guidance at ${repoStylePath} before removing shared structure.`,
                ]
              : []),
            ...buildHostWorkflowImplementationGuidance(workflow),
          ].join("\n");
    }
    case "flake-creation": {
      const stageLines = FLAKE_CREATION_STAGES.map((stage) => `- ${stage.key}: ${stage.label}`);
      return input.interactionMode === "plan"
        ? [
            "This thread is running the flake-creation workflow for this project.",
            "",
            "Workflow rules:",
            "- HAL already bootstrapped a minimal flake before this thread started.",
            "- Work in stages and keep the plan sidebar current with update_plan.",
            ...stageLines,
            `- Selected layout pattern: ${workflow.layoutPattern}.`,
            `- Planned host scale: ${workflow.hostScale}.`,
            `- Planned platform matrix: ${workflow.platformMatrix}.`,
            `- Home Manager: ${workflow.homeManager ? "enabled" : "disabled"}.`,
            `- Module style: ${workflow.moduleStyle}.`,
            ...(workflow.moduleNamespace
              ? [`- Module namespace: ${workflow.moduleNamespace}.`]
              : []),
            ...(repoStylePath ? [`- Consult repo style guidance at ${repoStylePath}.`] : []),
            ...(repoStylePath
              ? [
                  "- The repo style guide defines the local halHosts and deploy.nodes bootstrap contract. Read it before searching nearby repos for shape hints.",
                ]
              : []),
            ...buildFlakeCreationPlanGuidance(workflow),
            ...buildFlakeCreationPlanningOutcomeGuidance(),
          ].join("\n")
        : [
            "This thread is implementing an approved flake-creation plan for this project.",
            "",
            "Execution rules:",
            "- Treat the approved proposed plan and any sourceProposedPlan reference as the source of truth.",
            `- Selected layout pattern: ${workflow.layoutPattern}.`,
            `- Planned host scale: ${workflow.hostScale}.`,
            `- Planned platform matrix: ${workflow.platformMatrix}.`,
            `- Home Manager: ${workflow.homeManager ? "enabled" : "disabled"}.`,
            `- Module style: ${workflow.moduleStyle}.`,
            ...(workflow.moduleNamespace
              ? [`- Module namespace: ${workflow.moduleNamespace}.`]
              : []),
            ...(repoStylePath
              ? [`- Keep ${repoStylePath} synchronized with structural changes.`]
              : []),
            ...(repoStylePath
              ? [
                  "- Use the repo style guide as the source of truth for halHosts and deploy.nodes instead of inferring structure from neighboring repos.",
                ]
              : []),
            ...buildFlakeCreationImplementationGuidance(workflow),
          ].join("\n");
    }
  }
}

export function buildCodexDeveloperInstructions(input: {
  readonly interactionMode: "default" | "plan";
  readonly providerContext?: ProviderTurnContext;
}): string {
  const base =
    input.interactionMode === "plan"
      ? `${CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS}\n\n${CODEX_HAL_SCOPE_TOOL_RULES}\n\n${CODEX_REMOTE_HOST_ACCESS_RULES}`
      : `${CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS}\n\n${CODEX_HAL_SCOPE_TOOL_RULES}\n\n${CODEX_REMOTE_HOST_ACCESS_RULES}`;
  const hostScopeInstructions = buildScopedHostInstructionBlock(input.providerContext);
  const halDeployToolInstructions = buildHalDeployToolInstructions(input.providerContext);
  const workflowInstructions = buildCodexWorkflowInstructions(input);
  if (!hostScopeInstructions && !halDeployToolInstructions && !workflowInstructions) {
    return base;
  }

  return [base, hostScopeInstructions, halDeployToolInstructions, workflowInstructions]
    .filter((section): section is string => typeof section === "string" && section.length > 0)
    .join("\n\n");
}
