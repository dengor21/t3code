import type { EnvironmentId, FlakeMaintenanceTerminalEvent, ProjectId } from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentApi } from "../environmentApi";
import type { TerminalViewportEvent } from "./TerminalViewport";
import ReadOnlyJobTerminal from "./ReadOnlyJobTerminal";

function normalizeFlakeMaintenanceTerminalEvent(
  event: FlakeMaintenanceTerminalEvent,
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

interface FlakeMaintenanceTerminalProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  cwd: string;
  terminalLabel?: string;
  autoFocus?: boolean;
  onSessionExited?: () => void;
}

export default function FlakeMaintenanceTerminal({
  environmentId,
  projectId,
  cwd,
  terminalLabel = "Flake maintenance output",
  autoFocus = false,
  onSessionExited,
}: FlakeMaintenanceTerminalProps) {
  const api = readEnvironmentApi(environmentId);

  const subscribeToEvents = useCallback(
    (listener: (event: FlakeMaintenanceTerminalEvent) => void) => {
      if (!api) {
        return undefined;
      }
      return api.flakeMaintenance.onTerminalEvent(
        {
          projectId,
        },
        listener,
      );
    },
    [api, projectId],
  );

  const loadSnapshot = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!api) {
        throw new Error("Flake maintenance terminal API is unavailable.");
      }
      return api.flakeMaintenance.openTerminal({
        projectId,
        cols,
        rows,
      });
    },
    [api, projectId],
  );

  const resizeSession = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!api) {
        throw new Error("Flake maintenance terminal API is unavailable.");
      }
      await api.flakeMaintenance.resizeTerminal({
        projectId,
        cols,
        rows,
      });
    },
    [api, projectId],
  );

  return (
    <ReadOnlyJobTerminal
      terminalContextId="flake-maintenance"
      terminalLabel={terminalLabel}
      cwd={cwd}
      autoFocus={autoFocus}
      resetKey={projectId}
      subscribeToEvents={subscribeToEvents}
      normalizeEvent={normalizeFlakeMaintenanceTerminalEvent}
      className="flake-maintenance-terminal h-full w-full"
      {...(onSessionExited ? { onSessionExited } : {})}
      {...(api ? { loadSnapshot, onResize: resizeSession } : {})}
    />
  );
}
