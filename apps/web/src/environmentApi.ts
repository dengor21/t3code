import type { EnvironmentId, EnvironmentApi } from "@t3tools/contracts";

import type { WsRpcClient } from "./rpc/wsRpcClient";
import { readEnvironmentConnection } from "./environments/runtime";

const environmentApiOverridesForTests = new Map<EnvironmentId, EnvironmentApi>();

export function createEnvironmentApi(rpcClient: WsRpcClient): EnvironmentApi {
  return {
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
      getDashboardContent: rpcClient.projects.getDashboardContent,
      rebuildNixDesignerIndex: rpcClient.projects.rebuildNixDesignerIndex,
      getSecretsSummary: rpcClient.projects.getSecretsSummary,
      generateHostDocumentation: rpcClient.projects.generateHostDocumentation,
    },
    fleetDeployments: {
      start: rpcClient.fleetDeployments.start,
      get: rpcClient.fleetDeployments.get,
      stop: rpcClient.fleetDeployments.stop,
    },
    hostDeployments: {
      start: rpcClient.hostDeployments.start,
      preview: rpcClient.hostDeployments.preview,
      get: rpcClient.hostDeployments.get,
      stop: rpcClient.hostDeployments.stop,
      openTerminal: rpcClient.hostDeployments.openTerminal,
      resizeTerminal: rpcClient.hostDeployments.resizeTerminal,
      onTerminalEvent: (input, callback) =>
        rpcClient.hostDeployments.onTerminalEvent(input, callback),
    },
    hostDrift: {
      refresh: rpcClient.hostDrift.refresh,
      get: rpcClient.hostDrift.get,
      cancel: rpcClient.hostDrift.cancel,
      submitSecret: rpcClient.hostDrift.submitSecret,
      reconcile: rpcClient.hostDrift.reconcile,
      openTerminal: rpcClient.hostDrift.openTerminal,
      resizeTerminal: rpcClient.hostDrift.resizeTerminal,
      onTerminalEvent: (input, callback) => rpcClient.hostDrift.onTerminalEvent(input, callback),
    },
    hostImports: {
      start: rpcClient.hostImports.start,
      get: rpcClient.hostImports.get,
      cancel: rpcClient.hostImports.cancel,
      submitSecret: rpcClient.hostImports.submitSecret,
      openTerminal: rpcClient.hostImports.openTerminal,
      resizeTerminal: rpcClient.hostImports.resizeTerminal,
      onTerminalEvent: (input, callback) => rpcClient.hostImports.onTerminalEvent(input, callback),
    },
    flakeMaintenance: {
      start: rpcClient.flakeMaintenance.start,
      get: rpcClient.flakeMaintenance.get,
      stop: rpcClient.flakeMaintenance.stop,
      openTerminal: rpcClient.flakeMaintenance.openTerminal,
      resizeTerminal: rpcClient.flakeMaintenance.resizeTerminal,
      onTerminalEvent: (input, callback) =>
        rpcClient.flakeMaintenance.onTerminalEvent(input, callback),
    },
    filesystem: {
      browse: rpcClient.filesystem.browse,
    },
    git: {
      pull: rpcClient.git.pull,
      refreshStatus: rpcClient.git.refreshStatus,
      onStatus: (input, callback, options) => rpcClient.git.onStatus(input, callback, options),
      listBranches: rpcClient.git.listBranches,
      createWorktree: rpcClient.git.createWorktree,
      removeWorktree: rpcClient.git.removeWorktree,
      createBranch: rpcClient.git.createBranch,
      checkout: rpcClient.git.checkout,
      init: rpcClient.git.init,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
    },
    orchestration: {
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
    },
  };
}

export function readEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  if (!environmentId) {
    return undefined;
  }

  const overriddenApi = environmentApiOverridesForTests.get(environmentId);
  if (overriddenApi) {
    return overriddenApi;
  }

  const connection = readEnvironmentConnection(environmentId);
  return connection ? createEnvironmentApi(connection.client) : undefined;
}

export function ensureEnvironmentApi(environmentId: EnvironmentId): EnvironmentApi {
  const api = readEnvironmentApi(environmentId);
  if (!api) {
    throw new Error(`Environment API not found for environment ${environmentId}`);
  }
  return api;
}

export function __setEnvironmentApiOverrideForTests(
  environmentId: EnvironmentId,
  api: EnvironmentApi,
): void {
  environmentApiOverridesForTests.set(environmentId, api);
}

export function __resetEnvironmentApiOverridesForTests(): void {
  environmentApiOverridesForTests.clear();
}
