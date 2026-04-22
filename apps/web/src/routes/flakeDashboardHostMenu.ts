import type { FlakeHost, HostDocumentationStatus } from "@t3tools/contracts";

export type FlakeDashboardHostMenuAction =
  | "start-thread"
  | "open-deploy-page"
  | "generate-doc"
  | "remove-host";

export type FlakeDashboardHostMenuEntry =
  | {
      action: FlakeDashboardHostMenuAction;
      destructive?: boolean;
      disabled?: boolean;
      label: string;
      kind: "action";
    }
  | {
      id: string;
      kind: "separator";
    };

export function buildFlakeDashboardHostMenu(input: {
  documentationStatus: HostDocumentationStatus;
  generating: boolean;
}): readonly FlakeDashboardHostMenuEntry[] {
  return [
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
      disabled: input.generating,
      kind: "action",
      label: input.documentationStatus === "missing" ? "Generate doc" : "Refresh doc",
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
  ];
}

export function runFlakeDashboardHostMenuAction(input: {
  action: FlakeDashboardHostMenuAction;
  host: FlakeHost;
  onGenerateDoc: (host: FlakeHost) => Promise<void> | void;
  onOpenDeployPage: (hostName: string) => Promise<void> | void;
  onRemoveHost: (host: FlakeHost) => Promise<void> | void;
  onStartThread: (host: FlakeHost) => Promise<void> | void;
}): Promise<void> | void {
  switch (input.action) {
    case "start-thread":
      return input.onStartThread(input.host);
    case "open-deploy-page":
      return input.onOpenDeployPage(input.host.name);
    case "generate-doc":
      return input.onGenerateDoc(input.host);
    case "remove-host":
      return input.onRemoveHost(input.host);
  }
}
