import { FitAddon } from "@xterm/addon-fit";
import { type LocalApi } from "@t3tools/contracts";
import { Terminal, type ITheme } from "@xterm/xterm";
import { useEffect, useEffectEvent, useRef } from "react";

import type { TerminalContextSelection } from "~/lib/terminalContext";
import { openInPreferredEditor } from "../editorPreferences";
import {
  collectWrappedTerminalLinkLine,
  extractTerminalLinks,
  isTerminalLinkActivation,
  resolvePathLinkTarget,
  resolveWrappedTerminalLinkRange,
  wrappedTerminalLinkRangeIntersectsBufferLine,
} from "../terminal-links";
import {
  isTerminalClearShortcut,
  terminalDeleteShortcutData,
  terminalNavigationShortcutData,
} from "../keybindings";

const MULTI_CLICK_SELECTION_ACTION_DELAY_MS = 260;

function writeSystemMessage(terminal: Terminal, message: string): void {
  terminal.write(`\r\n[terminal] ${message}\r\n`);
}

function writeTerminalSnapshot(terminal: Terminal, snapshot: TerminalViewportSnapshot): void {
  terminal.write("\u001bc");
  if (snapshot.history.length > 0) {
    terminal.write(snapshot.history);
  }
}

function normalizeComputedColor(value: string | null | undefined, fallback: string): string {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return fallback;
  }
  return value ?? fallback;
}

function terminalThemeFromApp(mountElement?: HTMLElement | null): ITheme {
  const isDark = document.documentElement.classList.contains("dark");
  const fallbackBackground = isDark ? "rgb(14, 18, 24)" : "rgb(255, 255, 255)";
  const fallbackForeground = isDark ? "rgb(237, 241, 247)" : "rgb(28, 33, 41)";
  const drawerSurface =
    mountElement?.closest(
      ".thread-terminal-drawer,.host-deployment-terminal,.flake-maintenance-terminal,.read-only-job-terminal",
    ) ??
    document.querySelector(
      ".thread-terminal-drawer,.host-deployment-terminal,.flake-maintenance-terminal,.read-only-job-terminal",
    ) ??
    document.body;
  const drawerStyles = getComputedStyle(drawerSurface);
  const bodyStyles = getComputedStyle(document.body);
  const background = normalizeComputedColor(
    drawerStyles.backgroundColor,
    normalizeComputedColor(bodyStyles.backgroundColor, fallbackBackground),
  );
  const foreground = normalizeComputedColor(
    drawerStyles.color,
    normalizeComputedColor(bodyStyles.color, fallbackForeground),
  );

  if (isDark) {
    return {
      background,
      foreground,
      cursor: "rgb(180, 203, 255)",
      selectionBackground: "rgba(180, 203, 255, 0.25)",
      scrollbarSliderBackground: "rgba(255, 255, 255, 0.1)",
      scrollbarSliderHoverBackground: "rgba(255, 255, 255, 0.18)",
      scrollbarSliderActiveBackground: "rgba(255, 255, 255, 0.22)",
      black: "rgb(24, 30, 38)",
      red: "rgb(255, 122, 142)",
      green: "rgb(134, 231, 149)",
      yellow: "rgb(244, 205, 114)",
      blue: "rgb(137, 190, 255)",
      magenta: "rgb(208, 176, 255)",
      cyan: "rgb(124, 232, 237)",
      white: "rgb(210, 218, 230)",
      brightBlack: "rgb(110, 120, 136)",
      brightRed: "rgb(255, 168, 180)",
      brightGreen: "rgb(176, 245, 186)",
      brightYellow: "rgb(255, 224, 149)",
      brightBlue: "rgb(174, 210, 255)",
      brightMagenta: "rgb(229, 203, 255)",
      brightCyan: "rgb(167, 244, 247)",
      brightWhite: "rgb(244, 247, 252)",
    };
  }

  return {
    background,
    foreground,
    cursor: "rgb(38, 56, 78)",
    selectionBackground: "rgba(37, 63, 99, 0.2)",
    scrollbarSliderBackground: "rgba(0, 0, 0, 0.15)",
    scrollbarSliderHoverBackground: "rgba(0, 0, 0, 0.25)",
    scrollbarSliderActiveBackground: "rgba(0, 0, 0, 0.3)",
    black: "rgb(44, 53, 66)",
    red: "rgb(191, 70, 87)",
    green: "rgb(60, 126, 86)",
    yellow: "rgb(146, 112, 35)",
    blue: "rgb(72, 102, 163)",
    magenta: "rgb(132, 86, 149)",
    cyan: "rgb(53, 127, 141)",
    white: "rgb(210, 215, 223)",
    brightBlack: "rgb(112, 123, 140)",
    brightRed: "rgb(212, 95, 112)",
    brightGreen: "rgb(85, 148, 111)",
    brightYellow: "rgb(173, 133, 45)",
    brightBlue: "rgb(91, 124, 194)",
    brightMagenta: "rgb(153, 107, 172)",
    brightCyan: "rgb(70, 149, 164)",
    brightWhite: "rgb(236, 240, 246)",
  };
}

