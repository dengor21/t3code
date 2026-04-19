import type { FlakeHost } from "@t3tools/contracts";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { AlertCircleIcon, BookOpenIcon, FileTextIcon, PlayIcon, ServerIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import { readEnvironmentApi } from "../environmentApi";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { buildHostThreadPrompt } from "../lib/flakeHosts";
import { readLocalApi } from "../localApi";
import { selectEnvironmentState, useStore } from "../store";
import { createProjectSelectorByRef } from "../storeSelectors";
import { resolveFlakeRouteRef } from "../threadRoutes";
import { Button } from "../components/ui/button";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";

function slugifyHostName(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "host";
}

function formatDocumentationStatusLabel(status: string | null | undefined): string {
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

function documentationStatusClasses(status: string | null | undefined): string {
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

function formatFlakeSourceLabel(source: string | null | undefined): string {
  switch (source) {
    case "nix-eval":
      return "Resolved from nix eval";
    case "parsed-flake":
      return "Parsed from flake.nix";
    case "missing":
      return "No host metadata found";
    case "error":
      return "Metadata resolution failed";
    default:
      return "Metadata unavailable";
  }
}

function FlakeOverviewRouteView() {
  const navigate = useNavigate();
  const projectRef = Route.useParams({
    select: (params) => resolveFlakeRouteRef(params),
  });
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

  useEffect(() => {
    if (!projectRef || !bootstrapComplete) {
      return;
    }

    if (!project && environmentHasProjects) {
      void navigate({ to: "/", replace: true });
    }
  }, [bootstrapComplete, environmentHasProjects, navigate, project, projectRef]);

  const docsRootPath = useMemo(
    () => (project ? `${project.cwd}/.t3code/docs/hosts` : null),
    [project],
  );

  const openPathInEditor = useCallback(async (targetPath: string) => {
    const api = readLocalApi();
    if (!api) {
      toastManager.add({
        type: "error",
        title: "Open in editor is unavailable",
      });
      return;
    }

    try {
      await openInPreferredEditor(api, targetPath);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Unable to open file",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    }
  }, []);

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
    [generatingDocsByHost, project, projectRef],
  );

  const openHostDoc = useCallback(
    async (hostName: string) => {
      if (!project) {
        return;
      }

      await openPathInEditor(`${project.cwd}/.t3code/docs/hosts/${slugifyHostName(hostName)}.md`);
    },
    [openPathInEditor, project],
  );

  if (!projectRef || !bootstrapComplete || !project) {
    return null;
  }

  const flakeMetadata = project.flakeMetadata;
  const hosts = flakeMetadata?.hosts ?? (flakeMetadata?.host ? [flakeMetadata.host] : []);
  const documentationStateByHost = new Map(
    (project.documentationState?.hosts ?? []).map((entry) => [entry.hostName, entry] as const),
  );
  const sourceLabel = formatFlakeSourceLabel(flakeMetadata?.source);
  const flakePath = flakeMetadata?.flakePath ?? `${project.cwd}/flake.nix`;
  const diagnostics = flakeMetadata?.diagnostics ?? [];

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <header className="flex items-center gap-2 border-b border-border px-3 py-2 sm:px-5 sm:py-3">
          <SidebarTrigger className="size-7 shrink-0 md:hidden" />
          <span className="text-sm font-medium text-foreground md:text-muted-foreground/60">
            Flake overview
          </span>
        </header>

        <div className="flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
            <section className="rounded-3xl border border-border/70 bg-card/60 p-6 shadow-sm">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground/70">
                    <ServerIcon className="size-3.5" />
                    <span>Selected flake</span>
                  </div>
                  <div>
                    <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                      {project.name}
                    </h1>
                    <p className="mt-1 break-all text-sm text-muted-foreground">{project.cwd}</p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button onClick={handleStartThread}>
                    <PlayIcon className="size-4" />
                    Start thread
                  </Button>
                  <Button variant="outline" onClick={() => void openPathInEditor(flakePath)}>
                    <FileTextIcon className="size-4" />
                    Open flake.nix
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void openPathInEditor(`${project.cwd}/.t3code/changes.md`)}
                  >
                    <BookOpenIcon className="size-4" />
                    Open changes log
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => docsRootPath && void openPathInEditor(docsRootPath)}
                    disabled={!docsRootPath}
                  >
                    <BookOpenIcon className="size-4" />
                    Open docs folder
                  </Button>
                </div>
              </div>
            </section>

            <section className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,1fr)]">
              <div className="rounded-3xl border border-border/70 bg-card/50 p-6">
                <h2 className="text-sm font-semibold tracking-wide text-foreground">
                  {hosts.length > 1 ? "Hosts" : "Host"}
                </h2>
                {hosts.length > 0 ? (
                  <div className="mt-4 grid gap-4 xl:grid-cols-2">
                    {hosts.map((host) => (
                      <div
                        key={`${host.name}:${host.target}`}
                        className="rounded-2xl border border-border/60 bg-background/60 p-4"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                              Name
                            </div>
                            <div className="mt-2 text-lg font-medium text-foreground">
                              {host.name}
                            </div>
                          </div>
                          <div className="flex flex-wrap justify-end gap-2">
                            {host.type ? (
                              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                {host.type}
                              </span>
                            ) : null}
                            {host.system ? (
                              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                {host.system}
                              </span>
                            ) : null}
                            <span
                              className={`rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] ${documentationStatusClasses(
                                documentationStateByHost.get(host.name)?.status,
                              )}`}
                            >
                              {formatDocumentationStatusLabel(
                                documentationStateByHost.get(host.name)?.status,
                              )}
                            </span>
                          </div>
                        </div>
                        <div className="mt-4">
                          <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                            Target
                          </div>
                          <div className="mt-2 break-all text-sm font-medium text-foreground">
                            {host.target}
                          </div>
                        </div>
                        <div className="mt-4 space-y-2">
                          <div className="text-xs text-muted-foreground">
                            {documentationStateByHost.get(host.name)?.generatedAt
                              ? `Generated ${documentationStateByHost.get(host.name)?.generatedAt}`
                              : "No current-state host doc has been generated yet."}
                          </div>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              size="sm"
                              onClick={() => handleStartHostThread(host)}
                              className="min-w-[8rem]"
                            >
                              <PlayIcon className="size-4" />
                              Start thread
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void handleGenerateHostDoc(host)}
                              disabled={Boolean(generatingDocsByHost[host.name])}
                            >
                              <BookOpenIcon className="size-4" />
                              {generatingDocsByHost[host.name]
                                ? "Generating..."
                                : documentationStateByHost.get(host.name)?.status === "missing"
                                  ? "Generate doc"
                                  : "Refresh doc"}
                            </Button>
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void openHostDoc(host.name)}
                              disabled={documentationStateByHost.get(host.name)?.status === "missing"}
                            >
                              <FileTextIcon className="size-4" />
                              Open doc
                            </Button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-border/70 bg-background/40 p-5 text-sm text-muted-foreground">
                    No `t3code.host` or `t3hosts` metadata was resolved for this flake yet.
                  </div>
                )}
              </div>

              <div className="rounded-3xl border border-border/70 bg-card/50 p-6">
                <h2 className="text-sm font-semibold tracking-wide text-foreground">Resolution</h2>
                <dl className="mt-4 space-y-4">
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                      Source
                    </dt>
                    <dd className="mt-1 text-sm text-foreground">{sourceLabel}</dd>
                  </div>
                  <div>
                    <dt className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground/70">
                      Flake path
                    </dt>
                    <dd className="mt-1 break-all text-sm text-muted-foreground">{flakePath}</dd>
                  </div>
                </dl>
              </div>
            </section>

            {diagnostics.length > 0 ? (
              <section className="rounded-3xl border border-amber-500/30 bg-amber-500/8 p-6">
                <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                  <AlertCircleIcon className="size-4 text-amber-600" />
                  Diagnostics
                </div>
                <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
                  {diagnostics.map((diagnostic) => (
                    <li key={diagnostic} className="rounded-2xl bg-background/55 px-4 py-3">
                      {diagnostic}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/$environmentId/flake/$projectId")({
  component: FlakeOverviewRouteView,
});
