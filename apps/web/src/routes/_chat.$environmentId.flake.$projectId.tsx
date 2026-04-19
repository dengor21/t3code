import { scopeThreadRef } from "@t3tools/client-runtime";
import {
  buildDeployRsCommand,
  type FlakeHost,
  type HostDocumentationStatus,
  type ProjectDashboardChangeEntry,
} from "@t3tools/contracts";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  BookOpenIcon,
  FileTextIcon,
  PlayIcon,
  RefreshCcwIcon,
  RocketIcon,
  ServerIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import ChatMarkdown from "../components/ChatMarkdown";
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
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { buildHostThreadPrompt } from "../lib/flakeHosts";
import { useGitStatus } from "../lib/gitStatusState";
import { projectDashboardContentQueryOptions, projectQueryKeys } from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import { selectEnvironmentState, useStore } from "../store";
import { createProjectSelectorByRef } from "../storeSelectors";
import { useTerminalStateStore } from "../terminalStateStore";
import { buildFlakeRouteParams, buildThreadRouteParams, resolveFlakeRouteRef } from "../threadRoutes";

export interface FlakeDashboardSearch {
  host?: string;
  view?: "changes" | "doc" | "flake";
}

function parseFlakeDashboardSearch(search: Record<string, unknown>): FlakeDashboardSearch {
  const host = typeof search.host === "string" ? search.host.trim() : "";
  const view = search.view;
  const next: FlakeDashboardSearch = {};
  if (host.length > 0) {
    next.host = host;
  }
  if (view === "changes" || view === "doc" || view === "flake") {
    next.view = view;
  }
  return next;
}

type FlakeDashboardView = "changes" | "doc" | "flake";

const DEPLOY_TERMINAL_COLS = 120;
const DEPLOY_TERMINAL_ROWS = 30;

function buildDashboardSearch(input: {
  hostName: string | null;
  view: FlakeDashboardView;
}): FlakeDashboardSearch {
  if (input.hostName) {
    return input.view === "doc" ? { host: input.hostName, view: "doc" } : { host: input.hostName };
  }

  return input.view === "flake" ? { view: "flake" } : {};
}