function getTerminalSelectionRect(mountElement: HTMLElement): DOMRect | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const range = selection.getRangeAt(0);
  const commonAncestor = range.commonAncestorContainer;
  const selectionRoot =
    commonAncestor instanceof Element ? commonAncestor : commonAncestor.parentElement;
  if (!(selectionRoot instanceof Element) || !mountElement.contains(selectionRoot)) {
    return null;
  }

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }

  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

export interface TerminalViewportSnapshot {
  status: "starting" | "running" | "exited" | "error";
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
}

export type TerminalViewportEvent =
  | {
      type: "started" | "restarted";
      createdAt: string;
      snapshot: TerminalViewportSnapshot;
    }
  | {
      type: "output";
      createdAt: string;
      data: string;
    }
  | {
      type: "exited";
      createdAt: string;
      exitCode: number | null;
      exitSignal: number | null;
    }
  | {
      type: "error";
      createdAt: string;
      message: string;
    }
  | {
      type: "cleared";
      createdAt: string;
    }
  | {
      type: "activity";
      createdAt: string;
      hasRunningSubprocess: boolean;
    };

export interface TerminalViewportEventEntry<TEvent extends TerminalViewportEvent> {
  id: number;
  event: TEvent;
}

export function selectTerminalEventEntriesAfterSnapshot<TEvent extends TerminalViewportEvent>(
  entries: ReadonlyArray<TerminalViewportEventEntry<TEvent>>,
  snapshotUpdatedAt: string,
): ReadonlyArray<TerminalViewportEventEntry<TEvent>> {
  return entries.filter((entry) => entry.event.createdAt > snapshotUpdatedAt);
}

export function selectPendingTerminalEventEntries<TEvent extends TerminalViewportEvent>(
  entries: ReadonlyArray<TerminalViewportEventEntry<TEvent>>,
  lastAppliedTerminalEventId: number,
): ReadonlyArray<TerminalViewportEventEntry<TEvent>> {
  return entries.filter((entry) => entry.id > lastAppliedTerminalEventId);
}

