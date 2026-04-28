import type {
  FlakeCreationWorkflow,
  FlakeOnboardingLayoutPattern,
  FlakeOnboardingQuestionnaire,
  FlakeRepoStyle,
  ProjectBootstrapFlakeInput,
} from "@t3tools/contracts";

export const FLAKE_CREATION_WORKFLOW_KIND = "flake-creation";
export const FLAKE_CREATION_BADGE_LABEL = "Create flake";
export const FLAKE_CREATION_START_LABEL = "Begin flake setup";
export const FLAKE_FILE_RELATIVE_PATH = "flake.nix";
export const FLAKE_REPO_STYLE_RELATIVE_PATH = ".hal/repo-style.json";
export const FLAKE_HAL_HOSTS_ATTR_PATH = "halHosts";
export const FLAKE_DEPLOY_NODES_ATTR_PATH = "deploy.nodes";

export const FLAKE_CREATION_STAGES = [
  { key: "baseline", label: "Baseline" },
  { key: "layout", label: "Layout" },
  { key: "modules", label: "Modules" },
  { key: "integrations", label: "Integrations" },
  { key: "review", label: "Review" },
  { key: "handoff", label: "Handoff" },
] as const;

export type FlakeCreationStageKey = (typeof FLAKE_CREATION_STAGES)[number]["key"];

type FlakeOnboardingLike = Pick<
  FlakeOnboardingQuestionnaire,
  "hostScale" | "platformMatrix" | "homeManager" | "moduleStyle" | "moduleNamespace"
>;

export function normalizeFlakeModuleNamespace(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length > 0 ? normalized : null;
}

export function shouldCreateFlakeModules(input: FlakeOnboardingLike): boolean {
  return (
    input.moduleStyle === "explicit-modules" ||
    input.platformMatrix === "mixed" ||
    input.homeManager
  );
}

export function resolveFlakeOnboardingLayoutPattern(
  input: FlakeOnboardingLike,
): FlakeOnboardingLayoutPattern {
  if (input.hostScale === "6+") {
    return "fleet-layered";
  }
  if (
    input.hostScale === "1" &&
    input.platformMatrix !== "mixed" &&
    !input.homeManager &&
    input.moduleStyle !== "explicit-modules"
  ) {
    return "single-host-minimal";
  }
  return "shared-modules";
}

export function deriveFlakeModuleRoot(input: FlakeOnboardingLike): string | null {
  if (!shouldCreateFlakeModules(input)) {
    return null;
  }
  const moduleNamespace = normalizeFlakeModuleNamespace(input.moduleNamespace);
  return moduleNamespace ? `modules/${moduleNamespace}` : "modules";
}

export function deriveFlakeOnboardingSkeletonPaths(
  input: FlakeOnboardingLike,
): ReadonlyArray<string> {
  const paths = new Set<string>([".hal", "hosts"]);
  const moduleRoot = deriveFlakeModuleRoot(input);

  if (moduleRoot) {
    paths.add("modules");
    if (moduleRoot !== "modules") {
      paths.add(moduleRoot);
    }
    paths.add(`${moduleRoot}/shared`);
    paths.add(`${moduleRoot}/nixos`);
    paths.add(`${moduleRoot}/darwin`);
  }

  if (input.hostScale === "2-5" || input.hostScale === "6+") {
    paths.add("profiles");
  }
  if (input.hostScale === "6+") {
    paths.add("profiles/base");
    paths.add("profiles/roles");
  }
  if (input.homeManager) {
    paths.add("homes");
  }

  return [...paths];
}

export function buildMinimalFlakeNixContents(): string {
  return [
    "{",
    '  description = "HAL flake";',
    "",
    "  inputs = {",
    '    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";',
    '    deploy-rs.url = "github:serokell/deploy-rs";',
    "  };",
    "",
    "  outputs = { self, nixpkgs, deploy-rs, ... }: {",
    "    halHosts = {};",
    "    deploy.nodes = {};",
    "  };",
    "}",
    "",
  ].join("\n");
}

export function buildFlakeRepoStyleGuidance(input: FlakeOnboardingLike): ReadonlyArray<string> {
  const moduleNamespace = normalizeFlakeModuleNamespace(input.moduleNamespace);
  return [
    `Treat ${FLAKE_REPO_STYLE_RELATIVE_PATH} as the local source of truth for the bootstrap ${FLAKE_HAL_HOSTS_ATTR_PATH} and ${FLAKE_DEPLOY_NODES_ATTR_PATH} contract.`,
    "Preserve the chosen flake layout pattern unless the user explicitly asks to restructure it.",
    `Keep ${FLAKE_HAL_HOSTS_ATTR_PATH} and ${FLAKE_DEPLOY_NODES_ATTR_PATH} present in ${FLAKE_FILE_RELATIVE_PATH}.`,
    moduleNamespace
      ? `Place shared modules under modules/${moduleNamespace} unless the user approves a different namespace.`
      : "Do not invent extra shared module namespaces unless the user asks for them.",
    "Prefer extending the existing scaffold before introducing new top-level directories.",
    "Keep cross-host abstractions explicit and easy to review.",
  ];
}

