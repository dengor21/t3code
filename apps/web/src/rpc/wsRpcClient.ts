import {
  type GitActionProgressEvent,
  type GitRunStackedActionInput,
  type GitRunStackedActionResult,
  type GitStatusResult,
  type GitStatusStreamEvent,
  type LocalApi,
  ORCHESTRATION_WS_METHODS,
  type ServerSettingsPatch,
  WS_METHODS,
} from "@t3tools/contracts";
import { applyGitStatusStreamEvent } from "@t3tools/shared/git";
import { Effect, Stream } from "effect";

import { type WsRpcProtocolClient } from "./protocol";
import { resetWsReconnectBackoff } from "./wsConnectionState";
import { WsTransport } from "./wsTransport";

type RpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends RpcTag> = WsRpcProtocolClient[TTag];
type RpcInput<TTag extends RpcTag> = Parameters<RpcMethod<TTag>>[0];

interface StreamSubscriptionOptions {
  readonly onResubscribe?: () => void;
}

type RpcUnaryMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? (input: RpcInput<TTag>) => Promise<TSuccess>
    : never;

type RpcUnaryNoArgMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer TSuccess, any, any>
    ? () => Promise<TSuccess>
    : never;

type RpcStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (listener: (event: TEvent) => void, options?: StreamSubscriptionOptions) => () => void
    : never;

type RpcInputStreamMethod<TTag extends RpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer TEvent, any, any>
    ? (
        input: RpcInput<TTag>,
        listener: (event: TEvent) => void,
        options?: StreamSubscriptionOptions,
      ) => () => void
    : never;

interface GitRunStackedActionOptions {
  readonly onProgress?: (event: GitActionProgressEvent) => void;
}

