import {
  buildDeployRsCommand,
  type FlakeHost,
  type FlakeMaintenanceStatus,
  type GitStatusResult,
  type HostDeploymentStatus,
  type HostDocumentationStatus,
  type ProjectDashboardChangeEntry,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  BookOpenIcon,
  EllipsisIcon,
  FileTextIcon,
  InboxIcon,
  LoaderIcon,
  PlayIcon,
  RefreshCcwIcon,
  RocketIcon,
  SquareTerminalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
import FlakeMaintenanceTerminal from "../components/FlakeMaintenanceTerminal";
import GitActionsControl from "../components/GitActionsControl";
import HostDeploymentTerminal from "../components/HostDeploymentTerminal";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { refreshGitStatus, useGitStatus } from "../lib/gitStatusState";
import {
  flakeMaintenanceQueryOptions,
  hostDeploymentQueryOptions,
  projectDashboardContentQueryOptions,
  projectQueryKeys,
} from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { selectEnvironmentState, useStore } from "../store";
import { createProjectSelectorByRef } from "../storeSelectors";
import { buildFlakeRouteParams, resolveFlakeRouteRef } from "../threadRoutes";

export interface FlakeDashboardSearch {
  host?: string;
  view?: "changes" | "deploy" | "doc" | "flake" | "maintenance";
}

function parseFlakeDashboardSearch(search: Record<string, unknown>): FlakeDashboardSearch {
  const host = typeof search.host === "string" ? search.host.trim() : "";
  const view = search.view;
  const next: FlakeDashboardSearch = {};
  if (host.length > 0) {
    next.host = host;
  }
  if (
    view === "changes" ||
    view === "deploy" ||
    view === "doc" ||
    view === "flake" ||
    view === "maintenance"
  ) {
    next.view = view;
  }
  return next;
}

type FlakeDashboardView = "changes" | "deploy" | "doc" | "flake" | "maintenance";

function buildDashboardSearch(input: {
  hostName: string | null;
  view: FlakeDashboardView;
}): FlakeDashboardSearch {
  if (input.hostName) {
    if (input.view === "doc") {
      return { host: input.hostName, view: "doc" };
    }
    if (input.view === "deploy") {
      return { host: input.hostName, view: "deploy" };
    }
    return { host: input.hostName };
  }

  if (input.view === "flake") {
    return { view: "flake" };
  }
  if (input.view === "maintenance") {
    return { view: "maintenance" };
  }
  return {};
}

function formatDocumentationStatusLabel(
  status: HostDocumentationStatus | null | undefined,
): string {
  switch (status) {
    case "current":
      return "Current";
    case "stale":
      return "Stale";
    case "needs-review":
      return "Needs review";
    case "missing":
    default:
      return "Missing";
  }
}

function documentationStatusClasses(status: HostDocumentationStatus | null | undefined): string {
  switch (status) {
    case "current":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "stale":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "needs-review":
      return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
    case "missing":
    default:
      return "border-border/70 bg-background/70 text-muted-foreground";
  }
}

function deploymentReasonLabel(
  reason: "missing-deploy-target" | "evaluation-failed" | null | undefined,
): string | null {
  switch (reason) {
    case "missing-deploy-target":
      return "No deploy-rs target configured";
    case "evaluation-failed":
      return "Could not evaluate deploy-rs targets";
    default:
      return null;
  }
}

function formatDeploymentStatusLabel(
  status: HostDeploymentStatus | FlakeMaintenanceStatus,
): string {
  switch (status) {
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "succeeded":
      return "Succeeded";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "error":
    default:
      return "Error";
  }
}

function deploymentStatusClasses(status: HostDeploymentStatus | FlakeMaintenanceStatus): string {
  switch (status) {
    case "starting":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "succeeded":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "canceled":
      return "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
    case "error":
    default:
      return "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  }
}

function formatDeploymentModeLabel(deployOnServer: boolean): string {
  return deployOnServer ? "Deploy On Server" : "Remote Build";
}

function formatGitBranchLabel(gitStatus: GitStatusResult | null | undefined): string {
  if (!gitStatus) {
    return "Checking git status";
  }
  if (!gitStatus.isRepo) {
    return "Not a git repository";
  }
  return gitStatus.branch ?? "Detached HEAD";
}

function maintenanceDisabledReason(gitStatus: GitStatusResult | null | undefined): string | null {
  if (!gitStatus) {
    return "Checking git status for this flake.";
  }
  if (!gitStatus.isRepo) {
    return "Maintenance requires a git repository so updates can be reviewed before commit.";
  }
  if (gitStatus.hasWorkingTreeChanges) {
    return "Commit, stash, or discard local changes before running nix flake update.";
  }
  return null;
}

function kindLabel(kind: ProjectDashboardChangeEntry["kind"]): string {
  return kind === "bootstrap" ? "Bootstrap" : "Change";
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function renderFlakeSourceMarkdown(contents: string): string {
  return `\`\`\`nix\n${contents}\n\`\`\``;
}

function EmptyPanel(props: {
  title: string;
  description: string;
  icon?: React.ReactNode;
  actionLabel?: string;
  onAction?: () => void;
  pending?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border/60 bg-background/30 px-5 py-8">
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="rounded-xl bg-muted/50 p-2.5 text-muted-foreground/60">
          {props.icon ?? <InboxIcon className="size-5" />}
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">{props.description}</p>
        </div>
        {props.actionLabel && props.onAction ? (
          <div className="mt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={props.onAction}
              disabled={props.pending}
              className="gap-2"
            >
              {props.pending ? <RefreshCcwIcon className="size-3.5 animate-spin" /> : null}
              {props.actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChangeEntryCard(props: { entry: ProjectDashboardChangeEntry; cwd: string }) {
  const { entry, cwd } = props;
  return (
    <article className="rounded-2xl border border-border/60 bg-background/55 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
            {kindLabel(entry.kind)}
          </span>
          {entry.ambiguous ? (
            <span className="rounded-full border border-orange-500/30 bg-orange-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-orange-700 dark:text-orange-300">
              Needs review
            </span>
          ) : null}
          {entry.hosts.map((host) => (
            <span
              key={`${entry.id}:${host}`}
              className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground"
            >
              {host}
            </span>
          ))}
        </div>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground/60">
          {formatTimestamp(entry.completedAt)}
        </span>
      </div>
      <h3 className="mt-2.5 text-[15px] font-semibold leading-snug text-foreground">
        {entry.title}
      </h3>
      {entry.markdown.trim().length > 0 ? (
        <div className="mt-3 rounded-xl bg-card/40 p-3">
          <ChatMarkdown text={entry.markdown} cwd={cwd} />
        </div>
      ) : null}
      {entry.files.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground/70">Files:</span>
          {entry.files.map((file) => (
            <code
              key={`${entry.id}:${file}`}
              className="rounded-md bg-muted/80 px-1.5 py-0.5 font-mono text-[11px] text-foreground/80"
            >
              {file}
            </code>
          ))}
        </div>
      ) : null}
    </article>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/flake/$projectId")({
  component: FlakeDashboardRouteView,
  validateSearch: parseFlakeDashboardSearch,
});

function FlakeDashboardRouteView() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const projectRef = Route.useParams({
    select: (params) => resolveFlakeRouteRef(params),
  });
  const search = Route.useSearch();
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, projectRef?.environmentId ?? null).bootstrapComplete,
  );
  const environmentHasProjects = useStore(
    (store) =>
      selectEnvironmentState(store, projectRef?.environmentId ?? null).projectIds.length > 0,
  );
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const { handleNewThread } = useNewThreadHandler();
  const [generatingDocsByHost, setGeneratingDocsByHost] = useState<Record<string, true>>({});
  const [deployDialogHostName, setDeployDialogHostName] = useState<string | null>(null);
  const [deployingHostName, setDeployingHostName] = useState<string | null>(null);
  const [maintenancePending, setMaintenancePending] = useState(false);
  const [deployOnServer, setDeployOnServer] = useState(false);
  const gitStatusQuery = useGitStatus({
    environmentId: projectRef?.environmentId ?? null,
    cwd: project?.cwd ?? null,
  });

  useEffect(() => {
    if (!projectRef || !bootstrapComplete) {
      return;
    }
    if (!project && environmentHasProjects) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasProjects, navigate, project, projectRef]);

  const routeHostsByName = useMemo(() => {
    const flakeMetadata = project?.flakeMetadata ?? null;
    const hosts = flakeMetadata?.hosts ?? (flakeMetadata?.host ? [flakeMetadata.host] : []);
    return new Map(hosts.map((host) => [host.name.trim().toLowerCase(), host.name] as const));
  }, [project?.flakeMetadata]);
  const requestedHostName = search.host?.trim() ? search.host.trim() : null;
  const matchedRouteHostName =
    requestedHostName === null
      ? null
      : (routeHostsByName.get(requestedHostName.toLowerCase()) ?? null);

  useEffect(() => {
    if (!projectRef || !requestedHostName || routeHostsByName.size === 0 || matchedRouteHostName) {
      return;
    }
    void navigate({
      to: "/$environmentId/flake/$projectId",
      params: buildFlakeRouteParams(projectRef),
      search: {},
      replace: true,
    });
  }, [matchedRouteHostName, navigate, projectRef, requestedHostName, routeHostsByName]);

  useEffect(() => {
    if (!projectRef || search.view !== "deploy" || requestedHostName !== null) {
      return;
    }
    void navigate({
      to: "/$environmentId/flake/$projectId",
      params: buildFlakeRouteParams(projectRef),
      search: {},
      replace: true,
    });
  }, [navigate, projectRef, requestedHostName, search.view]);

  useEffect(() => {
    if (!projectRef || search.view !== "maintenance" || requestedHostName === null) {
      return;
    }
    void navigate({
      to: "/$environmentId/flake/$projectId",
      params: buildFlakeRouteParams(projectRef),
      search: { view: "maintenance" },
      replace: true,
    });
  }, [navigate, projectRef, requestedHostName, search.view]);

  const dashboardQuery = useQuery(
    projectDashboardContentQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      hostName: matchedRouteHostName ?? requestedHostName,
      enabled: bootstrapComplete && projectRef !== null && project !== null,
    }),
  );

  const hostDeploymentQuery = useQuery(
    hostDeploymentQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      hostName: matchedRouteHostName ?? requestedHostName,
      enabled:
        bootstrapComplete &&
        projectRef !== null &&
        project !== null &&
        (matchedRouteHostName ?? requestedHostName) !== null,
    }),
  );

  const flakeMaintenanceQuery = useQuery(
    flakeMaintenanceQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      enabled:
        bootstrapComplete &&
        projectRef !== null &&
        project !== null &&
        search.view === "maintenance",
    }),
  );

  useEffect(() => {
    if (
      !projectRef ||
      !requestedHostName ||
      !dashboardQuery.isError ||
      !(dashboardQuery.error instanceof Error) ||
      !dashboardQuery.error.message.includes("was not found in the selected flake")
    ) {
      return;
    }
    void navigate({
      to: "/$environmentId/flake/$projectId",
      params: buildFlakeRouteParams(projectRef),
      search: {},
      replace: true,
    });
  }, [dashboardQuery.error, dashboardQuery.isError, navigate, projectRef, requestedHostName]);

  const selectDashboardView = useCallback(
    (hostName: string | null, view: FlakeDashboardView) => {
      if (!projectRef) {
        return;
      }
      void navigate({
        to: "/$environmentId/flake/$projectId",
        params: buildFlakeRouteParams(projectRef),
        search: buildDashboardSearch({
          hostName,
          view,
        }),
      });
    },
    [navigate, projectRef],
  );

  const handleStartThread = useCallback(() => {
    if (!projectRef) {
      return;
    }
    void handleNewThread(projectRef, {
      scopedHostName: null,
    });
  }, [handleNewThread, projectRef]);

  const handleStartHostThread = useCallback(
    (host: FlakeHost) => {
      if (!projectRef) {
        return;
      }
      void handleNewThread(projectRef, {
        scopedHostName: host.name,
      });
    },
    [handleNewThread, projectRef],
  );

  const invalidateDashboardQueries = useCallback(() => {
    if (!projectRef || !project) {
      return Promise.resolve();
    }
    return queryClient.invalidateQueries({
      queryKey: projectQueryKeys.dashboardContentPrefix(projectRef.environmentId, project.id),
    });
  }, [project, projectRef, queryClient]);

  const invalidateHostDeploymentQueries = useCallback(() => {
    if (!projectRef || !project) {
      return Promise.resolve();
    }
    return queryClient.invalidateQueries({
      queryKey: projectQueryKeys.hostDeploymentPrefix(projectRef.environmentId, project.id),
    });
  }, [project, projectRef, queryClient]);

  const invalidateFlakeMaintenanceQueries = useCallback(() => {
    if (!projectRef || !project) {
      return Promise.resolve();
    }
    return queryClient.invalidateQueries({
      queryKey: projectQueryKeys.flakeMaintenancePrefix(projectRef.environmentId, project.id),
    });
  }, [project, projectRef, queryClient]);

  const handleGenerateHostDoc = useCallback(
    async (host: FlakeHost) => {
      if (!projectRef || !project || generatingDocsByHost[host.name]) {
        return;
      }

      const api = readEnvironmentApi(projectRef.environmentId);
      if (!api) {
        toastManager.add({
          type: "error",
          title: "Flake actions are unavailable",
        });
        return;
      }

      setGeneratingDocsByHost((current) => ({
        ...current,
        [host.name]: true,
      }));
      try {
        const result = await api.projects.generateHostDocumentation({
          projectId: project.id,
          hostName: host.name,
        });
        await invalidateDashboardQueries();
        toastManager.add({
          type: "success",
          title: `Documentation generated for ${host.name}`,
          description: `Updated ${result.docPath}`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to generate ${host.name} documentation`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      } finally {
        setGeneratingDocsByHost((current) => {
          const next = { ...current };
          delete next[host.name];
          return next;
        });
      }
    },
    [generatingDocsByHost, invalidateDashboardQueries, project, projectRef],
  );

  const handleOpenDeployDialog = useCallback((hostName: string) => {
    setDeployOnServer(false);
    setDeployDialogHostName(hostName);
  }, []);

  const handleCloseDeployDialog = useCallback(() => {
    if (deployingHostName !== null) {
      return;
    }
    setDeployOnServer(false);
    setDeployDialogHostName(null);
  }, [deployingHostName]);

  const handleConfirmDeployment = useCallback(async () => {
    if (!projectRef || !project || !deployDialogHostName) {
      return;
    }

    const hostSummary =
      dashboardQuery.data?.hostSummaries.find(
        (summary) => summary.host.name === deployDialogHostName,
      ) ?? null;
    if (
      !hostSummary ||
      hostSummary.deployment.status !== "deployable" ||
      !hostSummary.deployment.command
    ) {
      toastManager.add({
        type: "error",
        title: "Deployment is unavailable",
        description:
          deploymentReasonLabel(hostSummary?.deployment.reason) ??
          "This host does not have a deploy-rs target.",
      });
      return;
    }

    const api = readEnvironmentApi(projectRef.environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Flake actions are unavailable",
      });
      return;
    }

    setDeployingHostName(hostSummary.host.name);
    try {
      await api.hostDeployments.start({
        projectId: project.id,
        hostName: hostSummary.host.name,
        deployOnServer,
      });

      await Promise.all([invalidateHostDeploymentQueries(), invalidateDashboardQueries()]);
      setDeployDialogHostName(null);
      setDeployingHostName(null);
      setDeployOnServer(false);

      await navigate({
        to: "/$environmentId/flake/$projectId",
        params: buildFlakeRouteParams(projectRef),
        search: buildDashboardSearch({
          hostName: hostSummary.host.name,
          view: "deploy",
        }),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to start deployment for ${hostSummary.host.name}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      setDeployingHostName(null);
    }
  }, [
    dashboardQuery.data?.hostSummaries,
    deployDialogHostName,
    deployOnServer,
    invalidateDashboardQueries,
    invalidateHostDeploymentQueries,
    navigate,
    project,
    projectRef,
  ]);

  const selectedHostSummary = useMemo(() => {
    const hostName = dashboardQuery.data?.selectedHostName;
    if (!hostName) {
      return null;
    }
    return (
      dashboardQuery.data?.hostSummaries.find((summary) => summary.host.name === hostName) ?? null
    );
  }, [dashboardQuery.data]);
  const deployDialogHostSummary = useMemo(() => {
    if (!deployDialogHostName) {
      return null;
    }
    return (
      dashboardQuery.data?.hostSummaries.find(
        (summary) => summary.host.name === deployDialogHostName,
      ) ?? null
    );
  }, [dashboardQuery.data, deployDialogHostName]);

  const flakeSourceMarkdown = useMemo(
    () => renderFlakeSourceMarkdown(dashboardQuery.data?.flakeSource.contents ?? ""),
    [dashboardQuery.data?.flakeSource.contents],
  );
  const activeView: FlakeDashboardView = useMemo(() => {
    if (selectedHostSummary) {
      if (search.view === "doc") {
        return "doc";
      }
      if (search.view === "deploy") {
        return "deploy";
      }
      return "changes";
    }
    if (search.view === "flake") {
      return "flake";
    }
    if (search.view === "maintenance") {
      return "maintenance";
    }
    return "changes";
  }, [search.view, selectedHostSummary]);
  const visibleChangeEntries = selectedHostSummary
    ? (dashboardQuery.data?.hostChanges ?? [])
    : (dashboardQuery.data?.generalChanges ?? []);
  const deployDialogCommand =
    deployDialogHostSummary?.deployment.status === "deployable"
      ? buildDeployRsCommand(deployDialogHostSummary.host.name, { deployOnServer })
      : null;
  const deployDialogDisabledReason = deploymentReasonLabel(
    deployDialogHostSummary?.deployment.reason ?? null,
  );
  const selectedHostDeployment = selectedHostSummary
    ? (hostDeploymentQuery.data ?? selectedHostSummary.latestDeployment ?? null)
    : null;
  const isSelectedHostDeploymentActive =
    selectedHostDeployment?.status === "starting" || selectedHostDeployment?.status === "running";
  const selectedFlakeMaintenance =
    flakeMaintenanceQuery.data ?? dashboardQuery.data?.latestMaintenance ?? null;
  const isSelectedFlakeMaintenanceActive =
    selectedFlakeMaintenance?.status === "starting" ||
    selectedFlakeMaintenance?.status === "running";
  const maintenanceActionDisabledReason = maintenanceDisabledReason(gitStatusQuery.data);

  const handleStopDeployment = useCallback(async () => {
    if (!projectRef || !project || !selectedHostSummary) {
      return;
    }
    const api = readEnvironmentApi(projectRef.environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Flake actions are unavailable",
      });
      return;
    }
    try {
      await api.hostDeployments.stop({
        projectId: project.id,
        hostName: selectedHostSummary.host.name,
      });
      await Promise.all([invalidateHostDeploymentQueries(), invalidateDashboardQueries()]);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to stop deployment for ${selectedHostSummary.host.name}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, [
    invalidateDashboardQueries,
    invalidateHostDeploymentQueries,
    project,
    projectRef,
    selectedHostSummary,
  ]);

  const refreshFlakeGitStatus = useCallback(() => {
    if (!projectRef || !project) {
      return Promise.resolve(null);
    }
    return refreshGitStatus({
      environmentId: projectRef.environmentId,
      cwd: project.cwd,
    });
  }, [project, projectRef]);

  const handleStartMaintenance = useCallback(async () => {
    if (!projectRef || !project || maintenancePending) {
      return;
    }

    const api = readEnvironmentApi(projectRef.environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Flake actions are unavailable",
      });
      return;
    }

    setMaintenancePending(true);
    try {
      await api.flakeMaintenance.start({
        projectId: project.id,
      });
      await Promise.all([
        invalidateFlakeMaintenanceQueries(),
        invalidateDashboardQueries(),
        refreshFlakeGitStatus(),
      ]);
      await navigate({
        to: "/$environmentId/flake/$projectId",
        params: buildFlakeRouteParams(projectRef),
        search: { view: "maintenance" },
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to start flake maintenance",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setMaintenancePending(false);
    }
  }, [
    invalidateDashboardQueries,
    invalidateFlakeMaintenanceQueries,
    maintenancePending,
    navigate,
    project,
    projectRef,
    refreshFlakeGitStatus,
  ]);

  const handleStopMaintenance = useCallback(async () => {
    if (!projectRef || !project) {
      return;
    }
    const api = readEnvironmentApi(projectRef.environmentId);
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Flake actions are unavailable",
      });
      return;
    }
    try {
      await api.flakeMaintenance.stop({
        projectId: project.id,
      });
      await Promise.all([
        invalidateFlakeMaintenanceQueries(),
        invalidateDashboardQueries(),
        refreshFlakeGitStatus(),
      ]);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to stop flake maintenance",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, [
    invalidateDashboardQueries,
    invalidateFlakeMaintenanceQueries,
    project,
    projectRef,
    refreshFlakeGitStatus,
  ]);

  if (!projectRef || !bootstrapComplete || !project) {
    return null;
  }

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
            Flake dashboard
          </span>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8">
            <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
              <aside className="flex min-w-0 flex-col gap-4">
                <section className="rounded-2xl border border-border/60 bg-card/60 p-5">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h1 className="text-xl font-semibold tracking-tight text-foreground">
                        {project.name}
                      </h1>
                      <p className="mt-0.5 break-all text-xs text-muted-foreground/70">
                        {project.cwd}
                      </p>
                    </div>
                  </div>
                  <div className="mt-4 flex flex-wrap items-center gap-2">
                    <Button size="sm" onClick={handleStartThread}>
                      <PlayIcon className="size-3.5" />
                      Start thread
                    </Button>
                    <Button
                      size="sm"
                      variant={
                        selectedHostSummary === null && activeView === "changes"
                          ? "secondary"
                          : "ghost"
                      }
                      onClick={() => selectDashboardView(null, "changes")}
                    >
                      Changes
                    </Button>
                    <Button
                      size="sm"
                      variant={
                        selectedHostSummary === null && activeView === "flake"
                          ? "secondary"
                          : "ghost"
                      }
                      onClick={() => selectDashboardView(null, "flake")}
                    >
                      <FileTextIcon className="size-3.5" />
                      flake.nix
                    </Button>
                    <Button
                      size="sm"
                      variant={
                        selectedHostSummary === null && activeView === "maintenance"
                          ? "secondary"
                          : "ghost"
                      }
                      onClick={() => selectDashboardView(null, "maintenance")}
                    >
                      <RefreshCcwIcon className="size-3.5" />
                      Maintenance
                    </Button>
                  </div>
                </section>

                <section className="rounded-2xl border border-border/60 bg-card/50 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70">
                      Hosts
                    </h2>
                  </div>

                  <div className="grid gap-2">
                    {dashboardQuery.isPending && !dashboardQuery.data ? (
                      <EmptyPanel
                        title="Loading hosts"
                        description="Resolving flake host configuration..."
                        icon={<LoaderIcon className="size-5 animate-spin" />}
                      />
                    ) : dashboardQuery.data && dashboardQuery.data.hostSummaries.length > 0 ? (
                      dashboardQuery.data.hostSummaries.map((summary) => {
                        const isSelected =
                          dashboardQuery.data?.selectedHostName === summary.host.name;
                        const generating = generatingDocsByHost[summary.host.name] === true;
                        const deploying = deployingHostName === summary.host.name;
                        const hostChangesSelected = isSelected && activeView === "changes";
                        const hostDocSelected = isSelected && activeView === "doc";
                        const hostDeploySelected = isSelected && activeView === "deploy";
                        const deployDisabledReason = deploymentReasonLabel(
                          summary.deployment.reason,
                        );
                        return (
                          <div
                            key={`${summary.host.name}:${summary.host.target}`}
                            role="button"
                            tabIndex={0}
                            onClick={() => selectDashboardView(summary.host.name, "changes")}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                selectDashboardView(summary.host.name, "changes");
                              }
                            }}
                            className={cn(
                              "group rounded-xl border p-3 text-left transition-all",
                              isSelected
                                ? "border-primary/40 bg-primary/6 shadow-sm"
                                : "border-border/50 bg-background/40 hover:border-border hover:bg-background/70",
                            )}
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex min-w-0 items-center gap-2">
                                <span className="text-sm font-semibold text-foreground">
                                  {summary.host.name}
                                </span>
                                <span className="truncate text-xs text-muted-foreground/60">
                                  {summary.host.target}
                                </span>
                              </div>
                              <div className="flex shrink-0 items-center gap-1.5">
                                {summary.latestDeployment ? (
                                  <span
                                    className={cn(
                                      "rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-[0.12em]",
                                      deploymentStatusClasses(summary.latestDeployment.status),
                                    )}
                                  >
                                    {formatDeploymentStatusLabel(summary.latestDeployment.status)}
                                  </span>
                                ) : null}
                                <span
                                  className={cn(
                                    "rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-[0.12em]",
                                    documentationStatusClasses(summary.documentation.status),
                                  )}
                                >
                                  {formatDocumentationStatusLabel(summary.documentation.status)}
                                </span>
                              </div>
                            </div>

                            <div className="mt-2 flex items-center gap-1.5">
                              {summary.host.type ? (
                                <span className="rounded-md border border-border/50 bg-muted/40 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
                                  {summary.host.type}
                                </span>
                              ) : null}
                              {summary.host.system ? (
                                <span className="rounded-md border border-border/50 bg-muted/40 px-1.5 py-px text-[10px] font-medium uppercase tracking-wider text-muted-foreground/80">
                                  {summary.host.system}
                                </span>
                              ) : null}
                            </div>

                            <div className="mt-3 flex items-center gap-1.5">
                              <Button
                                size="xs"
                                variant={hostChangesSelected ? "secondary" : "ghost"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectDashboardView(summary.host.name, "changes");
                                }}
                              >
                                Changes
                              </Button>
                              <Button
                                size="xs"
                                variant={hostDocSelected ? "secondary" : "ghost"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectDashboardView(summary.host.name, "doc");
                                }}
                              >
                                <BookOpenIcon className="size-3" />
                                Doc
                              </Button>
                              <Button
                                size="xs"
                                variant={hostDeploySelected ? "secondary" : "ghost"}
                                disabled={summary.deployment.status !== "deployable" || deploying}
                                title={deployDisabledReason ?? undefined}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleOpenDeployDialog(summary.host.name);
                                }}
                              >
                                {deploying ? (
                                  <RefreshCcwIcon className="size-3 animate-spin" />
                                ) : (
                                  <RocketIcon className="size-3" />
                                )}
                                Deploy
                              </Button>

                              <div className="ml-auto">
                                <Menu>
                                  <MenuTrigger
                                    className={cn(
                                      "inline-flex size-6 items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground sm:size-5",
                                      isSelected
                                        ? "text-muted-foreground"
                                        : "opacity-0 group-hover:opacity-100",
                                    )}
                                    onClick={(event) => event.stopPropagation()}
                                  >
                                    <EllipsisIcon className="size-4 sm:size-3.5" />
                                  </MenuTrigger>
                                  <MenuPopup align="end" sideOffset={4}>
                                    <MenuItem
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleStartHostThread(summary.host);
                                      }}
                                    >
                                      <PlayIcon />
                                      Start thread
                                    </MenuItem>
                                    <MenuItem
                                      disabled={generating}
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        void handleGenerateHostDoc(summary.host);
                                      }}
                                    >
                                      {generating ? (
                                        <RefreshCcwIcon className="animate-spin" />
                                      ) : (
                                        <BookOpenIcon />
                                      )}
                                      {summary.documentation.status === "missing"
                                        ? "Generate doc"
                                        : "Refresh doc"}
                                    </MenuItem>
                                  </MenuPopup>
                                </Menu>
                              </div>
                            </div>
                            {summary.deployment.status !== "deployable" && deployDisabledReason ? (
                              <p className="mt-2 text-[11px] text-muted-foreground/60">
                                {deployDisabledReason}
                              </p>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <EmptyPanel
                        title="No hosts resolved"
                        description="No hosts were resolved for this flake yet."
                      />
                    )}
                  </div>
                </section>
              </aside>

              <main className="min-w-0">
                {dashboardQuery.isError && !dashboardQuery.data ? (
                  <section className="rounded-2xl border border-destructive/30 bg-destructive/5 p-5">
                    <div className="flex items-start gap-3">
                      <AlertCircleIcon className="mt-0.5 size-5 text-destructive" />
                      <div>
                        <h2 className="text-base font-semibold text-foreground">
                          Unable to load flake dashboard
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {dashboardQuery.error instanceof Error
                            ? dashboardQuery.error.message
                            : "An unexpected error occurred."}
                        </p>
                      </div>
                    </div>
                  </section>
                ) : (
                  <section className="rounded-2xl border border-border/60 bg-card/50 p-5">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <h2 className="text-lg font-semibold text-foreground">
                          {activeView === "doc"
                            ? `Documentation for ${selectedHostSummary?.host.name ?? "host"}`
                            : activeView === "deploy"
                              ? `Deployment for ${selectedHostSummary?.host.name ?? "host"}`
                              : activeView === "maintenance"
                                ? "Flake maintenance"
                                : activeView === "flake"
                                  ? "flake.nix"
                                  : selectedHostSummary
                                    ? `Recent changes for ${selectedHostSummary.host.name}`
                                    : "Recent changes"}
                        </h2>
                        <p className="mt-0.5 text-sm text-muted-foreground">
                          {activeView === "doc"
                            ? selectedHostSummary?.documentation.generatedAt
                              ? `Generated ${formatTimestamp(selectedHostSummary.documentation.generatedAt)}`
                              : "Manual host documentation is missing or needs to be generated."
                            : activeView === "deploy"
                              ? selectedHostDeployment
                                ? `${formatDeploymentStatusLabel(selectedHostDeployment.status)} deployment output for ${selectedHostDeployment.hostName}.`
                                : "Start or foreground a deployment for this host to inspect the latest terminal output here."
                              : activeView === "maintenance"
                                ? selectedFlakeMaintenance
                                  ? `${formatDeploymentStatusLabel(selectedFlakeMaintenance.status)} nix flake update run with git review for this flake.`
                                  : "Run nix flake update and review the resulting dependency changes from this page."
                                : activeView === "flake"
                                  ? "Read-only source preview for the selected flake."
                                  : selectedHostSummary
                                    ? "Shows the latest host-specific and ambiguous changes that may affect this host."
                                    : "Shows the latest flake-wide changes recorded by T3code."}
                        </p>
                        {selectedHostSummary ? (
                          <div className="mt-3 flex flex-wrap items-center gap-2">
                            <Button
                              size="sm"
                              variant={activeView === "changes" ? "secondary" : "ghost"}
                              onClick={() =>
                                selectDashboardView(selectedHostSummary.host.name, "changes")
                              }
                            >
                              Changes
                            </Button>
                            <Button
                              size="sm"
                              variant={activeView === "doc" ? "secondary" : "ghost"}
                              onClick={() =>
                                selectDashboardView(selectedHostSummary.host.name, "doc")
                              }
                            >
                              <BookOpenIcon className="size-3.5" />
                              Doc
                            </Button>
                            <Button
                              size="sm"
                              variant={activeView === "deploy" ? "secondary" : "ghost"}
                              onClick={() =>
                                selectDashboardView(selectedHostSummary.host.name, "deploy")
                              }
                            >
                              <SquareTerminalIcon className="size-3.5" />
                              Deploy
                            </Button>
                          </div>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {activeView === "doc" && selectedHostSummary ? (
                          <span
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                              documentationStatusClasses(selectedHostSummary.documentation.status),
                            )}
                          >
                            {formatDocumentationStatusLabel(
                              selectedHostSummary.documentation.status,
                            )}
                          </span>
                        ) : null}
                        {activeView === "deploy" && selectedHostDeployment ? (
                          <>
                            <span
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                deploymentStatusClasses(selectedHostDeployment.status),
                              )}
                            >
                              {formatDeploymentStatusLabel(selectedHostDeployment.status)}
                            </span>
                            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                              {formatDeploymentModeLabel(selectedHostDeployment.deployOnServer)}
                            </span>
                          </>
                        ) : null}
                        {activeView === "maintenance" && selectedFlakeMaintenance ? (
                          <span
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                              deploymentStatusClasses(selectedFlakeMaintenance.status),
                            )}
                          >
                            {formatDeploymentStatusLabel(selectedFlakeMaintenance.status)}
                          </span>
                        ) : null}
                      </div>
                    </div>

                    <div className="mt-4 overflow-hidden rounded-xl border border-border/50 bg-background/40">
                      {activeView === "doc" && selectedHostSummary ? (
                        dashboardQuery.data?.hostDoc &&
                        dashboardQuery.data.hostDoc.status !== "missing" &&
                        dashboardQuery.data.hostDoc.markdown.trim().length > 0 ? (
                          <div className="max-h-[78vh] overflow-y-auto p-4 sm:p-5">
                            <ChatMarkdown
                              text={dashboardQuery.data.hostDoc.markdown}
                              cwd={project.cwd}
                            />
                          </div>
                        ) : (
                          <div className="p-4 sm:p-5">
                            <EmptyPanel
                              title="No host doc yet"
                              description={`Generate documentation for ${selectedHostSummary.host.name} to materialize its current settings and apps.`}
                              icon={<BookOpenIcon className="size-5" />}
                              actionLabel={
                                generatingDocsByHost[selectedHostSummary.host.name]
                                  ? "Generating doc"
                                  : "Generate doc"
                              }
                              onAction={() => void handleGenerateHostDoc(selectedHostSummary.host)}
                              pending={generatingDocsByHost[selectedHostSummary.host.name] === true}
                            />
                          </div>
                        )
                      ) : activeView === "deploy" && selectedHostSummary ? (
                        <div className="space-y-4 p-4 sm:p-5">
                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                  Host
                                </div>
                                <div className="mt-0.5 text-base font-semibold text-foreground">
                                  {selectedHostSummary.host.name}
                                </div>
                                <div className="mt-1 text-sm text-muted-foreground">
                                  {selectedHostSummary.host.target}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  size="sm"
                                  onClick={() =>
                                    handleOpenDeployDialog(selectedHostSummary.host.name)
                                  }
                                  disabled={
                                    selectedHostSummary.deployment.status !== "deployable" ||
                                    deployingHostName === selectedHostSummary.host.name
                                  }
                                >
                                  {deployingHostName === selectedHostSummary.host.name ? (
                                    <RefreshCcwIcon className="size-3.5 animate-spin" />
                                  ) : (
                                    <RocketIcon className="size-3.5" />
                                  )}
                                  Redeploy
                                </Button>
                                {isSelectedHostDeploymentActive ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void handleStopDeployment()}
                                  >
                                    Cancel
                                  </Button>
                                ) : null}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    selectDashboardView(selectedHostSummary.host.name, "changes")
                                  }
                                >
                                  Changes
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    selectDashboardView(selectedHostSummary.host.name, "doc")
                                  }
                                >
                                  Doc
                                </Button>
                              </div>
                            </div>

                            {selectedHostDeployment ? (
                              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Started
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatTimestamp(selectedHostDeployment.startedAt)}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Finished
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {selectedHostDeployment.finishedAt
                                      ? formatTimestamp(selectedHostDeployment.finishedAt)
                                      : "Still running"}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3 lg:col-span-2">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Command
                                  </div>
                                  <code className="mt-1 block overflow-x-auto rounded-lg bg-muted/80 px-3 py-2 text-[12px] text-foreground">
                                    {selectedHostDeployment.command}
                                  </code>
                                </div>
                              </div>
                            ) : hostDeploymentQuery.isPending ? (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="Loading deployment"
                                  description="Checking whether this host has a recent deployment."
                                  icon={<LoaderIcon className="size-5 animate-spin" />}
                                />
                              </div>
                            ) : selectedHostSummary.deployment.status === "deployable" ? (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="No deployment yet"
                                  description={`Run deploy-rs for ${selectedHostSummary.host.name} to create a dedicated host deployment page with terminal output.`}
                                  icon={<SquareTerminalIcon className="size-5" />}
                                  actionLabel="Deploy"
                                  onAction={() =>
                                    handleOpenDeployDialog(selectedHostSummary.host.name)
                                  }
                                  pending={deployingHostName === selectedHostSummary.host.name}
                                />
                              </div>
                            ) : (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="Deployment unavailable"
                                  description={
                                    deploymentReasonLabel(selectedHostSummary.deployment.reason) ??
                                    "This host does not have a deploy-rs target."
                                  }
                                  icon={<AlertCircleIcon className="size-5" />}
                                />
                              </div>
                            )}
                          </div>

                          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/60">
                            <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
                              <div>
                                <h3 className="text-sm font-semibold text-foreground">Terminal</h3>
                                <p className="text-xs text-muted-foreground">
                                  Read-only deploy output for the latest run on this host.
                                </p>
                              </div>
                              {selectedHostDeployment ? (
                                <span
                                  className={cn(
                                    "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                    deploymentStatusClasses(selectedHostDeployment.status),
                                  )}
                                >
                                  {formatDeploymentStatusLabel(selectedHostDeployment.status)}
                                </span>
                              ) : null}
                            </div>
                            <div className="h-[56vh] min-h-[320px] p-2">
                              {selectedHostDeployment ? (
                                <HostDeploymentTerminal
                                  environmentId={projectRef.environmentId}
                                  projectId={project.id}
                                  hostName={selectedHostSummary.host.name}
                                  cwd={selectedHostDeployment.cwd}
                                  autoFocus
                                  onSessionExited={() => {
                                    void Promise.all([
                                      invalidateHostDeploymentQueries(),
                                      invalidateDashboardQueries(),
                                    ]);
                                  }}
                                />
                              ) : (
                                <div className="h-full p-2">
                                  <EmptyPanel
                                    title="No terminal output yet"
                                    description="The deploy page will stream the latest run here once a deployment has started."
                                    icon={<SquareTerminalIcon className="size-5" />}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : activeView === "maintenance" ? (
                        <div className="space-y-4 p-4 sm:p-5">
                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                  Command
                                </div>
                                <code className="mt-1 block overflow-x-auto rounded-lg bg-muted/80 px-3 py-2 text-[12px] text-foreground">
                                  nix flake update
                                </code>
                                <div className="mt-3 text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                  Workspace
                                </div>
                                <div className="mt-1 break-all text-sm text-muted-foreground">
                                  {project.cwd}
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  size="sm"
                                  onClick={() => void handleStartMaintenance()}
                                  disabled={
                                    maintenancePending ||
                                    isSelectedFlakeMaintenanceActive ||
                                    maintenanceActionDisabledReason !== null
                                  }
                                  title={maintenanceActionDisabledReason ?? undefined}
                                >
                                  {maintenancePending ? (
                                    <RefreshCcwIcon className="size-3.5 animate-spin" />
                                  ) : (
                                    <RefreshCcwIcon className="size-3.5" />
                                  )}
                                  {selectedFlakeMaintenance ? "Run again" : "Run update"}
                                </Button>
                                {isSelectedFlakeMaintenanceActive ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void handleStopMaintenance()}
                                  >
                                    Cancel
                                  </Button>
                                ) : null}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => selectDashboardView(null, "flake")}
                                >
                                  flake.nix
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => selectDashboardView(null, "changes")}
                                >
                                  Changes
                                </Button>
                              </div>
                            </div>

                            {selectedFlakeMaintenance ? (
                              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Started
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatTimestamp(selectedFlakeMaintenance.startedAt)}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Finished
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {selectedFlakeMaintenance.finishedAt
                                      ? formatTimestamp(selectedFlakeMaintenance.finishedAt)
                                      : "Still running"}
                                  </div>
                                </div>
                              </div>
                            ) : null}
                          </div>

                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h3 className="text-sm font-semibold text-foreground">
                                  Git review
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                  Maintenance only runs from a clean git worktree so you can review,
                                  commit, and push updates from here.
                                </p>
                              </div>
                              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                {formatGitBranchLabel(gitStatusQuery.data)}
                              </span>
                            </div>

                            {gitStatusQuery.isPending && !gitStatusQuery.data ? (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="Loading git status"
                                  description="Checking the flake worktree before maintenance."
                                  icon={<LoaderIcon className="size-5 animate-spin" />}
                                />
                              </div>
                            ) : !gitStatusQuery.data?.isRepo ? (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="Git repository required"
                                  description="This maintenance page only supports git-backed flakes in v1."
                                  icon={<AlertCircleIcon className="size-5" />}
                                />
                              </div>
                            ) : (
                              <div className="mt-4 space-y-4">
                                <div className="grid gap-3 md:grid-cols-3">
                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                      Branch
                                    </div>
                                    <div className="mt-1 text-sm text-foreground">
                                      {formatGitBranchLabel(gitStatusQuery.data)}
                                    </div>
                                  </div>
                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                      Ahead / Behind
                                    </div>
                                    <div className="mt-1 text-sm text-foreground">
                                      {gitStatusQuery.data.aheadCount} /{" "}
                                      {gitStatusQuery.data.behindCount}
                                    </div>
                                  </div>
                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                      Working tree
                                    </div>
                                    <div className="mt-1 text-sm text-foreground">
                                      {gitStatusQuery.data.hasWorkingTreeChanges
                                        ? "Has local changes"
                                        : "Clean"}
                                    </div>
                                  </div>
                                </div>

                                {selectedFlakeMaintenance?.status === "succeeded" &&
                                gitStatusQuery.data.workingTree.files.length === 0 ? (
                                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-700 dark:text-emerald-300">
                                    No dependency updates were applied.
                                  </div>
                                ) : null}

                                {gitStatusQuery.data.workingTree.files.length > 0 ? (
                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                    <div className="mb-3 text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                      Changed files
                                    </div>
                                    <div className="grid gap-2">
                                      {gitStatusQuery.data.workingTree.files.map((file) => (
                                        <div
                                          key={file.path}
                                          className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-card/40 px-3 py-2"
                                        >
                                          <code className="min-w-0 truncate text-[12px] text-foreground">
                                            {file.path}
                                          </code>
                                          <span className="shrink-0 text-[11px] text-muted-foreground">
                                            +{file.insertions} / -{file.deletions}
                                          </span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                ) : (
                                  <div className="rounded-xl border border-border/50 bg-background/50 px-4 py-3 text-sm text-muted-foreground">
                                    {maintenanceActionDisabledReason ??
                                      "The worktree is clean. Run flake maintenance to update inputs."}
                                  </div>
                                )}

                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="mb-3 text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Commit and push
                                  </div>
                                  <GitActionsControl
                                    gitCwd={project.cwd}
                                    activeThreadRef={null}
                                    environmentId={projectRef.environmentId}
                                  />
                                </div>
                              </div>
                            )}
                          </div>

                          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/60">
                            <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
                              <div>
                                <h3 className="text-sm font-semibold text-foreground">Terminal</h3>
                                <p className="text-xs text-muted-foreground">
                                  Read-only output for the current or last nix flake update run.
                                </p>
                              </div>
                              {selectedFlakeMaintenance ? (
                                <span
                                  className={cn(
                                    "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                    deploymentStatusClasses(selectedFlakeMaintenance.status),
                                  )}
                                >
                                  {formatDeploymentStatusLabel(selectedFlakeMaintenance.status)}
                                </span>
                              ) : null}
                            </div>
                            <div className="h-[56vh] min-h-[320px] p-2">
                              {selectedFlakeMaintenance ? (
                                <FlakeMaintenanceTerminal
                                  environmentId={projectRef.environmentId}
                                  projectId={project.id}
                                  cwd={selectedFlakeMaintenance.cwd}
                                  autoFocus
                                  onSessionExited={() => {
                                    void Promise.all([
                                      invalidateFlakeMaintenanceQueries(),
                                      invalidateDashboardQueries(),
                                      refreshFlakeGitStatus(),
                                    ]);
                                  }}
                                />
                              ) : (
                                <div className="h-full p-2">
                                  <EmptyPanel
                                    title="No maintenance run yet"
                                    description={
                                      maintenanceActionDisabledReason ??
                                      "Run nix flake update to stream terminal output and review changed files here."
                                    }
                                    icon={<SquareTerminalIcon className="size-5" />}
                                    pending={maintenancePending}
                                    {...(maintenanceActionDisabledReason === null
                                      ? {
                                          actionLabel: "Run flake update",
                                          onAction: () => void handleStartMaintenance(),
                                        }
                                      : {})}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : activeView === "flake" ? (
                        dashboardQuery.data ? (
                          <div className="max-h-[78vh] overflow-y-auto p-4 sm:p-5">
                            <ChatMarkdown text={flakeSourceMarkdown} cwd={project.cwd} />
                          </div>
                        ) : (
                          <div className="p-4 sm:p-5">
                            <EmptyPanel
                              title="Loading flake source"
                              description="Fetching flake.nix for the selected flake."
                              icon={<LoaderIcon className="size-5 animate-spin" />}
                            />
                          </div>
                        )
                      ) : (
                        <div className="max-h-[78vh] overflow-y-auto p-4 sm:p-5">
                          <div className="grid gap-3">
                            {dashboardQuery.isPending && !dashboardQuery.data ? (
                              <EmptyPanel
                                title="Loading changes"
                                description="Fetching recent changelog entries..."
                                icon={<LoaderIcon className="size-5 animate-spin" />}
                              />
                            ) : visibleChangeEntries.length > 0 ? (
                              visibleChangeEntries.map((entry) => (
                                <ChangeEntryCard
                                  key={`${entry.kind}:${entry.id}`}
                                  entry={entry}
                                  cwd={project.cwd}
                                />
                              ))
                            ) : (
                              <EmptyPanel
                                title="No changes recorded yet"
                                description={
                                  selectedHostSummary
                                    ? "This host does not have any matching changelog entries yet."
                                    : "T3code has not written any general changelog entries for this flake yet."
                                }
                              />
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </section>
                )}
              </main>
            </div>
          </div>
        </div>
      </div>
      <Dialog
        open={deployDialogHostSummary !== null}
        onOpenChange={(open) => {
          if (!open) {
            handleCloseDeployDialog();
          }
        }}
      >
        <DialogPopup className="max-w-xl">
          <DialogHeader>
            <DialogTitle>
              {deployDialogHostSummary
                ? `Deploy ${deployDialogHostSummary.host.name}?`
                : "Deploy host?"}
            </DialogTitle>
            <DialogDescription>
              Confirm the deploy-rs command before opening the dedicated host deployment page.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {deployDialogHostSummary ? (
              <>
                <div className="grid gap-3 rounded-xl border border-border/50 bg-background/40 p-4 text-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                        Host
                      </div>
                      <div className="mt-0.5 font-medium text-foreground">
                        {deployDialogHostSummary.host.name}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-[0.12em]",
                        documentationStatusClasses(deployDialogHostSummary.documentation.status),
                      )}
                    >
                      {formatDocumentationStatusLabel(deployDialogHostSummary.documentation.status)}
                    </span>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                      Target
                    </div>
                    <div className="mt-0.5 break-all text-foreground">
                      {deployDialogHostSummary.host.target}
                    </div>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                      Command
                    </div>
                    <code className="mt-1 block overflow-x-auto rounded-lg bg-muted/80 px-3 py-2 text-[12px] text-foreground">
                      {deployDialogCommand ?? deployDialogDisabledReason ?? "Unavailable"}
                    </code>
                  </div>
                  <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                    <label className="flex items-start gap-3">
                      <Checkbox
                        checked={deployOnServer}
                        disabled={deployingHostName !== null}
                        onCheckedChange={(checked) => {
                          setDeployOnServer(checked === true);
                        }}
                        aria-label="Deploy on server"
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">
                          Deploy on server
                        </span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">
                          Unchecked is the standard path and adds deploy-rs remote build plus
                          skip-checks so the target host builds the system itself without local
                          cross-architecture deployment checks.
                        </span>
                      </span>
                    </label>
                  </div>
                  <div>
                    <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                      Branch
                    </div>
                    <div className="mt-0.5 text-foreground">
                      {gitStatusQuery.data?.branch ?? "Unavailable"}
                    </div>
                  </div>
                </div>

                {gitStatusQuery.data?.hasWorkingTreeChanges ? (
                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-800 dark:text-amber-200">
                    This flake repo has uncommitted changes. Deployment will still run from the
                    current workspace state.
                  </div>
                ) : gitStatusQuery.data ? (
                  <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-800 dark:text-emerald-200">
                    This flake repo is clean
                    {gitStatusQuery.data.branch ? ` on ${gitStatusQuery.data.branch}` : ""}.
                  </div>
                ) : gitStatusQuery.isPending ? (
                  <div className="rounded-xl border border-border/50 bg-background/40 p-3 text-sm text-muted-foreground">
                    Checking Git status for this flake repo.
                  </div>
                ) : (
                  <div className="rounded-xl border border-border/50 bg-background/40 p-3 text-sm text-muted-foreground">
                    Git status could not be determined for this flake repo.
                  </div>
                )}
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={handleCloseDeployDialog}
              disabled={deployingHostName !== null}
            >
              Cancel
            </Button>
            <Button
              onClick={() => void handleConfirmDeployment()}
              disabled={
                deployDialogHostSummary === null ||
                deployDialogHostSummary.deployment.status !== "deployable" ||
                deployingHostName !== null
              }
            >
              {deployingHostName !== null ? (
                <RefreshCcwIcon className="size-4 animate-spin" />
              ) : (
                <RocketIcon className="size-4" />
              )}
              Deploy
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
