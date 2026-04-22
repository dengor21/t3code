import type { FlakeHost } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  buildFlakeDashboardHostMenu,
  runFlakeDashboardHostMenuAction,
} from "./flakeDashboardHostMenu";

const HOST: FlakeHost = {
  name: "nexus",
  target: "root@nexus",
  type: "server",
  system: "x86_64-linux",
};

describe("buildFlakeDashboardHostMenu", () => {
  it("includes a deploy-page action in the host sidebar menu", () => {
    expect(
      buildFlakeDashboardHostMenu({
        documentationStatus: "current",
        generating: false,
      }),
    ).toEqual([
      {
        action: "start-thread",
        kind: "action",
        label: "Start thread",
      },
      {
        action: "open-deploy-page",
        kind: "action",
        label: "Open deploy page",
      },
      {
        action: "generate-doc",
        disabled: false,
        kind: "action",
        label: "Refresh doc",
      },
      {
        id: "host-actions-divider",
        kind: "separator",
      },
      {
        action: "remove-host",
        destructive: true,
        kind: "action",
        label: "Remove host",
      },
    ]);
  });
});

describe("runFlakeDashboardHostMenuAction", () => {
  it("routes the deploy-page action to the selected host name", () => {
    const onOpenDeployPage = vi.fn();

    runFlakeDashboardHostMenuAction({
      action: "open-deploy-page",
      host: HOST,
      onGenerateDoc: vi.fn(),
      onOpenDeployPage,
      onRemoveHost: vi.fn(),
      onStartThread: vi.fn(),
    });

    expect(onOpenDeployPage).toHaveBeenCalledWith("nexus");
    expect(onOpenDeployPage).toHaveBeenCalledTimes(1);
  });
});