export function buildFlakeRepoStyleDocument(input: {
  projectTitle: string;
  workspaceRoot: string;
  generatedAt: string;
  questionnaire: FlakeOnboardingQuestionnaire;
}): FlakeRepoStyle {
  const layoutPattern = resolveFlakeOnboardingLayoutPattern(input.questionnaire);
  const createdSkeletonPaths = [...deriveFlakeOnboardingSkeletonPaths(input.questionnaire)];
  const moduleRoot = deriveFlakeModuleRoot(input.questionnaire);
  const profilesDir =
    input.questionnaire.hostScale === "2-5" || input.questionnaire.hostScale === "6+"
      ? "profiles"
      : null;
  const homesDir = input.questionnaire.homeManager ? "homes" : null;

  return {
    schemaVersion: 1,
    generatedAt: input.generatedAt,
    projectTitle: input.projectTitle,
    workspaceRoot: input.workspaceRoot,
    questionnaire: {
      ...input.questionnaire,
      moduleNamespace: normalizeFlakeModuleNamespace(input.questionnaire.moduleNamespace),
    },
    layoutPattern,
    paths: {
      flake: FLAKE_FILE_RELATIVE_PATH,
      repoStyle: FLAKE_REPO_STYLE_RELATIVE_PATH,
      hosts: "hosts",
      modules: moduleRoot,
      profiles: profilesDir,
      homes: homesDir,
    },
    createdSkeletonPaths,
    conventions: {
      flakeFile: FLAKE_FILE_RELATIVE_PATH,
      halHostsAttribute: FLAKE_HAL_HOSTS_ATTR_PATH,
      deployNodesAttribute: FLAKE_DEPLOY_NODES_ATTR_PATH,
      hostsDir: "hosts",
      modulesDir: moduleRoot,
      profilesDir,
      homesDir,
    },
    bootstrapContracts: {
      halHosts: {
        attributePath: FLAKE_HAL_HOSTS_ATTR_PATH,
        kind: "attrset",
        bootstrapEmptyLiteral: "{}",
        entryKeyDescription: "Each attribute key is the canonical HAL host name.",
        recognizedFields: [
          {
            name: "target",
            required: true,
            description: "Required SSH target or host address for the host entry.",
          },
          {
            name: "name",
            required: false,
            description:
              "Optional when the attribute key already names the host. HAL falls back to the key when name is omitted.",
          },
          {
            name: "sshUser",
            required: false,
            description: "Optional SSH login user used by deployments and live previews.",
          },
          {
            name: "activationUser",
            required: false,
            description: "Optional activation user for deploy operations that elevate separately.",
          },
          {
            name: "system",
            required: false,
            description: "Optional Nix system identifier such as x86_64-linux or aarch64-darwin.",
          },
          {
            name: "type",
            required: false,
            description: "Optional platform hint such as nixos or darwin.",
          },
        ],
        recognitionRules: [
          "HAL reads halHosts as an attrset keyed by host name.",
          "A host entry must provide target. The name field may be omitted when the attr key already names the host.",
          "An explicit empty bootstrap form halHosts = {} is valid and should not be treated as an error.",
        ],
        example: [
          "halHosts = {",
          "  atlas = {",
          '    target = "atlas.example";',
          '    sshUser = "deploy";',
          '    system = "x86_64-linux";',
          '    type = "nixos";',
          "  };",
          "};",
        ].join("\n"),
      },
      deployNodes: {
        attributePath: FLAKE_DEPLOY_NODES_ATTR_PATH,
        kind: "attrset",
        bootstrapEmptyLiteral: "{}",
        notes: [
          "The bootstrap only requires deploy.nodes to be present as an attrset.",
          "Real deploy-rs node definitions are added later when concrete hosts and rollout behavior are known.",
        ],
      },
    },
    guidance: [...buildFlakeRepoStyleGuidance(input.questionnaire)],
  };
}

export function buildFlakeCreationThreadTitle(): string {
  return "Create flake scaffold";
}

export function buildFlakeCreationBadgeLabel(): string {
  return FLAKE_CREATION_BADGE_LABEL;
}

export function buildFlakeCreationStartLabel(): string {
  return FLAKE_CREATION_START_LABEL;
}

