import { useCallback, useEffect, useRef, useState } from "react";

import { readLocalApi } from "../localApi";
import {
  TerminalViewportCore,
  type TerminalViewportEvent,
  type TerminalViewportEventEntry,
  type TerminalViewportSnapshot,
} from "./TerminalViewport";

interface ReadOnlyJobTerminalProps<TEvent> {
  terminalContextId: string;
  terminalLabel?: string;
  cwd: string;
  autoFocus?: boolean;
  onSessionExited?: () => void;
  resetKey: string;
  subscribeToEvents?: (listener: (event: TEvent) => void) => (() => void) | undefined;
  loadSnapshot?: (size: { cols: number; rows: number }) => Promise<TerminalViewportSnapshot>;
  onResize?: (size: { cols: number; rows: number }) => Promise<void>;
  normalizeEvent: (event: TEvent) => TerminalViewportEvent;
  className?: string;
}

export default function ReadOnlyJobTerminal<TEvent>({
  terminalContextId,
  terminalLabel = "Terminal output",
  cwd,
  autoFocus = false,
  onSessionExited,
  resetKey,
  subscribeToEvents,
  loadSnapshot,
  onResize,
  normalizeEvent,
  className = "read-only-job-terminal h-full w-full",
}: ReadOnlyJobTerminalProps<TEvent>) {
  const localApi = readLocalApi();
  const nextEventIdRef = useRef(0);
  const [eventEntries, setEventEntries] = useState<
    ReadonlyArray<TerminalViewportEventEntry<TerminalViewportEvent>>
  >([]);
  const [reloadToken, setReloadToken] = useState(0);
  const [resizeEpoch, setResizeEpoch] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(
    typeof window === "undefined" ? 480 : window.innerHeight,
  );

  useEffect(() => {
    nextEventIdRef.current = 0;
    setEventEntries([]);
    setReloadToken((current) => current + 1);
  }, [resetKey]);

  useEffect(() => {
    const handleResize = () => {
      setViewportHeight(window.innerHeight);
      setResizeEpoch((current) => current + 1);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
    };
  }, []);

  useEffect(() => {
    if (!subscribeToEvents) {
      return;
    }
    return subscribeToEvents((event) => {
      const entry: TerminalViewportEventEntry<TerminalViewportEvent> = {
        id: nextEventIdRef.current + 1,
        event: normalizeEvent(event),
      };
      nextEventIdRef.current = entry.id;
      setEventEntries((current) => [...current, entry]);
    });
  }, [normalizeEvent, subscribeToEvents]);

  const handleLoadSnapshot = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!loadSnapshot) {
        throw new Error("Terminal snapshot loader is unavailable.");
      }
      return loadSnapshot({ cols, rows });
    },
    [loadSnapshot],
  );

  const handleResize = useCallback(
    async ({ cols, rows }: { cols: number; rows: number }) => {
      if (!onResize) {
        return;
      }
      await onResize({ cols, rows });
    },
    [onResize],
  );

  if (!localApi || !loadSnapshot) {
    return (
      <div
        className={`read-only-job-terminal relative overflow-hidden rounded-[4px] bg-background ${className}`}
      />
    );
  }

  return (
    <div className={className}>
      <TerminalViewportCore
        localApi={localApi}
        terminalContextId={terminalContextId}
        terminalLabel={terminalLabel}
        cwd={cwd}
        onSessionExited={onSessionExited ?? (() => undefined)}
        onAddTerminalContext={() => undefined}
        focusRequestId={0}
        autoFocus={autoFocus}
        resizeEpoch={resizeEpoch}
        viewportHeight={viewportHeight}
        reloadToken={reloadToken}
        eventEntries={eventEntries}
        loadSnapshot={handleLoadSnapshot}
        onResize={handleResize}
      />
    </div>
  );
}
