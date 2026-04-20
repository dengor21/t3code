import {
  type EnvironmentId,
  type HostDeploymentTerminalEvent,
  type ProjectId,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentApi } from "../environmentApi";
import type { TerminalViewportEvent } from "./TerminalViewport";
import ReadOnlyJobTerminal from "./ReadOnlyJobTerminal";

function normalizeHostDeploymentTerminalEvent(
  event: HostDeploymentTerminalEvent,
): TerminalViewportEvent {
  switch (event.type) {
    case "started":
    case "restarted":
      return {
        type: event.type,
        createdAt: event.createdAt,
        snapshot: event.snapshot,
      };
    case "output":
      return {
        type: "output",
        createdAt: event.createdAt,
        data: event.data,
      };
    case "exited":
      return {
        type: "exited",
        createdAt: event.createdAt,
        exitCode: event.exitCode,
        exitSignal: event.exitSignal,
      };
    case "error":
      return {
        type: "error",
        createdAt: event.createdAt,
        message: event.message,
      };
    case "cleared":
      return {
        type: "cleared",
        createdAt: event.createdAt,
      };
    case "activity":
      return {
        type: "activity",
        createdAt: event.createdAt,
        hasRunningSubprocess: event.hasRunningSubprocess,
      };
  }
}

interface HostDeploymentTerminalProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  hostName: string;
  cwd: string;
  terminalLabel?: string;
  autoFocus?: boolean;
  onSessionExited?: () => void;
}

export default function HostDeploymentTerminal({
  environmentId,
  projectId,
  hostName,
  cwd,
  terminalLabel = "Deployment output",
  autoFocus = false,
  onSessionExited,
}: HostDeploymentTerminalProps) {
  const api = readEnvironmentApi(environmentId);

  const loadSnapshot = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!api) {
        throw new Error("Host deployment terminal API is unavailable.");
      }
      return api.hostDeployments.openTerminal({
        projectId,
        hostName,
        cols,
        rows,
      });
    },
    [api, hostName, projectId],
  );

  const resizeSession = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!api) {
        throw new Error("Host deployment terminal API is unavailable.");
      }
      await api.hostDeployments.resizeTerminal({
        projectId,
        hostName,
        cols,
        rows,
      });
    },
    [api, hostName, projectId],
  );

  const subscribeToEvents = useCallback(
    (listener: (event: HostDeploymentTerminalEvent) => void) => {
      if (!api) {
        return undefined;
      }
      return api.hostDeployments.onTerminalEvent(
        {
          projectId,
          hostName,
        },
        listener,
      );
    },
    [api, hostName, projectId],
  );

  return (
    <ReadOnlyJobTerminal
      terminalContextId="host-deployment"
      terminalLabel={terminalLabel}
      cwd={cwd}
      autoFocus={autoFocus}
      resetKey={`${projectId}:${hostName}`}
      subscribeToEvents={subscribeToEvents}
      normalizeEvent={normalizeHostDeploymentTerminalEvent}
      className="host-deployment-terminal h-full w-full"
      {...(onSessionExited ? { onSessionExited } : {})}
      {...(api ? { loadSnapshot, onResize: resizeSession } : {})}
    />
  );
}
