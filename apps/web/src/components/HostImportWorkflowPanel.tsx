import {
  type EnvironmentId,
  type HostCreationWorkflow,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  buildHostImportFindingsPrompt,
  resolveHostCreationBootstrapMode,
} from "@t3tools/shared/hostWorkflow";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { readEnvironmentApi } from "../environmentApi";
import { hostImportQueryOptions, projectQueryKeys } from "../lib/projectReactQuery";
import { cn } from "../lib/utils";
import HostImportTerminal from "./HostImportTerminal";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Spinner } from "./ui/spinner";

function formatHostImportStatusLabel(
  status:
    | "idle"
    | "starting"
    | "running"
    | "awaiting-ssh-password"
    | "awaiting-sudo-password"
    | "completed"
    | "failed"
    | "canceled",
): string {
  switch (status) {
    case "idle":
      return "Idle";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "awaiting-ssh-password":
      return "Awaiting SSH password";
    case "awaiting-sudo-password":
      return "Awaiting sudo password";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
  }
}

function hostImportStatusClasses(
  status:
    | "idle"
    | "starting"
    | "running"
    | "awaiting-ssh-password"
    | "awaiting-sudo-password"
    | "completed"
    | "failed"
    | "canceled",
): string {
  switch (status) {
    case "starting":
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "awaiting-ssh-password":
    case "awaiting-sudo-password":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "failed":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "canceled":
      return "border-border bg-muted/40 text-muted-foreground";
    case "idle":
    default:
      return "border-border bg-muted/40 text-muted-foreground";
  }
}

interface HostImportSecretPromptProps {
  label: "SSH password" | "Remote sudo password";
  submitLabel: "Submit SSH password" | "Submit sudo password";
  pending: boolean;
  onSubmit: (secret: string) => Promise<void>;
}

function HostImportSecretPrompt({
  label,
  submitLabel,
  pending,
  onSubmit,
}: HostImportSecretPromptProps) {
  const [secret, setSecret] = useState("");

  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/70 p-3"
      onSubmit={(event) => {
        event.preventDefault();
        const nextSecret = secret;
        setSecret("");
        void onSubmit(nextSecret).catch(() => {
          setSecret(nextSecret);
        });
      }}
    >
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-foreground">{label}</span>
        <Input
          type="password"
          autoComplete="current-password"
          value={secret}
          onChange={(event) => setSecret(event.target.value)}
          placeholder={label}
        />
        <span className="text-xs text-muted-foreground">
          This stays in the secure import flow and is not sent to the agent.
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={pending || secret.length === 0}>
          {pending ? (
            <>
              <Spinner className="mr-1 size-3.5" />
              Submitting…
            </>
          ) : (
            submitLabel
          )}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => setSecret("")}>
          Clear
        </Button>
      </div>
    </form>
  );
}

interface HostImportWorkflowPanelProps {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
  workflow: HostCreationWorkflow;
  projectCwd: string;
  onContinueWithFindings: (message: string) => Promise<void>;
  onError: (message: string | null) => void;
}