export function resolveTerminalSelectionActionPosition(options: {
  bounds: { left: number; top: number; width: number; height: number };
  selectionRect: { right: number; bottom: number } | null;
  pointer: { x: number; y: number } | null;
  viewport?: { width: number; height: number } | null;
}): { x: number; y: number } {
  const { bounds, selectionRect, pointer, viewport } = options;
  const viewportWidth =
    viewport?.width ??
    (typeof window === "undefined" ? bounds.left + bounds.width + 8 : window.innerWidth);
  const viewportHeight =
    viewport?.height ??
    (typeof window === "undefined" ? bounds.top + bounds.height + 8 : window.innerHeight);
  const viewportLeft = Math.round(bounds.left);
  const viewportTop = Math.round(bounds.top);
  const viewportRight = Math.round(bounds.left + bounds.width);
  const viewportBottom = Math.round(bounds.top + bounds.height);
  const preferredX =
    selectionRect !== null
      ? Math.round(selectionRect.right)
      : pointer === null
        ? Math.round(bounds.left + bounds.width - 140)
        : Math.max(viewportLeft, Math.min(Math.round(pointer.x), viewportRight));
  const preferredY =
    selectionRect !== null
      ? Math.round(selectionRect.bottom + 4)
      : pointer === null
        ? Math.round(bounds.top + 12)
        : Math.max(viewportTop, Math.min(Math.round(pointer.y), viewportBottom));
  return {
    x: Math.max(8, Math.min(preferredX, Math.max(viewportWidth - 8, 8))),
    y: Math.max(8, Math.min(preferredY, Math.max(viewportHeight - 8, 8))),
  };
}

export function terminalSelectionActionDelayForClickCount(clickCount: number): number {
  return clickCount >= 2 ? MULTI_CLICK_SELECTION_ACTION_DELAY_MS : 0;
}

export function shouldHandleTerminalSelectionMouseUp(
  selectionGestureActive: boolean,
  button: number,
): boolean {
  return selectionGestureActive && button === 0;
}

interface TerminalViewportCoreProps<TSnapshot extends TerminalViewportSnapshot> {
  localApi: LocalApi;
  terminalContextId: string;
  terminalLabel: string;
  cwd: string;
  onSessionExited: () => void;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
  focusRequestId: number;
  autoFocus: boolean;
  resizeEpoch: number;
  viewportHeight: number;
  reloadToken?: number;
  eventEntries: ReadonlyArray<TerminalViewportEventEntry<TerminalViewportEvent>>;
  loadSnapshot: (size: { cols: number; rows: number }) => Promise<TSnapshot>;
  onWrite?: (data: string) => Promise<void>;
  onResize?: (size: { cols: number; rows: number }) => Promise<void>;
}

