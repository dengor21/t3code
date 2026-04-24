import "../../index.css";

import { EnvironmentId } from "@t3tools/contracts";
import { createRef } from "react";
import type { LegendListRef } from "@legendapp/list/react";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const scrollToEndSpy = vi.fn();
const getStateSpy = vi.fn(() => ({ isAtEnd: true }));

vi.mock("@legendapp/list/react", async () => {
  const React = await import("react");

  const LegendList = React.forwardRef(function MockLegendList(
    props: {
      data: Array<{ id: string }>;
      keyExtractor: (item: { id: string }) => string;
      renderItem: (args: { item: { id: string } }) => React.ReactNode;
      ListHeaderComponent?: React.ReactNode;
      ListFooterComponent?: React.ReactNode;
    },
    ref: React.ForwardedRef<LegendListRef>,
  ) {
    React.useImperativeHandle(
      ref,
      () =>
        ({
          scrollToEnd: scrollToEndSpy,
          getState: getStateSpy,
        }) as unknown as LegendListRef,
    );

    return (
      <div data-testid="legend-list">
        {props.ListHeaderComponent}
        {props.data.map((item) => (
          <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
        ))}
        {props.ListFooterComponent}
      </div>
    );
  });

  return { LegendList };
});

import { MessagesTimeline } from "./MessagesTimeline";

function buildProps() {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    activeTurnId: null,
    activeTurnStartedAt: null,
    listRef: createRef<LegendListRef | null>(),
    completionDividerBeforeEntryId: null,
    completionSummary: null,
    turnDiffSummaryByAssistantMessageId: new Map(),
    routeThreadKey: "environment-local:thread-1",
    onOpenTurnDiff: vi.fn(),
    revertTurnCountByUserMessageId: new Map(),
    onRevertUserMessage: vi.fn(),
    isRevertingCheckpoint: false,
    onImageExpand: vi.fn(),
    activeThreadEnvironmentId: EnvironmentId.make("environment-local"),
    markdownCwd: undefined,
    resolvedTheme: "dark" as const,
    timestampFormat: "24-hour" as const,
    workspaceRoot: undefined,
    scopedHostName: null,
    workflow: null,
    onStartWorkflow: undefined,
    onIsAtEndChange: vi.fn(),
  };
}

describe("MessagesTimeline", () => {
  afterEach(() => {
    scrollToEndSpy.mockReset();
    getStateSpy.mockClear();
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("renders activity rows instead of the empty placeholder when a thread has non-message timeline data", async () => {
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        timelineEntries={[
          {
            id: "work-1",
            kind: "work",
            createdAt: "2026-04-13T12:00:00.000Z",
            entry: {
              id: "work-1",
              createdAt: "2026-04-13T12:00:00.000Z",
              label: "thinking",
              detail: "Inspecting repository state",
              tone: "thinking",
            },
          },
        ]}
      />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("snaps to the bottom when timeline rows appear after an initially empty render", async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => {
        callback(0);
        return 1;
      });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);

    const props = buildProps();
    const screen = await render(<MessagesTimeline {...props} timelineEntries={[]} />);

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();

      await screen.rerender(
        <MessagesTimeline
          {...props}
          timelineEntries={[
            {
              id: "work-1",
              kind: "work",
              createdAt: "2026-04-13T12:00:00.000Z",
              entry: {
                id: "work-1",
                createdAt: "2026-04-13T12:00:00.000Z",
                label: "thinking",
                detail: "Inspecting repository state",
                tone: "thinking",
              },
            },
          ]}
        />,
      );

      await expect.element(page.getByText("Thinking - Inspecting repository state")).toBeVisible();
      expect(props.onIsAtEndChange).toHaveBeenCalledWith(true);
      expect(scrollToEndSpy).toHaveBeenCalledWith({ animated: false });
      expect(requestAnimationFrameSpy).toHaveBeenCalled();
    } finally {
      await screen.unmount();
    }
  });

  it("shows a scoped-host hint for empty scoped threads", async () => {
    const screen = await render(
      <MessagesTimeline {...buildProps()} scopedHostName="teletype" timelineEntries={[]} />,
    );

    try {
      await expect
        .element(page.getByText("Send a message to start the conversation."))
        .toBeVisible();
      await expect.element(page.getByText("Host: teletype")).toBeVisible();
      await expect
        .element(page.getByText("Changes default to this host unless you broaden scope."))
        .toBeVisible();
    } finally {
      await screen.unmount();
    }
  });

  it("shows the guided host-creation CTA for empty workflow threads", async () => {
    const onStartWorkflow = vi.fn();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        workflow={{
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          status: "planning",
        }}
        scopedHostName="nexus"
        onStartWorkflow={onStartWorkflow}
        timelineEntries={[]}
      />,
    );

    try {
      await expect.element(page.getByText("Create host")).toBeVisible();
      await expect.element(page.getByText("Begin guided setup")).toBeVisible();
      await page.getByRole("button", { name: "Begin guided setup" }).click();
      expect(onStartWorkflow).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("shows the SSH-import host-creation CTA for empty workflow threads", async () => {
    const onStartWorkflow = vi.fn();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        workflow={{
          kind: "host-creation",
          hostName: "nexus",
          target: "nexus",
          osFamily: "nixos",
          bootstrapMode: "existing-via-ssh",
          sourceSshTarget: "root@nexus.example",
          status: "planning",
        }}
        scopedHostName="nexus"
        onStartWorkflow={onStartWorkflow}
        timelineEntries={[]}
      />,
    );

    try {
      await expect.element(page.getByText("Create host")).toBeVisible();
      await expect.element(page.getByText("Begin SSH analysis")).toBeVisible();
      await expect
        .element(page.getByText(/fall back to a secure password prompt when needed/i))
        .toBeVisible();
      await page.getByRole("button", { name: "Begin SSH analysis" }).click();
      expect(onStartWorkflow).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });

  it("shows the guided host-removal CTA for empty workflow threads", async () => {
    const onStartWorkflow = vi.fn();
    const screen = await render(
      <MessagesTimeline
        {...buildProps()}
        workflow={{
          kind: "host-removal",
          hostName: "nexus",
          target: "root@nexus",
          hostType: "server",
          status: "planning",
        }}
        scopedHostName="nexus"
        onStartWorkflow={onStartWorkflow}
        timelineEntries={[]}
      />,
    );

    try {
      await expect.element(page.getByText("Remove host")).toBeVisible();
      await expect.element(page.getByText("Begin removal plan")).toBeVisible();
      await page.getByRole("button", { name: "Begin removal plan" }).click();
      expect(onStartWorkflow).toHaveBeenCalledTimes(1);
    } finally {
      await screen.unmount();
    }
  });
});
