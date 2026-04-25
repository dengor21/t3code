import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcGroup from "effect/unstable/rpc/RpcGroup";

import { OpenError, OpenInEditorInput } from "./editor.ts";
import { AuthAccessStreamEvent } from "./auth.ts";
import {
  FilesystemBrowseInput,
  FilesystemBrowseResult,
  FilesystemBrowseError,
} from "./filesystem.ts";
import {
  DeploymentSafetyError,
  HostDeploymentPreviewInput,
  HostDeploymentPreviewResult,
} from "./deploymentSafety.ts";
import {
  FleetDeploymentError,
  FleetDeploymentGetInput,
  FleetDeploymentStartInput,
  FleetDeploymentStartResult,
  FleetDeploymentStopInput,
  NullOrFleetDeploymentSummary,
} from "./fleetDeployment.ts";
import {
  FlakeMaintenanceError,
  FlakeMaintenanceGetInput,
  FlakeMaintenanceStartInput,
  FlakeMaintenanceStartResult,
  FlakeMaintenanceStopInput,
  FlakeMaintenanceTerminalEvent,
  FlakeMaintenanceTerminalOpenInput,
  FlakeMaintenanceTerminalResizeInput,
  FlakeMaintenanceTerminalSnapshot,
  NullOrFlakeMaintenanceSummary,
} from "./flakeMaintenance.ts";
import {
  GitActionProgressEvent,
  GitCheckoutInput,
  GitCheckoutResult,
  GitCommandError,
  GitCreateBranchInput,
  GitCreateBranchResult,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitManagerServiceError,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullInput,
  GitPullRequestRefInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitStatusInput,
  GitStatusResult,
  GitStatusStreamEvent,
} from "./git.ts";
import { KeybindingsConfigError } from "./keybindings.ts";
import {
  ClientOrchestrationCommand,
  ORCHESTRATION_WS_METHODS,
  OrchestrationDispatchCommandError,
  OrchestrationGetFullThreadDiffError,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetSnapshotError,
  OrchestrationGetTurnDiffError,
  OrchestrationGetTurnDiffInput,
  OrchestrationReplayEventsError,
  OrchestrationReplayEventsInput,
  OrchestrationRpcSchemas,
} from "./orchestration.ts";
import {
  HostDeploymentError,
  HostDeploymentGetInput,
  HostDeploymentStartInput,
  HostDeploymentStartResult,
  HostDeploymentStopInput,
  HostDeploymentTerminalEvent,
  HostDeploymentTerminalOpenInput,
  HostDeploymentTerminalResizeInput,
  HostDeploymentTerminalSnapshot,
  NullOrHostDeploymentSummary,
} from "./hostDeployment.ts";
import {
  HostDriftCancelInput,
  HostDriftError,
  HostDriftGetInput,
  HostDriftReconcileInput,
  HostDriftReconcileResult,
  HostDriftRefreshInput,
  HostDriftRefreshResult,
  HostDriftSubmitSecretInput,
  HostDriftSubmitSecretResult,
  HostDriftTerminalEvent,
  HostDriftTerminalOpenInput,
  HostDriftTerminalResizeInput,
  HostDriftTerminalSnapshot,
  NullOrHostDriftSummary,
} from "./hostDrift.ts";
import {
  HostImportCancelInput,
  HostImportError,
  HostImportGetInput,
  HostImportStartInput,
  HostImportStartResult,
  HostImportSubmitSecretInput,
  HostImportSubmitSecretResult,
  HostImportTerminalEvent,
  HostImportTerminalOpenInput,
  HostImportTerminalResizeInput,
  HostImportTerminalSnapshot,
  NullOrHostImportSummary,
} from "./hostImport.ts";
import {
  ProjectDashboardContentResult,
  ProjectGenerateHostDocumentationError,
  ProjectGenerateHostDocumentationInput,
  ProjectGenerateHostDocumentationResult,
  ProjectGetDashboardContentError,
  ProjectGetDashboardContentInput,
  ProjectRebuildNixDesignerIndexError,
  ProjectRebuildNixDesignerIndexInput,
  ProjectRebuildNixDesignerIndexResult,
  ProjectSearchEntriesError,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileError,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project.ts";
import {
  ProjectSecretsError,
  ProjectSecretsGetInput,
  ProjectSecretsSummary,
} from "./projectSecrets.ts";
import {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalError,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal.ts";
import {
  ServerConfigStreamEvent,
  ServerConfig,
  ServerLifecycleStreamEvent,
  ServerProviderUpdatedPayload,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server.ts";
import { ServerSettings, ServerSettingsError, ServerSettingsPatch } from "./settings.ts";

export const WS_METHODS = {
  // Project registry methods
  projectsList: "projects.list",
  projectsAdd: "projects.add",
  projectsRemove: "projects.remove",
  projectsSearchEntries: "projects.searchEntries",
  projectsWriteFile: "projects.writeFile",
  projectsGenerateHostDocumentation: "projects.generateHostDocumentation",
  projectsGetDashboardContent: "projects.getDashboardContent",
  projectsRebuildNixDesignerIndex: "projects.rebuildNixDesignerIndex",
  projectsGetSecretsSummary: "projects.getSecretsSummary",
  fleetDeploymentsStart: "fleetDeployments.start",
  fleetDeploymentsGet: "fleetDeployments.get",
  fleetDeploymentsStop: "fleetDeployments.stop",
  hostDeploymentsStart: "hostDeployments.start",
  hostDeploymentsPreview: "hostDeployments.preview",
  hostDeploymentsGet: "hostDeployments.get",
  hostDeploymentsStop: "hostDeployments.stop",
  hostDeploymentsTerminalOpen: "hostDeployments.terminalOpen",
  hostDeploymentsTerminalResize: "hostDeployments.terminalResize",
  hostDeploymentsSubscribeTerminalEvents: "hostDeployments.subscribeTerminalEvents",
  hostDriftRefresh: "hostDrift.refresh",
  hostDriftGet: "hostDrift.get",
  hostDriftCancel: "hostDrift.cancel",
  hostDriftSubmitSecret: "hostDrift.submitSecret",
  hostDriftReconcile: "hostDrift.reconcile",
  hostDriftTerminalOpen: "hostDrift.terminalOpen",
  hostDriftTerminalResize: "hostDrift.terminalResize",
  hostDriftSubscribeTerminalEvents: "hostDrift.subscribeTerminalEvents",
  hostImportsStart: "hostImports.start",
  hostImportsGet: "hostImports.get",
  hostImportsCancel: "hostImports.cancel",
  hostImportsSubmitSecret: "hostImports.submitSecret",
  hostImportsTerminalOpen: "hostImports.terminalOpen",
  hostImportsTerminalResize: "hostImports.terminalResize",
  hostImportsSubscribeTerminalEvents: "hostImports.subscribeTerminalEvents",
  flakeMaintenanceStart: "flakeMaintenance.start",
  flakeMaintenanceGet: "flakeMaintenance.get",
  flakeMaintenanceStop: "flakeMaintenance.stop",
  flakeMaintenanceTerminalOpen: "flakeMaintenance.terminalOpen",
  flakeMaintenanceTerminalResize: "flakeMaintenance.terminalResize",
  flakeMaintenanceSubscribeTerminalEvents: "flakeMaintenance.subscribeTerminalEvents",

  // Shell methods
  shellOpenInEditor: "shell.openInEditor",

  // Filesystem methods
  filesystemBrowse: "filesystem.browse",

  // Git methods
  gitPull: "git.pull",
  gitRefreshStatus: "git.refreshStatus",
  gitRunStackedAction: "git.runStackedAction",
  gitListBranches: "git.listBranches",
  gitCreateWorktree: "git.createWorktree",
  gitRemoveWorktree: "git.removeWorktree",
  gitCreateBranch: "git.createBranch",
  gitCheckout: "git.checkout",
  gitInit: "git.init",
  gitResolvePullRequest: "git.resolvePullRequest",
  gitPreparePullRequestThread: "git.preparePullRequestThread",

  // Terminal methods
  terminalOpen: "terminal.open",
  terminalWrite: "terminal.write",
  terminalResize: "terminal.resize",
  terminalClear: "terminal.clear",
  terminalRestart: "terminal.restart",
  terminalClose: "terminal.close",

  // Server meta
  serverGetConfig: "server.getConfig",
  serverRefreshProviders: "server.refreshProviders",
  serverUpsertKeybinding: "server.upsertKeybinding",
  serverGetSettings: "server.getSettings",
  serverUpdateSettings: "server.updateSettings",

  // Streaming subscriptions
  subscribeGitStatus: "subscribeGitStatus",
  subscribeTerminalEvents: "subscribeTerminalEvents",
  subscribeServerConfig: "subscribeServerConfig",
  subscribeServerLifecycle: "subscribeServerLifecycle",
  subscribeAuthAccess: "subscribeAuthAccess",
} as const;

export const WsServerUpsertKeybindingRpc = Rpc.make(WS_METHODS.serverUpsertKeybinding, {
  payload: ServerUpsertKeybindingInput,
  success: ServerUpsertKeybindingResult,
  error: KeybindingsConfigError,
});

export const WsServerGetConfigRpc = Rpc.make(WS_METHODS.serverGetConfig, {
  payload: Schema.Struct({}),
  success: ServerConfig,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
});

export const WsServerRefreshProvidersRpc = Rpc.make(WS_METHODS.serverRefreshProviders, {
  payload: Schema.Struct({}),
  success: ServerProviderUpdatedPayload,
});

export const WsServerGetSettingsRpc = Rpc.make(WS_METHODS.serverGetSettings, {
  payload: Schema.Struct({}),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsServerUpdateSettingsRpc = Rpc.make(WS_METHODS.serverUpdateSettings, {
  payload: Schema.Struct({ patch: ServerSettingsPatch }),
  success: ServerSettings,
  error: ServerSettingsError,
});

export const WsProjectsSearchEntriesRpc = Rpc.make(WS_METHODS.projectsSearchEntries, {
  payload: ProjectSearchEntriesInput,
  success: ProjectSearchEntriesResult,
  error: ProjectSearchEntriesError,
});

export const WsProjectsWriteFileRpc = Rpc.make(WS_METHODS.projectsWriteFile, {
  payload: ProjectWriteFileInput,
  success: ProjectWriteFileResult,
  error: ProjectWriteFileError,
});

export const WsProjectsGenerateHostDocumentationRpc = Rpc.make(
  WS_METHODS.projectsGenerateHostDocumentation,
  {
    payload: ProjectGenerateHostDocumentationInput,
    success: ProjectGenerateHostDocumentationResult,
    error: ProjectGenerateHostDocumentationError,
  },
);

export const WsProjectsGetDashboardContentRpc = Rpc.make(WS_METHODS.projectsGetDashboardContent, {
  payload: ProjectGetDashboardContentInput,
  success: ProjectDashboardContentResult,
  error: ProjectGetDashboardContentError,
});

export const WsProjectsRebuildNixDesignerIndexRpc = Rpc.make(
  WS_METHODS.projectsRebuildNixDesignerIndex,
  {
    payload: ProjectRebuildNixDesignerIndexInput,
    success: ProjectRebuildNixDesignerIndexResult,
    error: ProjectRebuildNixDesignerIndexError,
  },
);

export const WsProjectsGetSecretsSummaryRpc = Rpc.make(WS_METHODS.projectsGetSecretsSummary, {
  payload: ProjectSecretsGetInput,
  success: ProjectSecretsSummary,
  error: ProjectSecretsError,
});

export const WsFleetDeploymentsStartRpc = Rpc.make(WS_METHODS.fleetDeploymentsStart, {
  payload: FleetDeploymentStartInput,
  success: FleetDeploymentStartResult,
  error: FleetDeploymentError,
});

export const WsFleetDeploymentsGetRpc = Rpc.make(WS_METHODS.fleetDeploymentsGet, {
  payload: FleetDeploymentGetInput,
  success: NullOrFleetDeploymentSummary,
  error: FleetDeploymentError,
});

export const WsFleetDeploymentsStopRpc = Rpc.make(WS_METHODS.fleetDeploymentsStop, {
  payload: FleetDeploymentStopInput,
  success: NullOrFleetDeploymentSummary,
  error: FleetDeploymentError,
});

export const WsHostDeploymentsStartRpc = Rpc.make(WS_METHODS.hostDeploymentsStart, {
  payload: HostDeploymentStartInput,
  success: HostDeploymentStartResult,
  error: HostDeploymentError,
});

export const WsHostDeploymentsPreviewRpc = Rpc.make(WS_METHODS.hostDeploymentsPreview, {
  payload: HostDeploymentPreviewInput,
  success: HostDeploymentPreviewResult,
  error: DeploymentSafetyError,
});

export const WsHostDeploymentsGetRpc = Rpc.make(WS_METHODS.hostDeploymentsGet, {
  payload: HostDeploymentGetInput,
  success: NullOrHostDeploymentSummary,
  error: HostDeploymentError,
});

export const WsHostDeploymentsStopRpc = Rpc.make(WS_METHODS.hostDeploymentsStop, {
  payload: HostDeploymentStopInput,
  success: NullOrHostDeploymentSummary,
  error: HostDeploymentError,
});

export const WsHostDeploymentsTerminalOpenRpc = Rpc.make(WS_METHODS.hostDeploymentsTerminalOpen, {
  payload: HostDeploymentTerminalOpenInput,
  success: HostDeploymentTerminalSnapshot,
  error: HostDeploymentError,
});

export const WsHostDeploymentsTerminalResizeRpc = Rpc.make(
  WS_METHODS.hostDeploymentsTerminalResize,
  {
    payload: HostDeploymentTerminalResizeInput,
    error: HostDeploymentError,
  },
);

export const WsHostDeploymentsSubscribeTerminalEventsRpc = Rpc.make(
  WS_METHODS.hostDeploymentsSubscribeTerminalEvents,
  {
    payload: HostDeploymentGetInput,
    success: HostDeploymentTerminalEvent,
    error: HostDeploymentError,
    stream: true,
  },
);

export const WsHostDriftRefreshRpc = Rpc.make(WS_METHODS.hostDriftRefresh, {
  payload: HostDriftRefreshInput,
  success: HostDriftRefreshResult,
  error: HostDriftError,
});

export const WsHostDriftGetRpc = Rpc.make(WS_METHODS.hostDriftGet, {
  payload: HostDriftGetInput,
  success: NullOrHostDriftSummary,
  error: HostDriftError,
});

export const WsHostDriftCancelRpc = Rpc.make(WS_METHODS.hostDriftCancel, {
  payload: HostDriftCancelInput,
  success: NullOrHostDriftSummary,
  error: HostDriftError,
});

export const WsHostDriftSubmitSecretRpc = Rpc.make(WS_METHODS.hostDriftSubmitSecret, {
  payload: HostDriftSubmitSecretInput,
  success: HostDriftSubmitSecretResult,
  error: HostDriftError,
});

export const WsHostDriftReconcileRpc = Rpc.make(WS_METHODS.hostDriftReconcile, {
  payload: HostDriftReconcileInput,
  success: HostDriftReconcileResult,
  error: HostDriftError,
});

export const WsHostDriftTerminalOpenRpc = Rpc.make(WS_METHODS.hostDriftTerminalOpen, {
  payload: HostDriftTerminalOpenInput,
  success: HostDriftTerminalSnapshot,
  error: HostDriftError,
});

export const WsHostDriftTerminalResizeRpc = Rpc.make(WS_METHODS.hostDriftTerminalResize, {
  payload: HostDriftTerminalResizeInput,
  error: HostDriftError,
});

export const WsHostDriftSubscribeTerminalEventsRpc = Rpc.make(
  WS_METHODS.hostDriftSubscribeTerminalEvents,
  {
    payload: HostDriftGetInput,
    success: HostDriftTerminalEvent,
    error: HostDriftError,
    stream: true,
  },
);

export const WsHostImportsStartRpc = Rpc.make(WS_METHODS.hostImportsStart, {
  payload: HostImportStartInput,
  success: HostImportStartResult,
  error: HostImportError,
});

export const WsHostImportsGetRpc = Rpc.make(WS_METHODS.hostImportsGet, {
  payload: HostImportGetInput,
  success: NullOrHostImportSummary,
  error: HostImportError,
});

export const WsHostImportsCancelRpc = Rpc.make(WS_METHODS.hostImportsCancel, {
  payload: HostImportCancelInput,
  success: NullOrHostImportSummary,
  error: HostImportError,
});

export const WsHostImportsSubmitSecretRpc = Rpc.make(WS_METHODS.hostImportsSubmitSecret, {
  payload: HostImportSubmitSecretInput,
  success: HostImportSubmitSecretResult,
  error: HostImportError,
});

export const WsHostImportsTerminalOpenRpc = Rpc.make(WS_METHODS.hostImportsTerminalOpen, {
  payload: HostImportTerminalOpenInput,
  success: HostImportTerminalSnapshot,
  error: HostImportError,
});

export const WsHostImportsTerminalResizeRpc = Rpc.make(WS_METHODS.hostImportsTerminalResize, {
  payload: HostImportTerminalResizeInput,
  error: HostImportError,
});

export const WsHostImportsSubscribeTerminalEventsRpc = Rpc.make(
  WS_METHODS.hostImportsSubscribeTerminalEvents,
  {
    payload: HostImportGetInput,
    success: HostImportTerminalEvent,
    error: HostImportError,
    stream: true,
  },
);

export const WsFlakeMaintenanceStartRpc = Rpc.make(WS_METHODS.flakeMaintenanceStart, {
  payload: FlakeMaintenanceStartInput,
  success: FlakeMaintenanceStartResult,
  error: FlakeMaintenanceError,
});

export const WsFlakeMaintenanceGetRpc = Rpc.make(WS_METHODS.flakeMaintenanceGet, {
  payload: FlakeMaintenanceGetInput,
  success: NullOrFlakeMaintenanceSummary,
  error: FlakeMaintenanceError,
});

export const WsFlakeMaintenanceStopRpc = Rpc.make(WS_METHODS.flakeMaintenanceStop, {
  payload: FlakeMaintenanceStopInput,
  success: NullOrFlakeMaintenanceSummary,
  error: FlakeMaintenanceError,
});

export const WsFlakeMaintenanceTerminalOpenRpc = Rpc.make(WS_METHODS.flakeMaintenanceTerminalOpen, {
  payload: FlakeMaintenanceTerminalOpenInput,
  success: FlakeMaintenanceTerminalSnapshot,
  error: FlakeMaintenanceError,
});

export const WsFlakeMaintenanceTerminalResizeRpc = Rpc.make(
  WS_METHODS.flakeMaintenanceTerminalResize,
  {
    payload: FlakeMaintenanceTerminalResizeInput,
    error: FlakeMaintenanceError,
  },
);

export const WsFlakeMaintenanceSubscribeTerminalEventsRpc = Rpc.make(
  WS_METHODS.flakeMaintenanceSubscribeTerminalEvents,
  {
    payload: FlakeMaintenanceGetInput,
    success: FlakeMaintenanceTerminalEvent,
    error: FlakeMaintenanceError,
    stream: true,
  },
);

export const WsShellOpenInEditorRpc = Rpc.make(WS_METHODS.shellOpenInEditor, {
  payload: OpenInEditorInput,
  error: OpenError,
});

export const WsFilesystemBrowseRpc = Rpc.make(WS_METHODS.filesystemBrowse, {
  payload: FilesystemBrowseInput,
  success: FilesystemBrowseResult,
  error: FilesystemBrowseError,
});

export const WsSubscribeGitStatusRpc = Rpc.make(WS_METHODS.subscribeGitStatus, {
  payload: GitStatusInput,
  success: GitStatusStreamEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitPullRpc = Rpc.make(WS_METHODS.gitPull, {
  payload: GitPullInput,
  success: GitPullResult,
  error: GitCommandError,
});

export const WsGitRefreshStatusRpc = Rpc.make(WS_METHODS.gitRefreshStatus, {
  payload: GitStatusInput,
  success: GitStatusResult,
  error: GitManagerServiceError,
});

export const WsGitRunStackedActionRpc = Rpc.make(WS_METHODS.gitRunStackedAction, {
  payload: GitRunStackedActionInput,
  success: GitActionProgressEvent,
  error: GitManagerServiceError,
  stream: true,
});

export const WsGitResolvePullRequestRpc = Rpc.make(WS_METHODS.gitResolvePullRequest, {
  payload: GitPullRequestRefInput,
  success: GitResolvePullRequestResult,
  error: GitManagerServiceError,
});

export const WsGitPreparePullRequestThreadRpc = Rpc.make(WS_METHODS.gitPreparePullRequestThread, {
  payload: GitPreparePullRequestThreadInput,
  success: GitPreparePullRequestThreadResult,
  error: GitManagerServiceError,
});

export const WsGitListBranchesRpc = Rpc.make(WS_METHODS.gitListBranches, {
  payload: GitListBranchesInput,
  success: GitListBranchesResult,
  error: GitCommandError,
});

export const WsGitCreateWorktreeRpc = Rpc.make(WS_METHODS.gitCreateWorktree, {
  payload: GitCreateWorktreeInput,
  success: GitCreateWorktreeResult,
  error: GitCommandError,
});

export const WsGitRemoveWorktreeRpc = Rpc.make(WS_METHODS.gitRemoveWorktree, {
  payload: GitRemoveWorktreeInput,
  error: GitCommandError,
});

export const WsGitCreateBranchRpc = Rpc.make(WS_METHODS.gitCreateBranch, {
  payload: GitCreateBranchInput,
  success: GitCreateBranchResult,
  error: GitCommandError,
});

export const WsGitCheckoutRpc = Rpc.make(WS_METHODS.gitCheckout, {
  payload: GitCheckoutInput,
  success: GitCheckoutResult,
  error: GitCommandError,
});

export const WsGitInitRpc = Rpc.make(WS_METHODS.gitInit, {
  payload: GitInitInput,
  error: GitCommandError,
});

export const WsTerminalOpenRpc = Rpc.make(WS_METHODS.terminalOpen, {
  payload: TerminalOpenInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalWriteRpc = Rpc.make(WS_METHODS.terminalWrite, {
  payload: TerminalWriteInput,
  error: TerminalError,
});

export const WsTerminalResizeRpc = Rpc.make(WS_METHODS.terminalResize, {
  payload: TerminalResizeInput,
  error: TerminalError,
});

export const WsTerminalClearRpc = Rpc.make(WS_METHODS.terminalClear, {
  payload: TerminalClearInput,
  error: TerminalError,
});

export const WsTerminalRestartRpc = Rpc.make(WS_METHODS.terminalRestart, {
  payload: TerminalRestartInput,
  success: TerminalSessionSnapshot,
  error: TerminalError,
});

export const WsTerminalCloseRpc = Rpc.make(WS_METHODS.terminalClose, {
  payload: TerminalCloseInput,
  error: TerminalError,
});

export const WsOrchestrationDispatchCommandRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.dispatchCommand,
  {
    payload: ClientOrchestrationCommand,
    success: OrchestrationRpcSchemas.dispatchCommand.output,
    error: OrchestrationDispatchCommandError,
  },
);

export const WsOrchestrationGetTurnDiffRpc = Rpc.make(ORCHESTRATION_WS_METHODS.getTurnDiff, {
  payload: OrchestrationGetTurnDiffInput,
  success: OrchestrationRpcSchemas.getTurnDiff.output,
  error: OrchestrationGetTurnDiffError,
});

export const WsOrchestrationGetFullThreadDiffRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.getFullThreadDiff,
  {
    payload: OrchestrationGetFullThreadDiffInput,
    success: OrchestrationRpcSchemas.getFullThreadDiff.output,
    error: OrchestrationGetFullThreadDiffError,
  },
);

export const WsOrchestrationReplayEventsRpc = Rpc.make(ORCHESTRATION_WS_METHODS.replayEvents, {
  payload: OrchestrationReplayEventsInput,
  success: OrchestrationRpcSchemas.replayEvents.output,
  error: OrchestrationReplayEventsError,
});

export const WsOrchestrationSubscribeShellRpc = Rpc.make(ORCHESTRATION_WS_METHODS.subscribeShell, {
  payload: OrchestrationRpcSchemas.subscribeShell.input,
  success: OrchestrationRpcSchemas.subscribeShell.output,
  error: OrchestrationGetSnapshotError,
  stream: true,
});

export const WsOrchestrationSubscribeThreadRpc = Rpc.make(
  ORCHESTRATION_WS_METHODS.subscribeThread,
  {
    payload: OrchestrationRpcSchemas.subscribeThread.input,
    success: OrchestrationRpcSchemas.subscribeThread.output,
    error: OrchestrationGetSnapshotError,
    stream: true,
  },
);

export const WsSubscribeTerminalEventsRpc = Rpc.make(WS_METHODS.subscribeTerminalEvents, {
  payload: Schema.Struct({}),
  success: TerminalEvent,
  stream: true,
});

export const WsSubscribeServerConfigRpc = Rpc.make(WS_METHODS.subscribeServerConfig, {
  payload: Schema.Struct({}),
  success: ServerConfigStreamEvent,
  error: Schema.Union([KeybindingsConfigError, ServerSettingsError]),
  stream: true,
});

export const WsSubscribeServerLifecycleRpc = Rpc.make(WS_METHODS.subscribeServerLifecycle, {
  payload: Schema.Struct({}),
  success: ServerLifecycleStreamEvent,
  stream: true,
});

export const WsSubscribeAuthAccessRpc = Rpc.make(WS_METHODS.subscribeAuthAccess, {
  payload: Schema.Struct({}),
  success: AuthAccessStreamEvent,
  stream: true,
});

export const WsRpcGroup = RpcGroup.make(
  WsServerGetConfigRpc,
  WsServerRefreshProvidersRpc,
  WsServerUpsertKeybindingRpc,
  WsServerGetSettingsRpc,
  WsServerUpdateSettingsRpc,
  WsProjectsSearchEntriesRpc,
  WsProjectsWriteFileRpc,
  WsProjectsGenerateHostDocumentationRpc,
  WsProjectsGetDashboardContentRpc,
  WsProjectsRebuildNixDesignerIndexRpc,
  WsProjectsGetSecretsSummaryRpc,
  WsFleetDeploymentsStartRpc,
  WsFleetDeploymentsGetRpc,
  WsFleetDeploymentsStopRpc,
  WsHostDeploymentsStartRpc,
  WsHostDeploymentsPreviewRpc,
  WsHostDeploymentsGetRpc,
  WsHostDeploymentsStopRpc,
  WsHostDeploymentsTerminalOpenRpc,
  WsHostDeploymentsTerminalResizeRpc,
  WsHostDeploymentsSubscribeTerminalEventsRpc,
  WsHostDriftRefreshRpc,
  WsHostDriftGetRpc,
  WsHostDriftCancelRpc,
  WsHostDriftSubmitSecretRpc,
  WsHostDriftReconcileRpc,
  WsHostDriftTerminalOpenRpc,
  WsHostDriftTerminalResizeRpc,
  WsHostDriftSubscribeTerminalEventsRpc,
  WsHostImportsStartRpc,
  WsHostImportsGetRpc,
  WsHostImportsCancelRpc,
  WsHostImportsSubmitSecretRpc,
  WsHostImportsTerminalOpenRpc,
  WsHostImportsTerminalResizeRpc,
  WsHostImportsSubscribeTerminalEventsRpc,
  WsFlakeMaintenanceStartRpc,
  WsFlakeMaintenanceGetRpc,
  WsFlakeMaintenanceStopRpc,
  WsFlakeMaintenanceTerminalOpenRpc,
  WsFlakeMaintenanceTerminalResizeRpc,
  WsFlakeMaintenanceSubscribeTerminalEventsRpc,
  WsShellOpenInEditorRpc,
  WsFilesystemBrowseRpc,
  WsSubscribeGitStatusRpc,
  WsGitPullRpc,
  WsGitRefreshStatusRpc,
  WsGitRunStackedActionRpc,
  WsGitResolvePullRequestRpc,
  WsGitPreparePullRequestThreadRpc,
  WsGitListBranchesRpc,
  WsGitCreateWorktreeRpc,
  WsGitRemoveWorktreeRpc,
  WsGitCreateBranchRpc,
  WsGitCheckoutRpc,
  WsGitInitRpc,
  WsTerminalOpenRpc,
  WsTerminalWriteRpc,
  WsTerminalResizeRpc,
  WsTerminalClearRpc,
  WsTerminalRestartRpc,
  WsTerminalCloseRpc,
  WsSubscribeTerminalEventsRpc,
  WsSubscribeServerConfigRpc,
  WsSubscribeServerLifecycleRpc,
  WsSubscribeAuthAccessRpc,
  WsOrchestrationDispatchCommandRpc,
  WsOrchestrationGetTurnDiffRpc,
  WsOrchestrationGetFullThreadDiffRpc,
  WsOrchestrationReplayEventsRpc,
  WsOrchestrationSubscribeShellRpc,
  WsOrchestrationSubscribeThreadRpc,
);