export interface WsRpcClient {
  readonly dispose: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly terminal: {
    readonly open: RpcUnaryMethod<typeof WS_METHODS.terminalOpen>;
    readonly write: RpcUnaryMethod<typeof WS_METHODS.terminalWrite>;
    readonly resize: RpcUnaryMethod<typeof WS_METHODS.terminalResize>;
    readonly clear: RpcUnaryMethod<typeof WS_METHODS.terminalClear>;
    readonly restart: RpcUnaryMethod<typeof WS_METHODS.terminalRestart>;
    readonly close: RpcUnaryMethod<typeof WS_METHODS.terminalClose>;
    readonly onEvent: RpcStreamMethod<typeof WS_METHODS.subscribeTerminalEvents>;
  };
  readonly projects: {
    readonly searchEntries: RpcUnaryMethod<typeof WS_METHODS.projectsSearchEntries>;
    readonly writeFile: RpcUnaryMethod<typeof WS_METHODS.projectsWriteFile>;
    readonly bootstrapFlake: RpcUnaryMethod<typeof WS_METHODS.projectsBootstrapFlake>;
    readonly getDashboardContent: RpcUnaryMethod<typeof WS_METHODS.projectsGetDashboardContent>;
    readonly rebuildNixDesignerIndex: RpcUnaryMethod<
      typeof WS_METHODS.projectsRebuildNixDesignerIndex
    >;
    readonly getSecretsSummary: RpcUnaryMethod<typeof WS_METHODS.projectsGetSecretsSummary>;
    readonly generateHostDocumentation: RpcUnaryMethod<
      typeof WS_METHODS.projectsGenerateHostDocumentation
    >;
  };
  readonly fleetDeployments: {
    readonly start: RpcUnaryMethod<typeof WS_METHODS.fleetDeploymentsStart>;
    readonly get: RpcUnaryMethod<typeof WS_METHODS.fleetDeploymentsGet>;
    readonly stop: RpcUnaryMethod<typeof WS_METHODS.fleetDeploymentsStop>;
  };
  readonly hostDeployments: {
    readonly start: RpcUnaryMethod<typeof WS_METHODS.hostDeploymentsStart>;
    readonly preview: RpcUnaryMethod<typeof WS_METHODS.hostDeploymentsPreview>;
    readonly get: RpcUnaryMethod<typeof WS_METHODS.hostDeploymentsGet>;
    readonly stop: RpcUnaryMethod<typeof WS_METHODS.hostDeploymentsStop>;
    readonly openTerminal: RpcUnaryMethod<typeof WS_METHODS.hostDeploymentsTerminalOpen>;
    readonly resizeTerminal: RpcUnaryMethod<typeof WS_METHODS.hostDeploymentsTerminalResize>;
    readonly onTerminalEvent: RpcInputStreamMethod<
      typeof WS_METHODS.hostDeploymentsSubscribeTerminalEvents
    >;
  };
  readonly hostDrift: {
    readonly refresh: RpcUnaryMethod<typeof WS_METHODS.hostDriftRefresh>;
    readonly get: RpcUnaryMethod<typeof WS_METHODS.hostDriftGet>;
    readonly cancel: RpcUnaryMethod<typeof WS_METHODS.hostDriftCancel>;
    readonly submitSecret: RpcUnaryMethod<typeof WS_METHODS.hostDriftSubmitSecret>;
    readonly reconcile: RpcUnaryMethod<typeof WS_METHODS.hostDriftReconcile>;
    readonly openTerminal: RpcUnaryMethod<typeof WS_METHODS.hostDriftTerminalOpen>;
    readonly resizeTerminal: RpcUnaryMethod<typeof WS_METHODS.hostDriftTerminalResize>;
    readonly onTerminalEvent: RpcInputStreamMethod<
      typeof WS_METHODS.hostDriftSubscribeTerminalEvents
    >;
  };
  readonly hostImports: {
    readonly start: RpcUnaryMethod<typeof WS_METHODS.hostImportsStart>;
    readonly get: RpcUnaryMethod<typeof WS_METHODS.hostImportsGet>;
    readonly cancel: RpcUnaryMethod<typeof WS_METHODS.hostImportsCancel>;
    readonly submitSecret: RpcUnaryMethod<typeof WS_METHODS.hostImportsSubmitSecret>;
    readonly openTerminal: RpcUnaryMethod<typeof WS_METHODS.hostImportsTerminalOpen>;
    readonly resizeTerminal: RpcUnaryMethod<typeof WS_METHODS.hostImportsTerminalResize>;
    readonly onTerminalEvent: RpcInputStreamMethod<
      typeof WS_METHODS.hostImportsSubscribeTerminalEvents
    >;
  };
  readonly flakeMaintenance: {
    readonly start: RpcUnaryMethod<typeof WS_METHODS.flakeMaintenanceStart>;
    readonly get: RpcUnaryMethod<typeof WS_METHODS.flakeMaintenanceGet>;
    readonly stop: RpcUnaryMethod<typeof WS_METHODS.flakeMaintenanceStop>;
    readonly openTerminal: RpcUnaryMethod<typeof WS_METHODS.flakeMaintenanceTerminalOpen>;
    readonly resizeTerminal: RpcUnaryMethod<typeof WS_METHODS.flakeMaintenanceTerminalResize>;
    readonly onTerminalEvent: RpcInputStreamMethod<
      typeof WS_METHODS.flakeMaintenanceSubscribeTerminalEvents
    >;
  };
  readonly filesystem: {
    readonly browse: RpcUnaryMethod<typeof WS_METHODS.filesystemBrowse>;
  };
  readonly shell: {
    readonly openInEditor: (input: {
      readonly cwd: Parameters<LocalApi["shell"]["openInEditor"]>[0];
      readonly editor: Parameters<LocalApi["shell"]["openInEditor"]>[1];
    }) => ReturnType<LocalApi["shell"]["openInEditor"]>;
  };
  readonly git: {
    readonly pull: RpcUnaryMethod<typeof WS_METHODS.gitPull>;
    readonly refreshStatus: RpcUnaryMethod<typeof WS_METHODS.gitRefreshStatus>;
    readonly onStatus: (
      input: RpcInput<typeof WS_METHODS.subscribeGitStatus>,
      listener: (status: GitStatusResult) => void,
      options?: StreamSubscriptionOptions,
    ) => () => void;
    readonly runStackedAction: (
      input: GitRunStackedActionInput,
      options?: GitRunStackedActionOptions,
    ) => Promise<GitRunStackedActionResult>;
    readonly listBranches: RpcUnaryMethod<typeof WS_METHODS.gitListBranches>;
    readonly createWorktree: RpcUnaryMethod<typeof WS_METHODS.gitCreateWorktree>;
    readonly removeWorktree: RpcUnaryMethod<typeof WS_METHODS.gitRemoveWorktree>;
    readonly createBranch: RpcUnaryMethod<typeof WS_METHODS.gitCreateBranch>;
    readonly checkout: RpcUnaryMethod<typeof WS_METHODS.gitCheckout>;
    readonly init: RpcUnaryMethod<typeof WS_METHODS.gitInit>;
    readonly resolvePullRequest: RpcUnaryMethod<typeof WS_METHODS.gitResolvePullRequest>;
    readonly preparePullRequestThread: RpcUnaryMethod<
      typeof WS_METHODS.gitPreparePullRequestThread
    >;
  };
  readonly server: {
    readonly getConfig: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetConfig>;
    readonly refreshProviders: RpcUnaryNoArgMethod<typeof WS_METHODS.serverRefreshProviders>;
    readonly upsertKeybinding: RpcUnaryMethod<typeof WS_METHODS.serverUpsertKeybinding>;
    readonly getSettings: RpcUnaryNoArgMethod<typeof WS_METHODS.serverGetSettings>;
    readonly updateSettings: (
      patch: ServerSettingsPatch,
    ) => ReturnType<RpcUnaryMethod<typeof WS_METHODS.serverUpdateSettings>>;
    readonly subscribeConfig: RpcStreamMethod<typeof WS_METHODS.subscribeServerConfig>;
    readonly subscribeLifecycle: RpcStreamMethod<typeof WS_METHODS.subscribeServerLifecycle>;
    readonly subscribeAuthAccess: RpcStreamMethod<typeof WS_METHODS.subscribeAuthAccess>;
  };
  readonly orchestration: {
    readonly dispatchCommand: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.dispatchCommand>;
    readonly getTurnDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getTurnDiff>;
    readonly getFullThreadDiff: RpcUnaryMethod<typeof ORCHESTRATION_WS_METHODS.getFullThreadDiff>;
    readonly subscribeShell: RpcStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeShell>;
    readonly subscribeThread: RpcInputStreamMethod<typeof ORCHESTRATION_WS_METHODS.subscribeThread>;
  };
}

