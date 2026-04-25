import {
  type EnvironmentId,
  type HostDriftTerminalEvent,
  type ProjectId,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentApi } from "../environmentApi";
import type { TerminalViewportEvent } from "./TerminalViewport";
import ReadOnlyJobTerminal from "./ReadOnlyJobTerminal";

function normalizeHostDriftTerminalEvent(event: HostDriftTerminalEvent): TerminalViewportEvent {
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

interface HostDriftTerminalProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  hostName: string;
  cwd: string;
  terminalLabel?: string;
  autoFocus?: boolean;
  onSessionExited?: () => void;
}

export default function HostDriftTerminal({
  environmentId,
  projectId,
  hostName,
  cwd,
  terminalLabel = "Host drift scan output",
  autoFocus = false,
  onSessionExited,
}: HostDriftTerminalProps) {
  const api = readEnvironmentApi(environmentId);

  const subscribeToEvents = useCallback(
    (listener: (event: HostDriftTerminalEvent) => void) => {
      if (!api) {
        return undefined;
      }
      return api.hostDrift.onTerminalEvent(
        {
          projectId,
          hostName,
        },
        listener,
      );
    },
    [api, hostName, projectId],
  );

  const loadSnapshot = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!api) {
        throw new Error("Host drift terminal API is unavailable.");
      }
      return api.hostDrift.openTerminal({
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
        throw new Error("Host drift terminal API is unavailable.");
      }
      await api.hostDrift.resizeTerminal({
        projectId,
        hostName,
        cols,
        rows,
      });
    },
    [api, hostName, projectId],
  );

  return (
    <ReadOnlyJobTerminal
      terminalContextId="host-drift"
      terminalLabel={terminalLabel}
      cwd={cwd}
      autoFocus={autoFocus}
      resetKey={`${projectId}:${hostName}`}
      subscribeToEvents={subscribeToEvents}
      normalizeEvent={normalizeHostDriftTerminalEvent}
      className="host-drift-terminal h-full w-full"
      {...(onSessionExited ? { onSessionExited } : {})}
      {...(api ? { loadSnapshot, onResize: resizeSession } : {})}
    />
  );
}