function formatDocumentationStatusLabel(status: HostDocumentationStatus | null | undefined): string {
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
  actionLabel?: string;
  onAction?: () => void;
  pending?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border/70 bg-background/40 px-5 py-6">
      <div className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">{props.title}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{props.description}</p>
        </div>
        {props.actionLabel && props.onAction ? (
          <div>
            <Button
              variant="outline"
              onClick={props.onAction}
              disabled={props.pending}
              className="gap-2"
            >
              {props.pending ? <RefreshCcwIcon className="size-4 animate-spin" /> : null}
              {props.actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ChangeEntryCard(props: {
  entry: ProjectDashboardChangeEntry;
  cwd: string;
}) {
  const { entry, cwd } = props;
  return (
    <article className="rounded-2xl border border-border/60 bg-background/55 p-4">
      <div className="flex flex-wrap items-center gap-2">
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
      <div className="mt-3">
        <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground/70">
          {formatTimestamp(entry.completedAt)}
        </div>
        <h3 className="mt-2 text-base font-semibold text-foreground">{entry.title}</h3>
      </div>
      {entry.markdown.trim().length > 0 ? (
        <div className="mt-4 rounded-xl bg-card/40 p-3">
          <ChatMarkdown text={entry.markdown} cwd={cwd} />
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground/80">Files:</span>
        {entry.files.length > 0 ? (
          entry.files.map((file) => (
            <code
              key={`${entry.id}:${file}`}
              className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px] text-foreground"
            >
              {file}
            </code>
          ))
        ) : (
          <span>None recorded</span>
        )}
      </div>
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
    requestedHostName === null ? null : routeHostsByName.get(requestedHostName.toLowerCase()) ?? null;

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

  const dashboardQuery = useQuery(
    projectDashboardContentQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      hostName: matchedRouteHostName ?? requestedHostName,
      enabled: bootstrapComplete && projectRef !== null && project !== null,
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
    void handleNewThread(projectRef);
  }, [handleNewThread, projectRef]);

  const handleStartHostThread = useCallback(
    (host: FlakeHost) => {
      if (!projectRef) {
        return;
      }
      void handleNewThread(projectRef, {
        initialPrompt: buildHostThreadPrompt(host),
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
      dashboardQuery.data?.hostSummaries.find((summary) => summary.host.name === deployDialogHostName) ??
      null;
    if (!hostSummary || hostSummary.deployment.status !== "deployable" || !hostSummary.deployment.command) {
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
      const result = await api.projects.startHostDeployment({
        projectId: project.id,
        hostName: hostSummary.host.name,
        deployOnServer,
      });
      const threadRef = scopeThreadRef(projectRef.environmentId, result.threadId);
      const terminalState = useTerminalStateStore.getState();

      terminalState.ensureTerminal(threadRef, result.terminalId, { open: true, active: true });
      terminalState.setTerminalOpen(threadRef, true);
      terminalState.setTerminalLaunchContext(threadRef, {
        cwd: result.cwd,
        worktreePath: null,
      });

      setDeployDialogHostName(null);
      setDeployingHostName(null);
      setDeployOnServer(false);

      await navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(threadRef),
      });

      try {
        await api.terminal.open({
          threadId: result.threadId,
          terminalId: result.terminalId,
          cwd: result.cwd,
          worktreePath: null,
          cols: DEPLOY_TERMINAL_COLS,
          rows: DEPLOY_TERMINAL_ROWS,
        });
        await api.terminal.write({
          threadId: result.threadId,
          terminalId: result.terminalId,
          data: `${result.command}\r`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Deployment thread created, but the terminal failed to start",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to start deployment for ${hostSummary.host.name}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
      setDeployingHostName(null);
    }
  }, [dashboardQuery.data?.hostSummaries, deployDialogHostName, deployOnServer, navigate, project, projectRef]);

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
      dashboardQuery.data?.hostSummaries.find((summary) => summary.host.name === deployDialogHostName) ??
      null
    );
  }, [dashboardQuery.data, deployDialogHostName]);

  const flakeSourceMarkdown = useMemo(
    () => renderFlakeSourceMarkdown(dashboardQuery.data?.flakeSource.contents ?? ""),
    [dashboardQuery.data?.flakeSource.contents],
  );
  const activeView: FlakeDashboardView = useMemo(() => {
    if (selectedHostSummary) {
      return search.view === "doc" ? "doc" : "changes";
    }
    return search.view === "flake" ? "flake" : "changes";
  }, [search.view, selectedHostSummary]);
  const visibleChangeEntries = selectedHostSummary
    ? dashboardQuery.data?.hostChanges ?? []
    : dashboardQuery.data?.generalChanges ?? [];
  const deployDialogCommand =
    deployDialogHostSummary?.deployment.status === "deployable"
      ? buildDeployRsCommand(deployDialogHostSummary.host.name, { deployOnServer })
      : null;
  const deployDialogDisabledReason = deploymentReasonLabel(
    deployDialogHostSummary?.deployment.reason ?? null,
  );

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
            <div className="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
              <aside className="flex min-w-0 flex-col gap-4">
                <section className="rounded-3xl border border-border/70 bg-card/60 p-6 shadow-sm">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/70">
                    <ServerIcon className="size-3.5" />
                    <span>Selected flake</span>
                  </div>
                  <div className="mt-4">
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                      {project.name}
                    </h1>
                    <p className="mt-1 break-all text-sm text-muted-foreground">{project.cwd}</p>
                  </div>
                  <div className="mt-5 flex flex-wrap gap-2">
                    <Button onClick={handleStartThread}>
                      <PlayIcon className="size-4" />
                      Start thread
                    </Button>
                    <Button
                      variant={selectedHostSummary === null && activeView === "changes" ? "default" : "outline"}
                      onClick={() => selectDashboardView(null, "changes")}
                    >
                      Changes
                    </Button>
                    <Button
                      variant={selectedHostSummary === null && activeView === "flake" ? "default" : "outline"}
                      onClick={() => selectDashboardView(null, "flake")}
                    >
                      <FileTextIcon className="size-4" />
                      flake.nix
                    </Button>
                  </div>
                </section>

                <section className="rounded-3xl border border-border/70 bg-card/50 p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h2 className="text-sm font-semibold tracking-wide text-foreground">Hosts</h2>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Select a host to inspect its changes and documentation.
                      </p>
                    </div>
                  </div>

                  <div className="mt-4 grid gap-3">
                    {dashboardQuery.isPending && !dashboardQuery.data ? (
                      <div className="rounded-2xl border border-dashed border-border/60 bg-background/40 px-4 py-5 text-sm text-muted-foreground">
                        Loading hosts...
                      </div>
                    ) : dashboardQuery.data && dashboardQuery.data.hostSummaries.length > 0 ? (
                      dashboardQuery.data.hostSummaries.map((summary) => {
                        const isSelected =
                          dashboardQuery.data?.selectedHostName === summary.host.name;
                        const generating = generatingDocsByHost[summary.host.name] === true;
                        const deploying = deployingHostName === summary.host.name;
                        const hostChangesSelected = isSelected && activeView === "changes";
                        const hostDocSelected = isSelected && activeView === "doc";
                        const deployDisabledReason = deploymentReasonLabel(summary.deployment.reason);
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
                              "rounded-2xl border p-4 text-left transition-colors",
                              isSelected
                                ? "border-primary/40 bg-primary/8 shadow-sm"
                                : "border-border/60 bg-background/55 hover:border-primary/30 hover:bg-background/80",
                            )}
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div className="min-w-0">
                                <div className="text-base font-semibold text-foreground">
                                  {summary.host.name}
                                </div>
                                <div className="mt-1 break-all text-sm text-muted-foreground">
                                  {summary.host.target}
                                </div>
                              </div>
                              <span
                                className={cn(
                                  "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                  documentationStatusClasses(summary.documentation.status),
                                )}
                              >
                                {formatDocumentationStatusLabel(summary.documentation.status)}
                              </span>
                            </div>

                            <div className="mt-3 flex flex-wrap gap-2">
                              {summary.host.type ? (
                                <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                  {summary.host.type}
                                </span>
                              ) : null}
                              {summary.host.system ? (
                                <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                  {summary.host.system}
                                </span>
                              ) : null}
                            </div>

                            <div className="mt-4 flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                variant={hostChangesSelected ? "default" : "outline"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectDashboardView(summary.host.name, "changes");
                                }}
                              >
                                Changes
                              </Button>
                              <Button
                                size="sm"
                                variant={hostDocSelected ? "default" : "outline"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectDashboardView(summary.host.name, "doc");
                                }}
                              >
                                <BookOpenIcon className="size-3.5" />
                                Doc
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleStartHostThread(summary.host);
                                }}
                              >
                                <PlayIcon className="size-3.5" />
                                Start thread
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={generating}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void handleGenerateHostDoc(summary.host);
                                }}
                              >
                                {generating ? <RefreshCcwIcon className="size-3.5 animate-spin" /> : null}
                                {summary.documentation.status === "missing" ? "Generate doc" : "Refresh doc"}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={summary.deployment.status !== "deployable" || deploying}
                                title={deployDisabledReason ?? undefined}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  handleOpenDeployDialog(summary.host.name);
                                }}
                              >
                                {deploying ? <RefreshCcwIcon className="size-3.5 animate-spin" /> : <RocketIcon className="size-3.5" />}
                                Deploy
                              </Button>
                            </div>
                            {summary.deployment.status !== "deployable" && deployDisabledReason ? (
                              <p className="mt-3 text-xs text-muted-foreground">
                                {deployDisabledReason}
                              </p>
                            ) : null}
                          </div>
                        );
                      })
                    ) : (
                      <div className="rounded-2xl border border-dashed border-border/60 bg-background/40 px-4 py-5 text-sm text-muted-foreground">
                        No hosts were resolved for this flake yet.
                      </div>
                    )}
                  </div>
                </section>
              </aside>

              <main className="min-w-0">
                {dashboardQuery.isError && !dashboardQuery.data ? (
                  <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6">
                    <div className="flex items-start gap-3">
                      <AlertCircleIcon className="mt-0.5 size-5 text-destructive" />
                      <div>
                        <h2 className="text-base font-semibold text-foreground">
                          Unable to load flake dashboard
                        </h2>
                        <p className="mt-2 text-sm text-muted-foreground">
                          {dashboardQuery.error instanceof Error
                            ? dashboardQuery.error.message
                            : "An unexpected error occurred."}
                        </p>
                      </div>
                    </div>
                  </section>
                ) : (
                  <section className="rounded-3xl border border-border/70 bg-card/50 p-5 sm:p-6">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <h2 className="text-lg font-semibold text-foreground">
                          {activeView === "doc"
                            ? `Documentation for ${selectedHostSummary?.host.name ?? "host"}`
                            : activeView === "flake"
                              ? "flake.nix"
                              : selectedHostSummary
                                ? `Recent changes for ${selectedHostSummary.host.name}`
                                : "Recent changes"}
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          {activeView === "doc"
                            ? selectedHostSummary?.documentation.generatedAt
                              ? `Generated ${formatTimestamp(selectedHostSummary.documentation.generatedAt)}`
                              : "Manual host documentation is missing or needs to be generated."
                            : activeView === "flake"
                              ? "Read-only source preview for the selected flake."
                              : selectedHostSummary
                                ? "Shows the latest host-specific and ambiguous changes that may affect this host."
                                : "Shows the latest flake-wide changes recorded by T3code."}
                        </p>
                      </div>
                      {activeView === "doc" && selectedHostSummary ? (
                        <span
                          className={cn(
                            "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                            documentationStatusClasses(selectedHostSummary.documentation.status),
                          )}
                        >
                          {formatDocumentationStatusLabel(selectedHostSummary.documentation.status)}
                        </span>
                      ) : null}
                    </div>

                    <div className="mt-4 overflow-hidden rounded-2xl border border-border/60 bg-background/45">
                      {activeView === "doc" && selectedHostSummary ? (
                        dashboardQuery.data?.hostDoc &&
                        dashboardQuery.data.hostDoc.status !== "missing" &&
                        dashboardQuery.data.hostDoc.markdown.trim().length > 0 ? (
                          <div className="max-h-[78vh] overflow-y-auto p-4 sm:p-5">
                            <ChatMarkdown text={dashboardQuery.data.hostDoc.markdown} cwd={project.cwd} />
                          </div>
                        ) : (
                          <div className="p-4 sm:p-5">
                            <EmptyPanel
                              title="No host doc yet"
                              description={`Generate documentation for ${selectedHostSummary.host.name} to materialize its current settings and apps.`}
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
                            />
                          </div>
                        )
                      ) : (
                        <div className="max-h-[78vh] overflow-y-auto p-4 sm:p-5">
                          <div className="grid gap-4">
                            {dashboardQuery.isPending && !dashboardQuery.data ? (
                              <div className="rounded-2xl border border-dashed border-border/60 bg-background/40 px-4 py-5 text-sm text-muted-foreground">
                                Loading recent changes...
                              </div>
                            ) : visibleChangeEntries.length > 0 ? (
                              visibleChangeEntries.map((entry) => (
                                <ChangeEntryCard key={`${entry.kind}:${entry.id}`} entry={entry} cwd={project.cwd} />
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
              {deployDialogHostSummary ? `Deploy ${deployDialogHostSummary.host.name}?` : "Deploy host?"}
            </DialogTitle>
            <DialogDescription>
              Confirm the deploy-rs command before starting a dedicated deployment thread.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {deployDialogHostSummary ? (
              <>
                <div className="grid gap-3 rounded-2xl border border-border/60 bg-background/45 p-4 text-sm">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                        Host
                      </div>
                      <div className="mt-1 font-medium text-foreground">
                        {deployDialogHostSummary.host.name}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                        documentationStatusClasses(deployDialogHostSummary.documentation.status),
                      )}
                    >
                      {formatDocumentationStatusLabel(deployDialogHostSummary.documentation.status)}
                    </span>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      Target
                    </div>
                    <div className="mt-1 break-all text-foreground">
                      {deployDialogHostSummary.host.target}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      Command
                    </div>
                    <code className="mt-1 block overflow-x-auto rounded-xl bg-muted px-3 py-2 text-[12px] text-foreground">
                      {deployDialogCommand ?? deployDialogDisabledReason ?? "Unavailable"}
                    </code>
                  </div>
                  <div className="rounded-2xl border border-border/60 bg-background/55 p-3">
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
                        <span className="mt-1 block text-xs text-muted-foreground">
                          Unchecked is the standard path and adds deploy-rs remote build plus
                          skip-checks so the target host builds the system itself without local
                          cross-architecture deployment checks.
                        </span>
                      </span>
                    </label>
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-[0.14em] text-muted-foreground">
                      Branch
                    </div>
                    <div className="mt-1 text-foreground">
                      {gitStatusQuery.data?.branch ?? "Unavailable"}
                    </div>
                  </div>
                </div>

                {gitStatusQuery.data?.hasWorkingTreeChanges ? (
                  <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
                    This flake repo has uncommitted changes. Deployment will still run from the
                    current workspace state.
                  </div>
                ) : gitStatusQuery.data ? (
                  <div className="rounded-2xl border border-emerald-500/30 bg-emerald-500/10 p-4 text-sm text-emerald-800 dark:text-emerald-200">
                    This flake repo is clean{gitStatusQuery.data.branch ? ` on ${gitStatusQuery.data.branch}` : ""}.
                  </div>
                ) : gitStatusQuery.isPending ? (
                  <div className="rounded-2xl border border-border/60 bg-background/45 p-4 text-sm text-muted-foreground">
                    Checking Git status for this flake repo.
                  </div>
                ) : (
                  <div className="rounded-2xl border border-border/60 bg-background/45 p-4 text-sm text-muted-foreground">
                    Git status could not be determined for this flake repo.
                  </div>
                )}
              </>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={handleCloseDeployDialog} disabled={deployingHostName !== null}>
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
              {deployingHostName !== null ? <RefreshCcwIcon className="size-4 animate-spin" /> : <RocketIcon className="size-4" />}
              Deploy
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </SidebarInset>
  );
}