export function createWsRpcClient(transport: WsTransport): WsRpcClient {
  return {
    dispose: () => transport.dispose(),
    reconnect: async () => {
      resetWsReconnectBackoff();
      await transport.reconnect();
    },
    terminal: {
      open: (input) => transport.request((client) => client[WS_METHODS.terminalOpen](input)),
      write: (input) => transport.request((client) => client[WS_METHODS.terminalWrite](input)),
      resize: (input) => transport.request((client) => client[WS_METHODS.terminalResize](input)),
      clear: (input) => transport.request((client) => client[WS_METHODS.terminalClear](input)),
      restart: (input) => transport.request((client) => client[WS_METHODS.terminalRestart](input)),
      close: (input) => transport.request((client) => client[WS_METHODS.terminalClose](input)),
      onEvent: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeTerminalEvents]({}),
          listener,
          options,
        ),
    },
    projects: {
      searchEntries: (input) =>
        transport.request((client) => client[WS_METHODS.projectsSearchEntries](input)),
      writeFile: (input) =>
        transport.request((client) => client[WS_METHODS.projectsWriteFile](input)),
      bootstrapFlake: (input) =>
        transport.request((client) => client[WS_METHODS.projectsBootstrapFlake](input)),
      getDashboardContent: (input) =>
        transport.request((client) => client[WS_METHODS.projectsGetDashboardContent](input)),
      rebuildNixDesignerIndex: (input) =>
        transport.request((client) => client[WS_METHODS.projectsRebuildNixDesignerIndex](input)),
      getSecretsSummary: (input) =>
        transport.request((client) => client[WS_METHODS.projectsGetSecretsSummary](input)),
      generateHostDocumentation: (input) =>
        transport.request((client) => client[WS_METHODS.projectsGenerateHostDocumentation](input)),
    },
    fleetDeployments: {
      start: (input) =>
        transport.request((client) => client[WS_METHODS.fleetDeploymentsStart](input)),
      get: (input) => transport.request((client) => client[WS_METHODS.fleetDeploymentsGet](input)),
      stop: (input) =>
        transport.request((client) => client[WS_METHODS.fleetDeploymentsStop](input)),
    },
    hostDeployments: {
      start: (input) =>
        transport.request((client) => client[WS_METHODS.hostDeploymentsStart](input)),
      preview: (input) =>
        transport.request((client) => client[WS_METHODS.hostDeploymentsPreview](input)),
      get: (input) => transport.request((client) => client[WS_METHODS.hostDeploymentsGet](input)),
      stop: (input) => transport.request((client) => client[WS_METHODS.hostDeploymentsStop](input)),
      openTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.hostDeploymentsTerminalOpen](input)),
      resizeTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.hostDeploymentsTerminalResize](input)),
      onTerminalEvent: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.hostDeploymentsSubscribeTerminalEvents](input),
          listener,
          options,
        ),
    },
    hostDrift: {
      refresh: (input) => transport.request((client) => client[WS_METHODS.hostDriftRefresh](input)),
      get: (input) => transport.request((client) => client[WS_METHODS.hostDriftGet](input)),
      cancel: (input) => transport.request((client) => client[WS_METHODS.hostDriftCancel](input)),
      submitSecret: (input) =>
        transport.request((client) => client[WS_METHODS.hostDriftSubmitSecret](input)),
      reconcile: (input) =>
        transport.request((client) => client[WS_METHODS.hostDriftReconcile](input)),
      openTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.hostDriftTerminalOpen](input)),
      resizeTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.hostDriftTerminalResize](input)),
      onTerminalEvent: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.hostDriftSubscribeTerminalEvents](input),
          listener,
          options,
        ),
    },
    hostImports: {
      start: (input) => transport.request((client) => client[WS_METHODS.hostImportsStart](input)),
      get: (input) => transport.request((client) => client[WS_METHODS.hostImportsGet](input)),
      cancel: (input) => transport.request((client) => client[WS_METHODS.hostImportsCancel](input)),
      submitSecret: (input) =>
        transport.request((client) => client[WS_METHODS.hostImportsSubmitSecret](input)),
      openTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.hostImportsTerminalOpen](input)),
      resizeTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.hostImportsTerminalResize](input)),
      onTerminalEvent: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.hostImportsSubscribeTerminalEvents](input),
          listener,
          options,
        ),
    },
    flakeMaintenance: {
      start: (input) =>
        transport.request((client) => client[WS_METHODS.flakeMaintenanceStart](input)),
      get: (input) => transport.request((client) => client[WS_METHODS.flakeMaintenanceGet](input)),
      stop: (input) =>
        transport.request((client) => client[WS_METHODS.flakeMaintenanceStop](input)),
      openTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.flakeMaintenanceTerminalOpen](input)),
      resizeTerminal: (input) =>
        transport.request((client) => client[WS_METHODS.flakeMaintenanceTerminalResize](input)),
      onTerminalEvent: (input, listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.flakeMaintenanceSubscribeTerminalEvents](input),
          listener,
          options,
        ),
    },
    filesystem: {
      browse: (input) => transport.request((client) => client[WS_METHODS.filesystemBrowse](input)),
    },
    shell: {
      openInEditor: (input) =>
        transport.request((client) => client[WS_METHODS.shellOpenInEditor](input)),
    },
    git: {
      pull: (input) => transport.request((client) => client[WS_METHODS.gitPull](input)),
      refreshStatus: (input) =>
        transport.request((client) => client[WS_METHODS.gitRefreshStatus](input)),
      onStatus: (input, listener, options) => {
        let current: GitStatusResult | null = null;
        return transport.subscribe(
          (client) => client[WS_METHODS.subscribeGitStatus](input),
          (event: GitStatusStreamEvent) => {
            current = applyGitStatusStreamEvent(current, event);
            listener(current);
          },
          options,
        );
      },
      runStackedAction: async (input, options) => {
        let result: GitRunStackedActionResult | null = null;

        await transport.requestStream(
          (client) => client[WS_METHODS.gitRunStackedAction](input),
          (event) => {
            options?.onProgress?.(event);
            if (event.kind === "action_finished") {
              result = event.result;
            }
          },
        );

        if (result) {
          return result;
        }

        throw new Error("Git action stream completed without a final result.");
      },
      listBranches: (input) =>
        transport.request((client) => client[WS_METHODS.gitListBranches](input)),
      createWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateWorktree](input)),
      removeWorktree: (input) =>
        transport.request((client) => client[WS_METHODS.gitRemoveWorktree](input)),
      createBranch: (input) =>
        transport.request((client) => client[WS_METHODS.gitCreateBranch](input)),
      checkout: (input) => transport.request((client) => client[WS_METHODS.gitCheckout](input)),
      init: (input) => transport.request((client) => client[WS_METHODS.gitInit](input)),
      resolvePullRequest: (input) =>
        transport.request((client) => client[WS_METHODS.gitResolvePullRequest](input)),
      preparePullRequestThread: (input) =>
        transport.request((client) => client[WS_METHODS.gitPreparePullRequestThread](input)),
    },
    server: {
      getConfig: () => transport.request((client) => client[WS_METHODS.serverGetConfig]({})),
      refreshProviders: () =>
        transport.request((client) => client[WS_METHODS.serverRefreshProviders]({})),
      upsertKeybinding: (input) =>
        transport.request((client) => client[WS_METHODS.serverUpsertKeybinding](input)),
      getSettings: () => transport.request((client) => client[WS_METHODS.serverGetSettings]({})),
      updateSettings: (patch) =>
        transport.request((client) => client[WS_METHODS.serverUpdateSettings]({ patch })),
      subscribeConfig: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerConfig]({}),
          listener,
          options,
        ),
      subscribeLifecycle: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeServerLifecycle]({}),
          listener,
          options,
        ),
      subscribeAuthAccess: (listener, options) =>
        transport.subscribe(
          (client) => client[WS_METHODS.subscribeAuthAccess]({}),
          listener,
          options,
        ),
    },
    orchestration: {
      dispatchCommand: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.dispatchCommand](input)),
      getTurnDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getTurnDiff](input)),
      getFullThreadDiff: (input) =>
        transport.request((client) => client[ORCHESTRATION_WS_METHODS.getFullThreadDiff](input)),
      subscribeShell: (listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeShell]({}),
          listener,
          options,
        ),
      subscribeThread: (input, listener, options) =>
        transport.subscribe(
          (client) => client[ORCHESTRATION_WS_METHODS.subscribeThread](input),
          listener,
          options,
        ),
    },
  };
}
