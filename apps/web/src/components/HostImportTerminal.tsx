import {
  type EnvironmentId,
  type HostImportTerminalEvent,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { readEnvironmentApi } from "../environmentApi";
import type { TerminalViewportEvent } from "./TerminalViewport";
import ReadOnlyJobTerminal from "./ReadOnlyJobTerminal";

function normalizeHostImportTerminalEvent(event: HostImportTerminalEvent): TerminalViewportEvent {
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

interface HostImportTerminalProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  cwd: string;
  terminalLabel?: string;
  autoFocus?: boolean;
  onSessionExited?: () => void;
}

export default function HostImportTerminal({
  environmentId,
  projectId,
  threadId,
  cwd,
  terminalLabel = "Secure analysis output",
  autoFocus = false,
  onSessionExited,
}: HostImportTerminalProps) {
  const api = readEnvironmentApi(environmentId);

  const subscribeToEvents = useCallback(
    (listener: (event: HostImportTerminalEvent) => void) => {
      if (!api) {
        return undefined;
      }
      return api.hostImports.onTerminalEvent(
        {
          projectId,
          threadId,
        },
        listener,
      );
    },
    [api, projectId, threadId],
  );

  const loadSnapshot = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!api) {
        throw new Error("Host import terminal API is unavailable.");
      }
      return api.hostImports.openTerminal({
        projectId,
        threadId,
        cols,
        rows,
      });
    },
    [api, projectId, threadId],
  );

  const resizeSession = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!api) {
        throw new Error("Host import terminal API is unavailable.");
      }
      await api.hostImports.resizeTerminal({
        projectId,
        threadId,
        cols,
        rows,
      });
    },
    [api, projectId, threadId],
  );

  return (
    <ReadOnlyJobTerminal
      terminalContextId="host-import"
      terminalLabel={terminalLabel}
      cwd={cwd}
      autoFocus={autoFocus}
      resetKey={`${projectId}:${threadId}`}
      subscribeToEvents={subscribeToEvents}
      normalizeEvent={normalizeHostImportTerminalEvent}
      className="host-import-terminal h-full w-full"
      {...(onSessionExited ? { onSessionExited } : {})}
      {...(api ? { loadSnapshot, onResize: resizeSession } : {})}
    />
  );
}