export function buildFlakeCreationPlanGuidance(
  workflow: FlakeCreationWorkflow,
): ReadonlyArray<string> {
  const moduleRoot = deriveFlakeModuleRoot(workflow);
  return [
    "- HAL already created a minimal bootstrap flake before this thread started.",
    "- Ask follow-up questions only when they materially change folder structure, platform coverage, or shared-module conventions.",
    `- Keep ${FLAKE_HAL_HOSTS_ATTR_PATH} and ${FLAKE_DEPLOY_NODES_ATTR_PATH} present in ${FLAKE_FILE_RELATIVE_PATH}.`,
    `- Use ${FLAKE_REPO_STYLE_RELATIVE_PATH} as the local source of truth for the ${FLAKE_HAL_HOSTS_ATTR_PATH} contract.`,
    `- Preserve the selected layout pattern (${workflow.layoutPattern}) unless the user explicitly requests a different one.`,
    ...(moduleRoot ? [`- Treat ${moduleRoot} as the shared-module root for this repo.`] : []),
    "- Keep planning-only until implementation is explicitly approved.",
  ];
}

export function buildFlakeCreationPlanningOutcomeGuidance(): ReadonlyArray<string> {
  return [
    "- Finish with a single decision-complete <proposed_plan> that is ready for implementation.",
  ];
}

export function buildFlakeCreationImplementationGuidance(
  workflow: FlakeCreationWorkflow,
): ReadonlyArray<string> {
  const moduleRoot = deriveFlakeModuleRoot(workflow);
  return [
    "- Treat the approved plan and prior planning decisions as the source of truth.",
    `- Keep ${FLAKE_HAL_HOSTS_ATTR_PATH} and ${FLAKE_DEPLOY_NODES_ATTR_PATH} present in ${FLAKE_FILE_RELATIVE_PATH}.`,
    `- Use ${FLAKE_REPO_STYLE_RELATIVE_PATH} as the local source of truth for the ${FLAKE_HAL_HOSTS_ATTR_PATH} contract.`,
    `- Preserve the selected layout pattern (${workflow.layoutPattern}) unless the approved plan explicitly changes it.`,
    ...(moduleRoot
      ? [
          `- Keep shared module writes under ${moduleRoot} unless the approved plan expands the namespace.`,
        ]
      : []),
    `- Keep ${FLAKE_REPO_STYLE_RELATIVE_PATH} synchronized with any structural changes you make.`,
    "- Avoid introducing unnecessary top-level directories.",
  ];
}

export function buildFlakeCreationStarterPrompt(workflow: FlakeCreationWorkflow): string {
  const moduleNamespace = normalizeFlakeModuleNamespace(workflow.moduleNamespace);
  const moduleRoot = deriveFlakeModuleRoot(workflow);
  const skeletonPaths = deriveFlakeOnboardingSkeletonPaths(workflow);

  return [
    "Begin the guided flake-creation workflow for this new project.",
    "",
    "HAL already bootstrapped the repo with:",
    `- ${FLAKE_FILE_RELATIVE_PATH} containing ${FLAKE_HAL_HOSTS_ATTR_PATH} = {} and ${FLAKE_DEPLOY_NODES_ATTR_PATH} = {}`,
    `- ${FLAKE_REPO_STYLE_RELATIVE_PATH} with the selected style answers and the local ${FLAKE_HAL_HOSTS_ATTR_PATH} contract`,
    "- a minimal folder skeleton",
    "",
    "Seed facts:",
    `- layout pattern: ${workflow.layoutPattern}`,
    `- host scale: ${workflow.hostScale}`,
    `- platform matrix: ${workflow.platformMatrix}`,
    `- home manager: ${workflow.homeManager ? "enabled" : "disabled"}`,
    `- module style: ${workflow.moduleStyle}`,
    ...(moduleNamespace ? [`- module namespace: ${moduleNamespace}`] : []),
    ...(moduleRoot ? [`- shared module root: ${moduleRoot}`] : []),
    "",
    "Current scaffold directories:",
    ...skeletonPaths.map((path) => `- ${path}`),
    "",
    "Work in stages and keep your running plan aligned to these stages:",
    ...FLAKE_CREATION_STAGES.map((stage) => `- ${stage.key}: ${stage.label}`),
    "",
    "Workflow rules:",
    "- Ask concise follow-up questions only when they materially affect the scaffold or conventions.",
    ...buildFlakeCreationPlanGuidance(workflow),
    "",
    "The final response should be a single decision-complete <proposed_plan> ready for implementation, with explicit assumptions and minimal churn from the bootstrap baseline.",
  ].join("\n");
}

export function markFlakeWorkflowReadyToImplement(
  workflow: FlakeCreationWorkflow,
): FlakeCreationWorkflow {
  return {
    ...workflow,
    status: "ready-to-implement",
  };
}

export function toFlakeOnboardingQuestionnaire(
  input: ProjectBootstrapFlakeInput,
): FlakeOnboardingQuestionnaire {
  return {
    hostScale: input.hostScale,
    platformMatrix: input.platformMatrix,
    homeManager: input.homeManager,
    moduleStyle: input.moduleStyle,
    moduleNamespace: normalizeFlakeModuleNamespace(input.moduleNamespace),
  };
}