export default function HostImportWorkflowPanel({
  environmentId,
  projectId,
  threadId,
  workflow,
  projectCwd,
  onContinueWithFindings,
  onError,
}: HostImportWorkflowPanelProps) {
  const api = readEnvironmentApi(environmentId);
  const queryClient = useQueryClient();
  const [startPending, setStartPending] = useState(false);
  const [cancelPending, setCancelPending] = useState(false);
  const [submitPending, setSubmitPending] = useState(false);

  const hostImportQuery = useQuery({
    ...hostImportQueryOptions({
      environmentId,
      projectId,
      threadId,
      enabled: resolveHostCreationBootstrapMode(workflow.bootstrapMode) === "existing-via-ssh",
    }),
    refetchInterval: 1_500,
  });

  const summary = hostImportQuery.data ?? null;
  const canStart =
    api !== undefined &&
    !startPending &&
    !cancelPending &&
    !submitPending &&
    (summary === null ||
      summary.status === "failed" ||
      summary.status === "canceled" ||
      summary.status === "completed");
  const canCancel =
    api !== undefined &&
    !startPending &&
    !cancelPending &&
    !submitPending &&
    (summary?.status === "starting" || summary?.status === "running");

  const terminalResetKey = useMemo(
    () =>
      summary === null
        ? `host-import:${threadId}:empty`
        : `host-import:${threadId}:${summary.updatedAt}:${summary.status}`,
    [summary, threadId],
  );

  const invalidateSummary = useCallback(async () => {
    await queryClient.invalidateQueries({
      queryKey: projectQueryKeys.hostImport(environmentId, projectId, threadId),
    });
  }, [environmentId, projectId, queryClient, threadId]);

  const handleStart = useCallback(async () => {
    if (!api) {
      onError("Host import API is unavailable.");
      return;
    }
    setStartPending(true);
    onError(null);
    try {
      await api.hostImports.start({ projectId, threadId });
      await invalidateSummary();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to start secure host analysis.");
    } finally {
      setStartPending(false);
    }
  }, [api, invalidateSummary, onError, projectId, threadId]);

  const handleCancel = useCallback(async () => {
    if (!api) {
      onError("Host import API is unavailable.");
      return;
    }
    setCancelPending(true);
    onError(null);
    try {
      await api.hostImports.cancel({ projectId, threadId });
      await invalidateSummary();
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to cancel secure host analysis.");
    } finally {
      setCancelPending(false);
    }
  }, [api, invalidateSummary, onError, projectId, threadId]);

  const handleSubmitSecret = useCallback(
    async (phase: "ssh-login" | "remote-sudo", secret: string) => {
      if (!api) {
        onError("Host import API is unavailable.");
        return;
      }
      setSubmitPending(true);
      onError(null);
      try {
        await api.hostImports.submitSecret({
          projectId,
          threadId,
          phase,
          secret,
        });
        await invalidateSummary();
      } catch (error) {
        onError(error instanceof Error ? error.message : "Failed to submit secure password.");
        throw error;
      } finally {
        setSubmitPending(false);
      }
    },
    [api, invalidateSummary, onError, projectId, threadId],
  );

  const handleContinue = useCallback(async () => {
    if (!summary?.findingsSummary) {
      return;
    }
    onError(null);
    try {
      await onContinueWithFindings(
        buildHostImportFindingsPrompt(workflow, summary.findingsSummary),
      );
    } catch (error) {
      onError(error instanceof Error ? error.message : "Failed to continue with import findings.");
    }
  }, [onContinueWithFindings, onError, summary?.findingsSummary, workflow]);

  const lastError =
    hostImportQuery.error instanceof Error
      ? hostImportQuery.error.message
      : (summary?.lastError ?? null);

  return (
    <section className="border-b border-border/70 bg-card/20 px-3 py-3 sm:px-5">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
        <div className="rounded-xl border border-border/70 bg-card/60 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">Secure host import</Badge>
                <Badge variant="outline">Host: {workflow.hostName}</Badge>
                <Badge variant="outline">{workflow.sourceSshTarget ?? "SSH target missing"}</Badge>
                {summary ? (
                  <span
                    className={cn(
                      "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                      hostImportStatusClasses(summary.status),
                    )}
                  >
                    {formatHostImportStatusLabel(summary.status)}
                  </span>
                ) : null}
              </div>
              <p className="text-sm text-muted-foreground">
                Start secure SSH analysis outside the agent terminal, review the sanitized findings,
                then continue the Nix translation from there. Key-based auth stays preferred, but
                password fallback happens here instead of chat.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => void handleStart()} disabled={!canStart}>
                {startPending ? (
                  <>
                    <Spinner className="mr-1 size-3.5" />
                    Starting…
                  </>
                ) : summary === null ? (
                  "Start secure analysis"
                ) : summary.status === "completed" ? (
                  "Re-run analysis"
                ) : (
                  "Restart analysis"
                )}
              </Button>
              {canCancel ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleCancel()}
                  disabled={!canCancel}
                >
                  {cancelPending ? (
                    <>
                      <Spinner className="mr-1 size-3.5" />
                      Canceling…
                    </>
                  ) : (
                    "Cancel"
                  )}
                </Button>
              ) : null}
              {summary?.status === "completed" && summary.findingsSummary ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void handleContinue()}
                  disabled={startPending || cancelPending || submitPending}
                >
                  Continue with findings
                </Button>
              ) : null}
            </div>
          </div>

          {lastError ? (
            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {lastError}
            </div>
          ) : null}

          {summary?.status === "awaiting-ssh-password" ? (
            <div className="mt-3">
              <HostImportSecretPrompt
                label="SSH password"
                submitLabel="Submit SSH password"
                pending={submitPending}
                onSubmit={(secret) => handleSubmitSecret("ssh-login", secret)}
              />
            </div>
          ) : null}

          {summary?.status === "awaiting-sudo-password" ? (
            <div className="mt-3">
              <HostImportSecretPrompt
                label="Remote sudo password"
                submitLabel="Submit sudo password"
                pending={submitPending}
                onSubmit={(secret) => handleSubmitSecret("remote-sudo", secret)}
              />
            </div>
          ) : null}

          {summary ? (
            <div className="mt-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                  Secure analysis log
                </p>
                {hostImportQuery.isFetching ? <Spinner className="size-3.5" /> : null}
              </div>
              <div className="h-72 overflow-hidden rounded-lg border border-border/70 bg-background/70">
                <HostImportTerminal
                  key={terminalResetKey}
                  environmentId={environmentId}
                  projectId={projectId}
                  threadId={threadId}
                  cwd={projectCwd}
                  onSessionExited={() => {
                    void invalidateSummary();
                  }}
                />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