export function TerminalViewportCore<TSnapshot extends TerminalViewportSnapshot>({
  localApi,
  terminalContextId,
  terminalLabel,
  cwd,
  onSessionExited,
  onAddTerminalContext,
  focusRequestId,
  autoFocus,
  resizeEpoch,
  viewportHeight,
  reloadToken = 0,
  eventEntries,
  loadSnapshot,
  onWrite,
  onResize,
}: TerminalViewportCoreProps<TSnapshot>) {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const hasHandledExitRef = useRef(false);
  const selectionPointerRef = useRef<{ x: number; y: number } | null>(null);
  const selectionGestureActiveRef = useRef(false);
  const selectionActionRequestIdRef = useRef(0);
  const selectionActionOpenRef = useRef(false);
  const selectionActionTimerRef = useRef<number | null>(null);
  const lastAppliedTerminalEventIdRef = useRef(0);
  const terminalHydratedRef = useRef(false);
  const eventEntriesRef = useRef(eventEntries);
  const handleSessionExited = useEffectEvent(() => {
    onSessionExited();
  });
  const handleAddTerminalContext = useEffectEvent((selection: TerminalContextSelection) => {
    onAddTerminalContext(selection);
  });
  const readTerminalLabel = useEffectEvent(() => terminalLabel);
  const readLoadSnapshot = useEffectEvent(loadSnapshot);
  const writeInput = useEffectEvent(async (data: string) => {
    if (!onWrite) {
      return;
    }
    await onWrite(data);
  });
  const resizeSession = useEffectEvent(async (size: { cols: number; rows: number }) => {
    if (!onResize) {
      return;
    }
    await onResize(size);
  });

  useEffect(() => {
    eventEntriesRef.current = eventEntries;
  }, [eventEntries]);

  useEffect(() => {
    const mount = containerRef.current;
    if (!mount) return;

    let disposed = false;
    const fitAddon = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: Boolean(onWrite),
      disableStdin: !onWrite,
      lineHeight: 1.2,
      fontSize: 12,
      scrollback: 5_000,
      fontFamily: '"SF Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace',
      theme: terminalThemeFromApp(mount),
    });
    terminal.loadAddon(fitAddon);
    terminal.open(mount);
    fitAddon.fit();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const clearSelectionAction = () => {
      selectionActionRequestIdRef.current += 1;
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
        selectionActionTimerRef.current = null;
      }
    };

    const readSelectionAction = (): {
      position: { x: number; y: number };
      selection: TerminalContextSelection;
    } | null => {
      const activeTerminal = terminalRef.current;
      const mountElement = containerRef.current;
      if (!activeTerminal || !mountElement || !activeTerminal.hasSelection()) {
        return null;
      }
      const selectionText = activeTerminal.getSelection();
      const selectionPosition = activeTerminal.getSelectionPosition();
      const normalizedText = selectionText.replace(/\r\n/g, "\n").replace(/^\n+|\n+$/g, "");
      if (!selectionPosition || normalizedText.length === 0) {
        return null;
      }
      const lineStart = selectionPosition.start.y + 1;
      const lineCount = normalizedText.split("\n").length;
      const lineEnd = Math.max(lineStart, lineStart + lineCount - 1);
      const bounds = mountElement.getBoundingClientRect();
      const selectionRect = getTerminalSelectionRect(mountElement);
      const position = resolveTerminalSelectionActionPosition({
        bounds,
        selectionRect:
          selectionRect === null
            ? null
            : { right: selectionRect.right, bottom: selectionRect.bottom },
        pointer: selectionPointerRef.current,
      });
      return {
        position,
        selection: {
          terminalId: terminalContextId,
          terminalLabel: readTerminalLabel(),
          lineStart,
          lineEnd,
          text: normalizedText,
        },
      };
    };

    const showSelectionAction = async () => {
      if (selectionActionOpenRef.current) {
        return;
      }
      const nextAction = readSelectionAction();
      if (!nextAction) {
        clearSelectionAction();
        return;
      }
      const requestId = ++selectionActionRequestIdRef.current;
      selectionActionOpenRef.current = true;
      try {
        const clicked = await localApi.contextMenu.show(
          [{ id: "add-to-chat", label: "Add to chat" }],
          nextAction.position,
        );
        if (requestId !== selectionActionRequestIdRef.current || clicked !== "add-to-chat") {
          return;
        }
        handleAddTerminalContext(nextAction.selection);
        terminalRef.current?.clearSelection();
        terminalRef.current?.focus();
      } finally {
        selectionActionOpenRef.current = false;
      }
    };

    const sendTerminalInput = async (data: string, fallbackError: string) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      try {
        await writeInput(data);
      } catch (error) {
        writeSystemMessage(activeTerminal, error instanceof Error ? error.message : fallbackError);
      }
    };

    if (onWrite) {
      terminal.attachCustomKeyEventHandler((event) => {
        const navigationData = terminalNavigationShortcutData(event);
        if (navigationData !== null) {
          event.preventDefault();
          event.stopPropagation();
          void sendTerminalInput(navigationData, "Failed to move cursor");
          return false;
        }

        const deleteData = terminalDeleteShortcutData(event);
        if (deleteData !== null) {
          event.preventDefault();
          event.stopPropagation();
          void sendTerminalInput(deleteData, "Failed to delete terminal input");
          return false;
        }

        if (!isTerminalClearShortcut(event)) return true;
        event.preventDefault();
        event.stopPropagation();
        void sendTerminalInput("\u000c", "Failed to clear terminal");
        return false;
      });
    }

    const terminalLinksDisposable = terminal.registerLinkProvider({
      provideLinks: (bufferLineNumber, callback) => {
        const activeTerminal = terminalRef.current;
        if (!activeTerminal) {
          callback(undefined);
          return;
        }

        const wrappedLine = collectWrappedTerminalLinkLine(bufferLineNumber, (bufferLineIndex) =>
          activeTerminal.buffer.active.getLine(bufferLineIndex),
        );
        if (!wrappedLine) {
          callback(undefined);
          return;
        }

        const links = extractTerminalLinks(wrappedLine.text)
          .map((match) => ({
            match,
            range: resolveWrappedTerminalLinkRange(wrappedLine, match),
          }))
          .filter(({ range }) =>
            wrappedTerminalLinkRangeIntersectsBufferLine(range, bufferLineNumber),
          );
        if (links.length === 0) {
          callback(undefined);
          return;
        }

        callback(
          links.map(({ match, range }) => ({
            text: match.text,
            range,
            activate: (event: MouseEvent) => {
              if (!isTerminalLinkActivation(event)) return;

              const latestTerminal = terminalRef.current;
              if (!latestTerminal) return;

              if (match.kind === "url") {
                void localApi.shell.openExternal(match.text).catch((error: unknown) => {
                  writeSystemMessage(
                    latestTerminal,
                    error instanceof Error ? error.message : "Unable to open link",
                  );
                });
                return;
              }

              const target = resolvePathLinkTarget(match.text, cwd);
              void openInPreferredEditor(localApi, target).catch((error) => {
                writeSystemMessage(
                  latestTerminal,
                  error instanceof Error ? error.message : "Unable to open path",
                );
              });
            },
          })),
        );
      },
    });

    const inputDisposable = onWrite
      ? terminal.onData((data) => {
          void writeInput(data).catch((err) =>
            writeSystemMessage(
              terminal,
              err instanceof Error ? err.message : "Terminal write failed",
            ),
          );
        })
      : { dispose: () => undefined };

    const selectionDisposable = terminal.onSelectionChange(() => {
      if (terminalRef.current?.hasSelection()) {
        return;
      }
      clearSelectionAction();
    });

    const handleMouseUp = (event: MouseEvent) => {
      const shouldHandle = shouldHandleTerminalSelectionMouseUp(
        selectionGestureActiveRef.current,
        event.button,
      );
      selectionGestureActiveRef.current = false;
      if (!shouldHandle) {
        return;
      }
      selectionPointerRef.current = { x: event.clientX, y: event.clientY };
      const delay = terminalSelectionActionDelayForClickCount(event.detail);
      selectionActionTimerRef.current = window.setTimeout(() => {
        selectionActionTimerRef.current = null;
        window.requestAnimationFrame(() => {
          void showSelectionAction();
        });
      }, delay);
    };
    const handlePointerDown = (event: PointerEvent) => {
      clearSelectionAction();
      selectionGestureActiveRef.current = event.button === 0;
    };
    window.addEventListener("mouseup", handleMouseUp);
    mount.addEventListener("pointerdown", handlePointerDown);

    const themeObserver = new MutationObserver(() => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) return;
      activeTerminal.options.theme = terminalThemeFromApp(containerRef.current);
      activeTerminal.refresh(0, activeTerminal.rows - 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });

    const applyTerminalEvent = (event: TerminalViewportEvent) => {
      const activeTerminal = terminalRef.current;
      if (!activeTerminal) {
        return;
      }

      if (event.type === "activity") {
        return;
      }

      if (event.type === "output") {
        activeTerminal.write(event.data);
        clearSelectionAction();
        return;
      }

      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        clearSelectionAction();
        writeTerminalSnapshot(activeTerminal, event.snapshot);
        return;
      }

      if (event.type === "cleared") {
        clearSelectionAction();
        activeTerminal.clear();
        activeTerminal.write("\u001bc");
        return;
      }

      if (event.type === "error") {
        writeSystemMessage(activeTerminal, event.message);
        return;
      }
      if (event.type !== "exited") {
        return;
      }

      const details = [
        typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
        typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
      ]
        .filter((value): value is string => value !== null)
        .join(", ");
      writeSystemMessage(
        activeTerminal,
        details.length > 0 ? `Process exited (${details})` : "Process exited",
      );
      if (hasHandledExitRef.current) {
        return;
      }
      hasHandledExitRef.current = true;
      window.setTimeout(() => {
        if (!hasHandledExitRef.current) {
          return;
        }
        handleSessionExited();
      }, 0);
    };

    const hydrateTerminal = async () => {
      try {
        const activeTerminal = terminalRef.current;
        const activeFitAddon = fitAddonRef.current;
        if (!activeTerminal || !activeFitAddon) return;
        activeFitAddon.fit();
        const snapshot = await readLoadSnapshot({
          cols: activeTerminal.cols,
          rows: activeTerminal.rows,
        });
        if (disposed) return;
        writeTerminalSnapshot(activeTerminal, snapshot);
        const bufferedEntries = eventEntriesRef.current;
        const replayEntries = selectTerminalEventEntriesAfterSnapshot(
          bufferedEntries,
          snapshot.updatedAt,
        );
        for (const entry of replayEntries) {
          applyTerminalEvent(entry.event);
        }
        lastAppliedTerminalEventIdRef.current = bufferedEntries.at(-1)?.id ?? 0;
        terminalHydratedRef.current = true;
        if (autoFocus) {
          window.requestAnimationFrame(() => {
            activeTerminal.focus();
          });
        }
      } catch (err) {
        if (disposed) return;
        writeSystemMessage(
          terminal,
          err instanceof Error ? err.message : "Failed to open terminal",
        );
      }
    };

    const fitTimer = window.setTimeout(() => {
      const activeTerminal = terminalRef.current;
      const activeFitAddon = fitAddonRef.current;
      if (!activeTerminal || !activeFitAddon) return;
      const wasAtBottom =
        activeTerminal.buffer.active.viewportY >= activeTerminal.buffer.active.baseY;
      activeFitAddon.fit();
      if (wasAtBottom) {
        activeTerminal.scrollToBottom();
      }
      void resizeSession({
        cols: activeTerminal.cols,
        rows: activeTerminal.rows,
      }).catch(() => undefined);
    }, 30);
    void hydrateTerminal();

    return () => {
      disposed = true;
      terminalHydratedRef.current = false;
      lastAppliedTerminalEventIdRef.current = 0;
      window.clearTimeout(fitTimer);
      inputDisposable.dispose();
      selectionDisposable.dispose();
      terminalLinksDisposable.dispose();
      if (selectionActionTimerRef.current !== null) {
        window.clearTimeout(selectionActionTimerRef.current);
      }
      window.removeEventListener("mouseup", handleMouseUp);
      mount.removeEventListener("pointerdown", handlePointerDown);
      themeObserver.disconnect();
      terminalRef.current = null;
      fitAddonRef.current = null;
      terminal.dispose();
    };
    // autoFocus and reloadToken are handled by separate effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd, localApi, onWrite, terminalContextId]);

  useEffect(() => {
    if (!terminalHydratedRef.current) {
      return;
    }
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) {
      return;
    }
    fitAddon.fit();
    void readLoadSnapshot({
      cols: terminal.cols,
      rows: terminal.rows,
    })
      .then((snapshot) => {
        if (!terminalRef.current) {
          return;
        }
        writeTerminalSnapshot(terminalRef.current, snapshot);
        const replayEntries = selectTerminalEventEntriesAfterSnapshot(
          eventEntriesRef.current,
          snapshot.updatedAt,
        );
        for (const entry of replayEntries) {
          if (!terminalRef.current) {
            return;
          }
          const currentTerminal = terminalRef.current;
          if (!currentTerminal) {
            return;
          }
          if (entry.event.type === "activity") {
            continue;
          }
          if (entry.event.type === "output") {
            currentTerminal.write(entry.event.data);
            continue;
          }
          if (entry.event.type === "started" || entry.event.type === "restarted") {
            writeTerminalSnapshot(currentTerminal, entry.event.snapshot);
            continue;
          }
          if (entry.event.type === "cleared") {
            currentTerminal.clear();
            currentTerminal.write("\u001bc");
            continue;
          }
          if (entry.event.type === "error") {
            writeSystemMessage(currentTerminal, entry.event.message);
            continue;
          }
          if (entry.event.type !== "exited") {
            continue;
          }
          const details = [
            typeof entry.event.exitCode === "number" ? `code ${entry.event.exitCode}` : null,
            typeof entry.event.exitSignal === "number" ? `signal ${entry.event.exitSignal}` : null,
          ]
            .filter((value): value is string => value !== null)
            .join(", ");
          writeSystemMessage(
            currentTerminal,
            details.length > 0 ? `Process exited (${details})` : "Process exited",
          );
        }
        lastAppliedTerminalEventIdRef.current = eventEntriesRef.current.at(-1)?.id ?? 0;
      })
      .catch((error) => {
        if (!terminalRef.current) {
          return;
        }
        writeSystemMessage(
          terminalRef.current,
          error instanceof Error ? error.message : "Failed to reopen terminal",
        );
      });
  }, [reloadToken]);

  useEffect(() => {
    if (!terminalHydratedRef.current) {
      return;
    }
    const terminal = terminalRef.current;
    if (!terminal) {
      return;
    }
    const pendingEntries = selectPendingTerminalEventEntries(
      eventEntries,
      lastAppliedTerminalEventIdRef.current,
    );
    if (pendingEntries.length === 0) {
      return;
    }
    for (const entry of pendingEntries) {
      const event = entry.event;
      if (event.type === "activity") {
        continue;
      }
      if (event.type === "output") {
        terminal.write(event.data);
        continue;
      }
      if (event.type === "started" || event.type === "restarted") {
        hasHandledExitRef.current = false;
        writeTerminalSnapshot(terminal, event.snapshot);
        continue;
      }
      if (event.type === "cleared") {
        terminal.clear();
        terminal.write("\u001bc");
        continue;
      }
      if (event.type === "error") {
        writeSystemMessage(terminal, event.message);
        continue;
      }
      if (event.type !== "exited") {
        continue;
      }
      const details = [
        typeof event.exitCode === "number" ? `code ${event.exitCode}` : null,
        typeof event.exitSignal === "number" ? `signal ${event.exitSignal}` : null,
      ]
        .filter((value): value is string => value !== null)
        .join(", ");
      writeSystemMessage(
        terminal,
        details.length > 0 ? `Process exited (${details})` : "Process exited",
      );
      if (!hasHandledExitRef.current) {
        hasHandledExitRef.current = true;
        window.setTimeout(() => {
          if (!hasHandledExitRef.current) {
            return;
          }
          handleSessionExited();
        }, 0);
      }
    }
    lastAppliedTerminalEventIdRef.current =
      pendingEntries.at(-1)?.id ?? lastAppliedTerminalEventIdRef.current;
  }, [eventEntries]);

  useEffect(() => {
    if (!autoFocus) return;
    const terminal = terminalRef.current;
    if (!terminal) return;
    const frame = window.requestAnimationFrame(() => {
      terminal.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [autoFocus, focusRequestId]);

  useEffect(() => {
    const terminal = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!terminal || !fitAddon) return;
    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    const frame = window.requestAnimationFrame(() => {
      fitAddon.fit();
      if (wasAtBottom) {
        terminal.scrollToBottom();
      }
      void resizeSession({
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => undefined);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [resizeEpoch, viewportHeight]);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-[4px] bg-background"
    />
  );
}
