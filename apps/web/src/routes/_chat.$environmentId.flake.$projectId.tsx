import {
  buildDeployRsCommand,
  type DeploymentCheck,
  type DeploymentPostflightReport,
  type DeploymentPreflightReport,
  type FleetDeploymentHostStatus,
  type FleetDeploymentStatus,
  type FlakeHost,
  type FlakeMaintenanceStatus,
  type GitStatusResult,
  type HostSecretInventory,
  type HostCreationWorkflowBootstrapMode,
  type HostDriftAuthPhase,
  type HostDriftCategory,
  type HostDriftCategoryResult,
  type HostDriftReconcileIntent,
  type HostDriftStatus,
  type HostDriftSummary,
  type HostDeploymentStatus,
  type HostDocumentationStatus,
  type NixIndexStatus,
  type ProjectDashboardChangeEntry,
  type SecretValidationCheck,
  type SecretsProviderKind,
} from "@t3tools/contracts";
import { scopedProjectKey } from "@t3tools/client-runtime";
import {
  isValidHostCreationHostName,
  normalizeHostCreationHostName,
  resolveHostCreationTarget,
} from "@t3tools/shared/hostWorkflow";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  AlertCircleIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BookOpenIcon,
  EllipsisIcon,
  FileTextIcon,
  InboxIcon,
  KeyRoundIcon,
  LoaderIcon,
  LockKeyholeIcon,
  PlayIcon,
  RefreshCcwIcon,
  RocketIcon,
  ShieldCheckIcon,
  SquareTerminalIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { openInPreferredEditor } from "../editorPreferences";
import ChatMarkdown from "../components/ChatMarkdown";
import FlakeMaintenanceTerminal from "../components/FlakeMaintenanceTerminal";
import GitActionsControl from "../components/GitActionsControl";
import HostDeploymentTerminal from "../components/HostDeploymentTerminal";
import HostDriftTerminal from "../components/HostDriftTerminal";
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
import { Input } from "../components/ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../components/ui/menu";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";
import { toastManager } from "../components/ui/toast";
import { readEnvironmentApi } from "../environmentApi";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import {
  resolvePendingHostDocGeneration,
  type PendingHostDocGeneration,
} from "../lib/flakeDashboardHostDocumentationGeneration";
import { refreshGitStatus, useGitStatus } from "../lib/gitStatusState";
import {
  fleetDeploymentQueryOptions,
  flakeMaintenanceQueryOptions,
  hostDriftQueryOptions,
  hostDeploymentQueryOptions,
  hostDeploymentPreviewQueryOptions,
  projectDashboardContentQueryOptions,
  projectSecretsSummaryQueryOptions,
  projectQueryKeys,
  setProjectDashboardNixDesignerQueryData,
} from "../lib/projectReactQuery";
import { ensureLocalApi } from "../localApi";
import { cn } from "../lib/utils";
import {
  buildFlakeDashboardHostMenu,
  runFlakeDashboardHostMenuAction,
} from "./flakeDashboardHostMenu";
import { selectEnvironmentState, useStore } from "../store";
import { createProjectSelectorByRef } from "../storeSelectors";
import { useUiStateStore } from "../uiStateStore";
import {
  buildFlakeRouteParams,
  buildThreadRouteParams,
  resolveFlakeRouteRef,
} from "../threadRoutes";

export interface FlakeDashboardSearch {
  host?: string;
  view?: "changes" | "deploy" | "doc" | "drift" | "flake" | "maintenance" | "rollout" | "secrets";
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
    view === "drift" ||
    view === "flake" ||
    view === "maintenance" ||
    view === "rollout" ||
    view === "secrets"
  ) {
    next.view = view;
  }
  return next;
}

type FlakeDashboardView =
  | "changes"
  | "deploy"
  | "doc"
  | "drift"
  | "flake"
  | "maintenance"
  | "rollout"
  | "secrets";
const DEPLOY_RS_DEFAULT_CONFIRM_TIMEOUT_SECONDS = 30;
const DEFAULT_ROLLOUT_MAX_PARALLELISM = 1;
const HOST_DRIFT_CATEGORY_ORDER: ReadonlyArray<HostDriftCategory> = [
  "identity",
  "system",
  "users",
  "enabledServices",
  "firewallPorts",
];

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
    if (input.view === "drift") {
      return { host: input.hostName, view: "drift" };
    }
    return { host: input.hostName };
  }

  if (input.view === "flake") {
    return { view: "flake" };
  }
  if (input.view === "maintenance") {
    return { view: "maintenance" };
  }
  if (input.view === "rollout") {
    return { view: "rollout" };
  }
  if (input.view === "secrets") {
    return { view: "secrets" };
  }
  return {};
}

function formatDocumentationStatusLabel(
  status: HostDocumentationStatus | null | undefined,
): string {
  switch (status) {
    case "generating":
      return "Generating";
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
    case "generating":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
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

function formatNixDesignerStatusLabel(status: NixIndexStatus | null | undefined): string {
  switch (status) {
    case "ready":
      return "Ready";
    case "building":
      return "Building";
    case "stale":
      return "Stale";
    case "error":
      return "Error";
    case "missing":
    default:
      return "Missing";
  }
}

function nixDesignerStatusClasses(status: NixIndexStatus | null | undefined): string {
  switch (status) {
    case "ready":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "building":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "stale":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "error":
      return "border-destructive/30 bg-destructive/10 text-destructive";
    case "missing":
    default:
      return "border-border/70 bg-background/70 text-muted-foreground";
  }
}

function describeNixDesignerRebuildFailure(input: {
  status: NixIndexStatus | null | undefined;
  lastError: string | null | undefined;
  staleReason: string | null | undefined;
}): string {
  if (input.lastError) {
    return input.lastError;
  }
  if (input.status === "stale" && input.staleReason) {
    return `The index is still stale: ${input.staleReason}.`;
  }
  if (input.status === "missing") {
    return "The index files were not created.";
  }
  return "The index build did not complete successfully.";
}

function formatShortRevision(revision: string | null | undefined): string | null {
  const trimmed = revision?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.slice(0, 12) : null;
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
  status:
    | FleetDeploymentHostStatus
    | FleetDeploymentStatus
    | HostDeploymentStatus
    | FlakeMaintenanceStatus,
): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "skipped":
      return "Skipped";
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

function deploymentStatusClasses(
  status:
    | FleetDeploymentHostStatus
    | FleetDeploymentStatus
    | HostDeploymentStatus
    | FlakeMaintenanceStatus,
): string {
  switch (status) {
    case "queued":
      return "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
    case "starting":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "skipped":
      return "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
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

function formatActivationStrategyLabel(strategy: "switch" | "boot"): string {
  return strategy === "boot" ? "Stage For Reboot" : "Switch Live Now";
}

function formatDriftStatusLabel(status: HostDriftStatus): string {
  switch (status) {
    case "idle":
      return "Needs input";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "canceled":
      return "Canceled";
    case "error":
    default:
      return "Error";
  }
}

function driftStatusClasses(status: HostDriftStatus): string {
  switch (status) {
    case "idle":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "starting":
      return "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300";
    case "running":
      return "border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300";
    case "completed":
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

function isActiveHostDriftStatusValue(status: HostDriftStatus | null | undefined): boolean {
  return status === "starting" || status === "running";
}

function formatHostDriftAuthPhaseLabel(phase: HostDriftAuthPhase): string {
  return phase === "remote-sudo" ? "Remote sudo password" : "SSH login password";
}

function formatHostDriftCategoryLabel(category: HostDriftCategory): string {
  switch (category) {
    case "identity":
      return "Identity";
    case "system":
      return "System";
    case "users":
      return "Users";
    case "enabledServices":
      return "Enabled services";
    case "firewallPorts":
      return "Firewall ports";
  }
}

function hostDriftCategoryStatusClasses(status: HostDriftCategoryResult["status"]): string {
  switch (status) {
    case "match":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "drift":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
    case "unknown":
    default:
      return "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
  }
}

function formatHostDriftCategoryStatusLabel(status: HostDriftCategoryResult["status"]): string {
  switch (status) {
    case "match":
      return "Match";
    case "drift":
      return "Drift";
    case "unknown":
    default:
      return "Unknown";
  }
}

function formatDriftValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "Unavailable";
  }
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function describeHostDriftSummary(summary: HostDriftSummary | null | undefined): string {
  if (!summary) {
    return "Run a drift scan to compare the flake with the live host.";
  }
  if (summary.awaitingAuthPhase) {
    return `${formatHostDriftAuthPhaseLabel(summary.awaitingAuthPhase)} is required to continue the scan.`;
  }
  switch (summary.status) {
    case "starting":
      return "Preparing the drift scan and opening the terminal session.";
    case "running":
      return "Collecting live host state and comparing it against the flake.";
    case "completed":
      return `Compared ${summary.categoryResults.length} categories against the live host.`;
    case "failed":
      return summary.lastError ?? "The drift scan failed.";
    case "canceled":
      return "The drift scan was canceled.";
    case "error":
      return summary.lastError ?? "The drift scan stopped unexpectedly.";
    case "idle":
    default:
      return summary.lastError ?? "The drift scan is waiting for input.";
  }
}

function orderHostDriftCategoryResults(
  results: ReadonlyArray<HostDriftCategoryResult>,
): ReadonlyArray<HostDriftCategoryResult> {
  const rank = new Map(
    HOST_DRIFT_CATEGORY_ORDER.map((category, index) => [category, index] as const),
  );
  return [...results].toSorted(
    (left, right) =>
      (rank.get(left.category) ?? Number.MAX_SAFE_INTEGER) -
      (rank.get(right.category) ?? Number.MAX_SAFE_INTEGER),
  );
}

function formatSecretsProviderLabel(provider: SecretsProviderKind): string {
  return provider === "sops-nix" ? "sops-nix" : "No provider";
}

function secretValidationResultClasses(result: SecretValidationCheck["result"]): string {
  switch (result) {
    case "pass":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
    case "fail":
      return "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300";
    case "skipped":
    default:
      return "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300";
  }
}

function formatSecretValidationResultLabel(result: SecretValidationCheck["result"]): string {
  switch (result) {
    case "pass":
      return "Pass";
    case "fail":
      return "Fail";
    case "skipped":
    default:
      return "Skipped";
  }
}

function countFailingSecretChecks(inventory: HostSecretInventory): number {
  return inventory.validationChecks.filter((check) => check.result === "fail").length;
}

function describeProjectSecretsSummary(
  hostInventories: ReadonlyArray<HostSecretInventory>,
  provider: SecretsProviderKind | null,
): string {
  if (provider !== "sops-nix") {
    return "Inspect sops-nix inventory and validation state for this flake.";
  }
  const secretCount = hostInventories.reduce((sum, inventory) => sum + inventory.secretCount, 0);
  const failingChecks = hostInventories.reduce(
    (sum, inventory) => sum + countFailingSecretChecks(inventory),
    0,
  );
  if (failingChecks > 0) {
    return `${secretCount} declared secrets with ${failingChecks} validation issue${failingChecks === 1 ? "" : "s"}.`;
  }
  return `${secretCount} declared secrets across ${hostInventories.length} host${hostInventories.length === 1 ? "" : "s"}.`;
}

function deploymentCheckClasses(check: DeploymentCheck): string {
  if (check.result === "pass") {
    return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  }
  if (check.result === "warn") {
    return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  }
  if (check.result === "fail") {
    return check.severity === "blocking"
      ? "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300"
      : "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300";
  }
  return "border-border/60 bg-background/60 text-muted-foreground";
}

function formatDeploymentCheckResultLabel(check: DeploymentCheck): string {
  switch (check.result) {
    case "pass":
      return "Pass";
    case "warn":
      return "Warning";
    case "fail":
      return check.severity === "blocking" ? "Blocked" : "Failed";
    case "skipped":
    default:
      return "Skipped";
  }
}

function findFirstDeploymentAttentionSummary(
  report: DeploymentPreflightReport | DeploymentPostflightReport | null | undefined,
): string | null {
  if (!report) {
    return null;
  }
  return (
    report.checks.find((check) => check.result === "fail")?.summary ??
    report.checks.find((check) => check.result === "warn")?.summary ??
    null
  );
}

function DeploymentReportCard(props: {
  title: string;
  report: DeploymentPreflightReport | DeploymentPostflightReport | null | undefined;
  emptyMessage: string;
  showProceedState?: boolean;
}) {
  if (!props.report) {
    return (
      <div className="rounded-xl border border-border/50 bg-background/50 p-3 text-sm text-muted-foreground">
        {props.emptyMessage}
      </div>
    );
  }

  const preflight = "canProceed" in props.report ? props.report : null;

  return (
    <div className="rounded-xl border border-border/50 bg-background/50 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="text-sm font-medium text-foreground">{props.title}</div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {formatActivationStrategyLabel(props.report.activationStrategy)} • Updated{" "}
            {formatTimestamp(props.report.updatedAt)}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {props.showProceedState && preflight ? (
            <span
              className={cn(
                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                preflight.canProceed
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                  : "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
              )}
            >
              {preflight.canProceed ? "Ready" : "Needs action"}
            </span>
          ) : null}
          {preflight?.warningCount ? (
            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
              {preflight.warningCount} warning{preflight.warningCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {preflight?.blockingFailureCount ? (
            <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300">
              {preflight.blockingFailureCount} blocked
            </span>
          ) : null}
        </div>
      </div>
      <div className="mt-3 grid gap-2">
        {props.report.checks.map((check) => (
          <div
            key={`${check.code}:${check.label}`}
            className="rounded-lg border border-border/50 bg-background/60 p-3"
          >
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="text-sm font-medium text-foreground">{check.label}</div>
                <div className="mt-1 text-sm text-foreground">{check.summary}</div>
              </div>
              <span
                className={cn(
                  "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                  deploymentCheckClasses(check),
                )}
              >
                {formatDeploymentCheckResultLabel(check)}
              </span>
            </div>
            {check.detail ? (
              <div className="mt-2 rounded-lg bg-muted/70 px-2.5 py-2 text-xs text-muted-foreground">
                {check.detail}
              </div>
            ) : null}
            {check.recommendedAction === "use-boot-activation" ? (
              <div className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                Recommended action: stage this deployment for the next reboot instead of switching
                live.
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}

function parseConfirmTimeoutSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function parseRolloutMaxParallelism(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return DEFAULT_ROLLOUT_MAX_PARALLELISM;
  }

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 5) {
    return null;
  }

  return parsed;
}

function isActiveFleetDeploymentStatusValue(
  status: FleetDeploymentStatus | null | undefined,
): boolean {
  return status === "starting" || status === "running";
}

function sameStringArray(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
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
  const projectUiKey = projectRef ? scopedProjectKey(projectRef) : null;
  const search = Route.useSearch();
  const bootstrapComplete = useStore(
    (store) => selectEnvironmentState(store, projectRef?.environmentId ?? null).bootstrapComplete,
  );
  const environmentHasProjects = useStore(
    (store) =>
      selectEnvironmentState(store, projectRef?.environmentId ?? null).projectIds.length > 0,
  );
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const nixDesignerEnabled = useUiStateStore((store) =>
    projectUiKey ? (store.nixDesignerEnabledByProjectKey[projectUiKey] ?? false) : false,
  );
  const setProjectNixDesignerEnabled = useUiStateStore(
    (store) => store.setProjectNixDesignerEnabled,
  );
  const { handleNewThread } = useNewThreadHandler();
  const [pendingDocGenerationsByHost, setPendingDocGenerationsByHost] = useState<
    Record<string, PendingHostDocGeneration>
  >({});
  const [createHostDialogOpen, setCreateHostDialogOpen] = useState(false);
  const [createHostName, setCreateHostName] = useState("");
  const [createHostBootstrapMode, setCreateHostBootstrapMode] =
    useState<HostCreationWorkflowBootstrapMode>("new-host");
  const [createHostSourceSshTarget, setCreateHostSourceSshTarget] = useState("");
  const [createHostTarget, setCreateHostTarget] = useState("");
  const [createHostOsFamily, setCreateHostOsFamily] = useState<"nixos" | "darwin">("nixos");
  const [createHostType, setCreateHostType] = useState("");
  const [deployDialogHostName, setDeployDialogHostName] = useState<string | null>(null);
  const [deployingHostName, setDeployingHostName] = useState<string | null>(null);
  const [nixDesignerRebuildPending, setNixDesignerRebuildPending] = useState(false);
  const [maintenancePending, setMaintenancePending] = useState(false);
  const [deployOnServer, setDeployOnServer] = useState(false);
  const [deployActivationStrategy, setDeployActivationStrategy] = useState<"switch" | "boot">(
    "switch",
  );
  const [deployMagicRollback, setDeployMagicRollback] = useState(true);
  const [deployAcknowledgeWarnings, setDeployAcknowledgeWarnings] = useState(false);
  const [deployConfirmTimeoutSecondsInput, setDeployConfirmTimeoutSecondsInput] = useState("");
  const [rolloutSelectedHostNames, setRolloutSelectedHostNames] = useState<string[]>([]);
  const [rolloutSelectionInitialized, setRolloutSelectionInitialized] = useState(false);
  const [rolloutPending, setRolloutPending] = useState(false);
  const [rolloutDeployOnServer, setRolloutDeployOnServer] = useState(false);
  const [rolloutActivationStrategy, setRolloutActivationStrategy] = useState<"switch" | "boot">(
    "switch",
  );
  const [rolloutMagicRollback, setRolloutMagicRollback] = useState(true);
  const [rolloutAcknowledgeWarnings, setRolloutAcknowledgeWarnings] = useState(false);
  const [rolloutConfirmTimeoutSecondsInput, setRolloutConfirmTimeoutSecondsInput] = useState("");
  const [rolloutMaxParallelismInput, setRolloutMaxParallelismInput] = useState(
    String(DEFAULT_ROLLOUT_MAX_PARALLELISM),
  );
  const [rolloutPreflightRequested, setRolloutPreflightRequested] = useState(false);
  const [driftPending, setDriftPending] = useState(false);
  const [driftSecretInput, setDriftSecretInput] = useState("");
  const [driftSecretPending, setDriftSecretPending] = useState(false);
  const [driftReconcilePendingIntent, setDriftReconcilePendingIntent] =
    useState<HostDriftReconcileIntent | null>(null);
  const gitStatusQuery = useGitStatus({
    environmentId: projectRef?.environmentId ?? null,
    cwd: project?.cwd ?? null,
  });
  const routeEnvironmentId = projectRef?.environmentId ?? null;
  const routeProjectId = project?.id ?? null;
  const designerScope = useMemo(
    () => (nixDesignerEnabled ? ({ kind: "project" } as const) : null),
    [nixDesignerEnabled],
  );
  const previousDashboardViewRef = useRef<FlakeDashboardView | undefined>(search.view);

  const resetDeployDialogOptions = useCallback(() => {
    setDeployOnServer(false);
    setDeployActivationStrategy("switch");
    setDeployMagicRollback(true);
    setDeployAcknowledgeWarnings(false);
    setDeployConfirmTimeoutSecondsInput("");
  }, []);

  const resetRolloutOptions = useCallback(() => {
    setRolloutDeployOnServer(false);
    setRolloutActivationStrategy("switch");
    setRolloutMagicRollback(true);
    setRolloutAcknowledgeWarnings(false);
    setRolloutConfirmTimeoutSecondsInput("");
    setRolloutMaxParallelismInput(String(DEFAULT_ROLLOUT_MAX_PARALLELISM));
  }, []);

  useEffect(() => {
    setDeployAcknowledgeWarnings(false);
  }, [
    deployActivationStrategy,
    deployConfirmTimeoutSecondsInput,
    deployDialogHostName,
    deployMagicRollback,
    deployOnServer,
  ]);

  useEffect(() => {
    setRolloutAcknowledgeWarnings(false);
  }, [
    rolloutActivationStrategy,
    rolloutConfirmTimeoutSecondsInput,
    rolloutMagicRollback,
    rolloutMaxParallelismInput,
    rolloutDeployOnServer,
    rolloutSelectedHostNames,
  ]);

  useEffect(() => {
    setRolloutPreflightRequested(false);
    if (routeEnvironmentId === null || routeProjectId === null) {
      return;
    }
    queryClient.removeQueries({
      queryKey: projectQueryKeys.hostDeploymentPreviewPrefix(routeEnvironmentId, routeProjectId),
    });
  }, [
    queryClient,
    routeEnvironmentId,
    routeProjectId,
    rolloutActivationStrategy,
    rolloutConfirmTimeoutSecondsInput,
    rolloutDeployOnServer,
    rolloutMagicRollback,
    rolloutMaxParallelismInput,
    rolloutSelectedHostNames,
  ]);

  useEffect(() => {
    const previousView = previousDashboardViewRef.current;
    previousDashboardViewRef.current = search.view;
    if (previousView === search.view) {
      return;
    }
    if (search.view !== "rollout" && previousView !== "rollout") {
      return;
    }
    setRolloutPreflightRequested(false);
    if (routeEnvironmentId === null || routeProjectId === null) {
      return;
    }
    queryClient.removeQueries({
      queryKey: projectQueryKeys.hostDeploymentPreviewPrefix(routeEnvironmentId, routeProjectId),
    });
  }, [queryClient, routeEnvironmentId, routeProjectId, search.view]);

  useEffect(() => {
    setRolloutSelectedHostNames([]);
    setRolloutSelectionInitialized(false);
    setRolloutPending(false);
    setRolloutPreflightRequested(false);
    resetRolloutOptions();
  }, [project?.id, resetRolloutOptions]);

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
    if (!projectRef || search.view !== "drift" || requestedHostName !== null) {
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

  useEffect(() => {
    if (!projectRef || search.view !== "rollout" || requestedHostName === null) {
      return;
    }
    void navigate({
      to: "/$environmentId/flake/$projectId",
      params: buildFlakeRouteParams(projectRef),
      search: { view: "rollout" },
      replace: true,
    });
  }, [navigate, projectRef, requestedHostName, search.view]);

  useEffect(() => {
    if (!projectRef || search.view !== "secrets" || requestedHostName === null) {
      return;
    }
    void navigate({
      to: "/$environmentId/flake/$projectId",
      params: buildFlakeRouteParams(projectRef),
      search: { view: "secrets" },
      replace: true,
    });
  }, [navigate, projectRef, requestedHostName, search.view]);

  const hasPendingDocGenerations = Object.keys(pendingDocGenerationsByHost).length > 0;
  const dashboardQuery = useQuery({
    ...projectDashboardContentQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      hostName: matchedRouteHostName ?? requestedHostName,
      enabled: bootstrapComplete && projectRef !== null && project !== null,
    }),
    refetchInterval: hasPendingDocGenerations ? 2_000 : false,
  });
  const projectSecretsQuery = useQuery(
    projectSecretsSummaryQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      enabled:
        bootstrapComplete &&
        projectRef !== null &&
        project !== null &&
        search.view === "secrets" &&
        requestedHostName === null,
    }),
  );

  const hostDeploymentQuery = useQuery({
    ...hostDeploymentQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      hostName: matchedRouteHostName ?? requestedHostName,
      enabled:
        bootstrapComplete &&
        projectRef !== null &&
        project !== null &&
        (matchedRouteHostName ?? requestedHostName) !== null,
    }),
    refetchInterval: search.view === "deploy" ? 2_000 : false,
  });

  const hostDriftQuery = useQuery({
    ...hostDriftQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      hostName: matchedRouteHostName ?? requestedHostName,
      enabled:
        bootstrapComplete &&
        projectRef !== null &&
        project !== null &&
        (matchedRouteHostName ?? requestedHostName) !== null &&
        search.view === "drift",
    }),
    refetchInterval: search.view === "drift" ? 2_000 : false,
  });

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

  const fleetDeploymentQuery = useQuery({
    ...fleetDeploymentQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      enabled: bootstrapComplete && projectRef !== null && project !== null,
    }),
    refetchInterval: search.view === "rollout" ? 2_000 : false,
  });

  const deployDialogPreviewQuery = useQuery(
    hostDeploymentPreviewQueryOptions({
      environmentId: projectRef?.environmentId ?? null,
      projectId: project?.id ?? null,
      hostName: deployDialogHostName,
      activationStrategy: deployActivationStrategy,
      deployOnServer,
      magicRollback: deployMagicRollback,
      confirmTimeoutSeconds: deployMagicRollback
        ? parseConfirmTimeoutSeconds(deployConfirmTimeoutSecondsInput)
        : null,
      acknowledgeWarnings: deployAcknowledgeWarnings,
      enabled:
        bootstrapComplete &&
        projectRef !== null &&
        project !== null &&
        deployDialogHostName !== null &&
        (!deployMagicRollback ||
          deployConfirmTimeoutSecondsInput.trim().length === 0 ||
          parseConfirmTimeoutSeconds(deployConfirmTimeoutSecondsInput) !== null),
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

  useEffect(() => {
    if (!dashboardQuery.data || Object.keys(pendingDocGenerationsByHost).length === 0) {
      return;
    }

    const settledHosts: string[] = [];
    for (const [hostName, pending] of Object.entries(pendingDocGenerationsByHost)) {
      const summary =
        dashboardQuery.data.hostSummaries.find((entry) => entry.host.name === hostName) ?? null;
      const resolution = resolvePendingHostDocGeneration({
        pending,
        summary,
        dataUpdatedAt: dashboardQuery.dataUpdatedAt,
        now: Date.now(),
      });
      if (resolution.kind === "pending") {
        continue;
      }

      toastManager.add({
        type: resolution.kind === "succeeded" ? "success" : "error",
        title:
          resolution.kind === "succeeded"
            ? `Documentation generated for ${hostName}`
            : `Failed to generate ${hostName} documentation`,
        description:
          resolution.kind === "succeeded"
            ? `Updated ${resolution.docPath}`
            : "The background generation job finished without writing a new document.",
      });
      settledHosts.push(hostName);
    }

    if (settledHosts.length === 0) {
      return;
    }

    setPendingDocGenerationsByHost((current) => {
      const next = { ...current };
      for (const hostName of settledHosts) {
        delete next[hostName];
      }
      return next;
    });
  }, [dashboardQuery.data, dashboardQuery.dataUpdatedAt, pendingDocGenerationsByHost]);

  const availableRolloutHostNames = useMemo(
    () => (dashboardQuery.data?.hostSummaries ?? []).map((summary) => summary.host.name),
    [dashboardQuery.data?.hostSummaries],
  );
  const rolloutPreviewHostNames = useMemo(
    () =>
      rolloutSelectedHostNames.filter((hostName) => availableRolloutHostNames.includes(hostName)),
    [availableRolloutHostNames, rolloutSelectedHostNames],
  );

  useEffect(() => {
    if (!dashboardQuery.data) {
      return;
    }

    if (!rolloutSelectionInitialized) {
      setRolloutSelectedHostNames(availableRolloutHostNames);
      setRolloutSelectionInitialized(true);
      return;
    }

    setRolloutSelectedHostNames((current) => {
      const allowedHostNames = new Set(availableRolloutHostNames);
      const next = current.filter((hostName) => allowedHostNames.has(hostName));
      return sameStringArray(current, next) ? current : next;
    });
  }, [availableRolloutHostNames, dashboardQuery.data, rolloutSelectionInitialized]);

  const rolloutPreviewQueries = useQueries({
    queries:
      search.view === "rollout" && rolloutPreflightRequested
        ? rolloutPreviewHostNames.map((hostName) => {
            const options = hostDeploymentPreviewQueryOptions({
              environmentId: projectRef?.environmentId ?? null,
              projectId: project?.id ?? null,
              hostName,
              activationStrategy: rolloutActivationStrategy,
              deployOnServer: rolloutDeployOnServer,
              magicRollback: rolloutMagicRollback,
              confirmTimeoutSeconds: rolloutMagicRollback
                ? parseConfirmTimeoutSeconds(rolloutConfirmTimeoutSecondsInput)
                : null,
              acknowledgeWarnings: false,
              enabled:
                bootstrapComplete &&
                projectRef !== null &&
                project !== null &&
                (!rolloutMagicRollback ||
                  rolloutConfirmTimeoutSecondsInput.trim().length === 0 ||
                  parseConfirmTimeoutSeconds(rolloutConfirmTimeoutSecondsInput) !== null),
            });
            return options;
          })
        : [],
  });

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

  const openHostDeployPage = useCallback(
    (hostName: string) => {
      selectDashboardView(hostName, "deploy");
    },
    [selectDashboardView],
  );

  const handleStartThread = useCallback(() => {
    if (!projectRef) {
      return;
    }
    void handleNewThread(projectRef, {
      ...(designerScope ? { designer: designerScope } : {}),
      scopedHostName: null,
      workflow: null,
    });
  }, [designerScope, handleNewThread, projectRef]);

  const handleStartHostThread = useCallback(
    (host: FlakeHost) => {
      if (!projectRef) {
        return;
      }
      void handleNewThread(projectRef, {
        ...(designerScope ? { designer: designerScope } : {}),
        scopedHostName: host.name,
        workflow: null,
      });
    },
    [designerScope, handleNewThread, projectRef],
  );

  const handleRemoveHostThread = useCallback(
    (host: FlakeHost) => {
      if (!projectRef) {
        return;
      }
      void handleNewThread(projectRef, {
        ...(designerScope ? { designer: designerScope } : {}),
        scopedHostName: host.name,
        interactionMode: "plan",
        workflow: {
          kind: "host-removal",
          hostName: host.name,
          target: host.target,
          hostType: host.type ?? null,
          status: "planning",
        },
      });
    },
    [designerScope, handleNewThread, projectRef],
  );

  const existingHostNameSet = useMemo(() => {
    const hostNames = new Set<string>();
    for (const summary of dashboardQuery.data?.hostSummaries ?? []) {
      hostNames.add(normalizeHostCreationHostName(summary.host.name));
    }
    for (const host of project?.flakeMetadata?.hosts ?? []) {
      hostNames.add(normalizeHostCreationHostName(host.name));
    }
    if (project?.flakeMetadata?.host) {
      hostNames.add(normalizeHostCreationHostName(project.flakeMetadata.host.name));
    }
    return hostNames;
  }, [dashboardQuery.data?.hostSummaries, project?.flakeMetadata]);
  const normalizedCreateHostName = normalizeHostCreationHostName(createHostName);
  const createHostNameIsDuplicate =
    normalizedCreateHostName.length > 0 && existingHostNameSet.has(normalizedCreateHostName);
  const createHostNameError =
    normalizedCreateHostName.length === 0
      ? "Host name is required."
      : !isValidHostCreationHostName(normalizedCreateHostName)
        ? "Use lowercase letters, numbers, dots, underscores, or hyphens."
        : createHostNameIsDuplicate
          ? "That host already exists in this flake."
          : null;
  const createHostRequiresSshTarget = createHostBootstrapMode === "existing-via-ssh";
  const normalizedCreateHostSourceSshTarget = createHostSourceSshTarget.trim();
  const createHostSourceSshTargetError =
    createHostRequiresSshTarget && normalizedCreateHostSourceSshTarget.length === 0
      ? "SSH target is required when importing an existing host."
      : null;
  const canCreateHost =
    project !== undefined && (project.flakeMetadata?.source ?? "missing") !== "missing";

  const resetCreateHostForm = useCallback(() => {
    setCreateHostName("");
    setCreateHostBootstrapMode("new-host");
    setCreateHostSourceSshTarget("");
    setCreateHostTarget("");
    setCreateHostOsFamily("nixos");
    setCreateHostType("");
  }, []);

  const handleCreateHostDialogChange = useCallback(
    (open: boolean) => {
      setCreateHostDialogOpen(open);
      if (!open) {
        resetCreateHostForm();
      }
    },
    [resetCreateHostForm],
  );

  const handleCreateHostThread = useCallback(async () => {
    if (!projectRef || !canCreateHost || createHostNameError || createHostSourceSshTargetError) {
      return;
    }

    const hostName = normalizedCreateHostName;
    const target = resolveHostCreationTarget(createHostTarget, hostName);
    await handleNewThread(projectRef, {
      ...(designerScope ? { designer: designerScope } : {}),
      scopedHostName: hostName,
      interactionMode: "plan",
      workflow: {
        kind: "host-creation",
        hostName,
        target,
        osFamily: createHostOsFamily,
        bootstrapMode: createHostBootstrapMode,
        sourceSshTarget:
          createHostBootstrapMode === "existing-via-ssh"
            ? normalizedCreateHostSourceSshTarget || null
            : null,
        hostType: createHostType.trim() || null,
        status: "planning",
      },
    });
    setCreateHostDialogOpen(false);
    resetCreateHostForm();
  }, [
    canCreateHost,
    createHostBootstrapMode,
    createHostNameError,
    createHostOsFamily,
    createHostSourceSshTargetError,
    createHostTarget,
    createHostType,
    handleNewThread,
    normalizedCreateHostSourceSshTarget,
    normalizedCreateHostName,
    designerScope,
    projectRef,
    resetCreateHostForm,
  ]);

  const handleOpenSecretSource = useCallback(
    async (sourcePath: string) => {
      if (!project) {
        return;
      }

      const normalizedPath = sourcePath.trim();
      if (!normalizedPath) {
        return;
      }

      const targetPath = normalizedPath.startsWith("/")
        ? normalizedPath
        : `${project.cwd.replace(/\/+$/, "")}/${normalizedPath.replace(/^\.?\//, "")}`;

      try {
        const api = ensureLocalApi();
        await openInPreferredEditor(api, targetPath);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Failed to open encrypted source file",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [project],
  );

  const invalidateDashboardQueries = useCallback(() => {
    if (!projectRef || !project) {
      return Promise.resolve();
    }
    return Promise.all([
      queryClient.invalidateQueries({
        queryKey: projectQueryKeys.dashboardContentPrefix(projectRef.environmentId, project.id),
      }),
      queryClient.invalidateQueries({
        queryKey: projectQueryKeys.secretsSummary(projectRef.environmentId, project.id),
      }),
    ]);
  }, [project, projectRef, queryClient]);

  const handleRebuildNixDesigner = useCallback(async () => {
    if (!projectRef || !project || nixDesignerRebuildPending) {
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

    setNixDesignerRebuildPending(true);
    try {
      const result = await api.projects.rebuildNixDesignerIndex({
        projectId: project.id,
      });
      setProjectDashboardNixDesignerQueryData(queryClient, {
        environmentId: projectRef.environmentId,
        projectId: project.id,
        nixDesigner: result,
      });
      await invalidateDashboardQueries();
      if (result.status !== "ready") {
        toastManager.add({
          type: "error",
          title: "Failed to rebuild Nix Designer index",
          description: describeNixDesignerRebuildFailure(result),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: "Rebuilt Nix Designer index",
        description: `Indexed nixpkgs ${formatShortRevision(result.revision) ?? result.revision}.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to rebuild Nix Designer index",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setNixDesignerRebuildPending(false);
    }
  }, [invalidateDashboardQueries, nixDesignerRebuildPending, project, projectRef, queryClient]);

  const invalidateHostDeploymentQueries = useCallback(() => {
    if (!projectRef || !project) {
      return Promise.resolve();
    }
    return queryClient.invalidateQueries({
      queryKey: projectQueryKeys.hostDeploymentPrefix(projectRef.environmentId, project.id),
    });
  }, [project, projectRef, queryClient]);

  const invalidateHostDriftQueries = useCallback(() => {
    if (!projectRef || !project) {
      return Promise.resolve();
    }
    return queryClient.invalidateQueries({
      queryKey: projectQueryKeys.hostDriftPrefix(projectRef.environmentId, project.id),
    });
  }, [project, projectRef, queryClient]);

  const invalidateFleetDeploymentQueries = useCallback(() => {
    if (!projectRef || !project) {
      return Promise.resolve();
    }
    return queryClient.invalidateQueries({
      queryKey: projectQueryKeys.fleetDeploymentPrefix(projectRef.environmentId, project.id),
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
      if (
        !projectRef ||
        !project ||
        pendingDocGenerationsByHost[host.name] ||
        dashboardQuery.data?.hostSummaries.some(
          (summary) =>
            summary.host.name === host.name && summary.documentation.status === "generating",
        )
      ) {
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
        const previousGeneratedAt =
          dashboardQuery.data?.hostSummaries.find((summary) => summary.host.name === host.name)
            ?.documentation.generatedAt ?? null;
        const result = await api.projects.generateHostDocumentation({
          projectId: project.id,
          hostName: host.name,
        });
        setPendingDocGenerationsByHost((current) => ({
          ...current,
          [host.name]: {
            baselineDataUpdatedAt: dashboardQuery.dataUpdatedAt,
            previousGeneratedAt,
            queuedAt: result.queuedAt,
          },
        }));
        await invalidateDashboardQueries();
        toastManager.add({
          type: "success",
          title:
            result.status === "already-running"
              ? `Documentation is already generating for ${host.name}`
              : `Documentation generation started for ${host.name}`,
          description: `Writing ${result.docPath} in the background.`,
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to generate ${host.name} documentation`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    },
    [
      dashboardQuery.data?.hostSummaries,
      dashboardQuery.dataUpdatedAt,
      invalidateDashboardQueries,
      pendingDocGenerationsByHost,
      project,
      projectRef,
    ],
  );

  const handleOpenDeployDialog = useCallback(
    (hostName: string) => {
      if (projectRef && project) {
        queryClient.removeQueries({
          queryKey: projectQueryKeys.hostDeploymentPreviewPrefix(
            projectRef.environmentId,
            project.id,
          ),
        });
      }
      resetDeployDialogOptions();
      setDeployDialogHostName(hostName);
    },
    [project, projectRef, queryClient, resetDeployDialogOptions],
  );

  const handleCloseDeployDialog = useCallback(() => {
    if (deployingHostName !== null) {
      return;
    }
    if (projectRef && project) {
      queryClient.removeQueries({
        queryKey: projectQueryKeys.hostDeploymentPreviewPrefix(
          projectRef.environmentId,
          project.id,
        ),
      });
    }
    resetDeployDialogOptions();
    setDeployDialogHostName(null);
  }, [deployingHostName, project, projectRef, queryClient, resetDeployDialogOptions]);

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

    const hasConfirmTimeoutInput = deployConfirmTimeoutSecondsInput.trim().length > 0;
    const confirmTimeoutSeconds = deployMagicRollback
      ? parseConfirmTimeoutSeconds(deployConfirmTimeoutSecondsInput)
      : null;

    if (deployMagicRollback && hasConfirmTimeoutInput && confirmTimeoutSeconds === null) {
      toastManager.add({
        type: "error",
        title: "Invalid confirm timeout",
        description: "Enter a positive number of seconds or leave the field empty.",
      });
      return;
    }

    if (!deployDialogPreviewQuery.data?.report.canProceed) {
      toastManager.add({
        type: "error",
        title: "Deployment checks need attention",
        description:
          findFirstDeploymentAttentionSummary(deployDialogPreviewQuery.data?.report) ??
          "Resolve the blocking checks or acknowledge the warnings before deploying.",
      });
      return;
    }

    setDeployingHostName(hostSummary.host.name);
    try {
      await api.hostDeployments.start({
        projectId: project.id,
        hostName: hostSummary.host.name,
        deployOnServer,
        activationStrategy: deployActivationStrategy,
        magicRollback: deployMagicRollback,
        ...(deployMagicRollback && confirmTimeoutSeconds !== null ? { confirmTimeoutSeconds } : {}),
        ...(deployAcknowledgeWarnings ? { acknowledgeWarnings: true } : {}),
      });

      await Promise.all([invalidateHostDeploymentQueries(), invalidateDashboardQueries()]);
      setDeployDialogHostName(null);
      setDeployingHostName(null);
      resetDeployDialogOptions();

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
    deployDialogPreviewQuery.data,
    deployActivationStrategy,
    deployAcknowledgeWarnings,
    deployConfirmTimeoutSecondsInput,
    deployMagicRollback,
    deployOnServer,
    invalidateDashboardQueries,
    invalidateHostDeploymentQueries,
    navigate,
    project,
    projectRef,
    resetDeployDialogOptions,
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
  const hostSummariesByName = useMemo(
    () =>
      new Map(
        (dashboardQuery.data?.hostSummaries ?? []).map((summary) => [summary.host.name, summary]),
      ),
    [dashboardQuery.data?.hostSummaries],
  );
  const selectedProjectSecrets = projectSecretsQuery.data ?? dashboardQuery.data?.secrets ?? null;
  const projectSecretsHostInventories = useMemo(
    () =>
      selectedProjectSecrets?.provider === "sops-nix"
        ? (selectedProjectSecrets?.hostInventories ?? [])
        : (selectedProjectSecrets?.hostInventories ?? []).filter(
            (inventory) =>
              inventory.secretCount > 0 ||
              inventory.validationChecks.some((check) => check.result === "fail"),
          ),
    [selectedProjectSecrets],
  );
  const nixDesigner = dashboardQuery.data?.nixDesigner ?? null;
  const nixDesignerRevision = formatShortRevision(nixDesigner?.revision);
  const totalProjectSecretCount = useMemo(
    () => projectSecretsHostInventories.reduce((sum, inventory) => sum + inventory.secretCount, 0),
    [projectSecretsHostInventories],
  );
  const totalProjectSecretFailures = useMemo(
    () =>
      projectSecretsHostInventories.reduce(
        (sum, inventory) => sum + countFailingSecretChecks(inventory),
        0,
      ),
    [projectSecretsHostInventories],
  );

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
      if (search.view === "drift") {
        return "drift";
      }
      return "changes";
    }
    if (search.view === "flake") {
      return "flake";
    }
    if (search.view === "maintenance") {
      return "maintenance";
    }
    if (search.view === "rollout") {
      return "rollout";
    }
    if (search.view === "secrets") {
      return "secrets";
    }
    return "changes";
  }, [search.view, selectedHostSummary]);
  const visibleChangeEntries = selectedHostSummary
    ? (dashboardQuery.data?.hostChanges ?? [])
    : (dashboardQuery.data?.generalChanges ?? []);
  const deployDialogCommand =
    deployDialogHostSummary?.deployment.status === "deployable"
      ? buildDeployRsCommand(deployDialogHostSummary.host.name, {
          deployOnServer,
          activationStrategy: deployActivationStrategy,
          magicRollback: deployMagicRollback,
          ...(deployMagicRollback
            ? {
                confirmTimeoutSeconds: parseConfirmTimeoutSeconds(deployConfirmTimeoutSecondsInput),
              }
            : {}),
        })
      : null;
  const deployDialogDisabledReason = deploymentReasonLabel(
    deployDialogHostSummary?.deployment.reason ?? null,
  );
  const deployDialogHasConfirmTimeoutInput = deployConfirmTimeoutSecondsInput.trim().length > 0;
  const deployDialogConfirmTimeoutSeconds = deployMagicRollback
    ? parseConfirmTimeoutSeconds(deployConfirmTimeoutSecondsInput)
    : null;
  const deployDialogConfirmTimeoutInvalid =
    deployMagicRollback &&
    deployDialogHasConfirmTimeoutInput &&
    deployDialogConfirmTimeoutSeconds === null;
  const deployDialogPreviewReport = deployDialogPreviewQuery.data?.report ?? null;
  const deployDialogHasWarnings = (deployDialogPreviewReport?.warningCount ?? 0) > 0;
  const deployDialogCanProceed = deployDialogPreviewReport?.canProceed ?? false;
  const selectedHostDeployment = selectedHostSummary
    ? (hostDeploymentQuery.data ?? selectedHostSummary.latestDeployment ?? null)
    : null;
  const isSelectedHostDeploymentActive =
    selectedHostDeployment?.status === "starting" || selectedHostDeployment?.status === "running";
  const selectedHostDrift = selectedHostSummary
    ? (hostDriftQuery.data ?? selectedHostSummary.latestDrift ?? null)
    : null;
  const orderedSelectedHostDriftCategoryResults = useMemo(
    () => orderHostDriftCategoryResults(selectedHostDrift?.categoryResults ?? []),
    [selectedHostDrift?.categoryResults],
  );
  const selectedHostDriftMatchCount = orderedSelectedHostDriftCategoryResults.filter(
    (result) => result.status === "match",
  ).length;
  const selectedHostDriftMismatchCount = orderedSelectedHostDriftCategoryResults.filter(
    (result) => result.status === "drift",
  ).length;
  const selectedHostDriftUnknownCount = orderedSelectedHostDriftCategoryResults.filter(
    (result) => result.status === "unknown",
  ).length;
  const isSelectedHostDriftActive = isActiveHostDriftStatusValue(selectedHostDrift?.status);
  const selectedFlakeMaintenance =
    flakeMaintenanceQuery.data ?? dashboardQuery.data?.latestMaintenance ?? null;
  const isSelectedFlakeMaintenanceActive =
    selectedFlakeMaintenance?.status === "starting" ||
    selectedFlakeMaintenance?.status === "running";
  const selectedFleetDeployment = fleetDeploymentQuery.data ?? null;
  const isSelectedFleetDeploymentActive = isActiveFleetDeploymentStatusValue(
    selectedFleetDeployment?.status,
  );
  const rolloutLatestHostEntriesByName = useMemo(
    () =>
      new Map((selectedFleetDeployment?.hostEntries ?? []).map((entry) => [entry.hostName, entry])),
    [selectedFleetDeployment?.hostEntries],
  );
  const orderedRolloutHostNames = useMemo(() => {
    const availableSet = new Set(availableRolloutHostNames);
    const selectedHosts = rolloutSelectedHostNames.filter((hostName) => availableSet.has(hostName));
    const selectedHostSet = new Set(selectedHosts);
    const unselectedHosts = availableRolloutHostNames.filter(
      (hostName) => !selectedHostSet.has(hostName),
    );
    return [...selectedHosts, ...unselectedHosts];
  }, [availableRolloutHostNames, rolloutSelectedHostNames]);
  const selectedRolloutHostsCount = rolloutSelectedHostNames.filter((hostName) =>
    availableRolloutHostNames.includes(hostName),
  ).length;
  const rolloutHasConfirmTimeoutInput = rolloutConfirmTimeoutSecondsInput.trim().length > 0;
  const rolloutConfirmTimeoutSeconds = rolloutMagicRollback
    ? parseConfirmTimeoutSeconds(rolloutConfirmTimeoutSecondsInput)
    : null;
  const rolloutConfirmTimeoutInvalid =
    rolloutMagicRollback && rolloutHasConfirmTimeoutInput && rolloutConfirmTimeoutSeconds === null;
  const rolloutMaxParallelism = parseRolloutMaxParallelism(rolloutMaxParallelismInput);
  const rolloutMaxParallelismInvalid = rolloutMaxParallelism === null;
  const rolloutPreviewReports = rolloutPreviewQueries
    .map((query, index) => {
      const hostName = rolloutPreviewHostNames[index];
      return hostName && query.data ? { hostName, report: query.data.report } : null;
    })
    .filter(
      (value): value is { hostName: string; report: DeploymentPreflightReport } => value !== null,
    );
  const rolloutPreviewPending = rolloutPreviewQueries.some((query) => query.isPending);
  const rolloutPreviewHasBlockingChecks = rolloutPreviewReports.some(
    (entry) => entry.report.blockingFailureCount > 0,
  );
  const rolloutPreviewHasWarnings = rolloutPreviewReports.some(
    (entry) => entry.report.warningCount > 0,
  );
  const rolloutPreviewCanProceed =
    rolloutPreviewReports.length > 0 &&
    rolloutPreviewReports.every((entry) => entry.report.blockingFailureCount === 0) &&
    (!rolloutPreviewHasWarnings || rolloutAcknowledgeWarnings);
  const rolloutCanRunPreflight =
    selectedRolloutHostsCount > 0 &&
    !rolloutMaxParallelismInvalid &&
    !rolloutConfirmTimeoutInvalid &&
    availableRolloutHostNames.length > 0;
  const rolloutStatusCounts = useMemo(() => {
    const next = new Map<FleetDeploymentHostStatus, number>();
    for (const entry of selectedFleetDeployment?.hostEntries ?? []) {
      next.set(entry.status, (next.get(entry.status) ?? 0) + 1);
    }
    return [...next.entries()];
  }, [selectedFleetDeployment?.hostEntries]);
  const selectedHostDocGenerating =
    selectedHostSummary !== null &&
    (selectedHostSummary.documentation.status === "generating" ||
      pendingDocGenerationsByHost[selectedHostSummary.host.name] !== undefined);
  const maintenanceActionDisabledReason = maintenanceDisabledReason(gitStatusQuery.data);

  useEffect(() => {
    setDriftSecretInput("");
    setDriftSecretPending(false);
    setDriftReconcilePendingIntent(null);
  }, [selectedHostSummary?.host.name, selectedHostDrift?.awaitingAuthPhase]);

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

  const handleStartDrift = useCallback(async () => {
    if (!projectRef || !project || !selectedHostSummary || driftPending) {
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

    setDriftPending(true);
    try {
      const result = await api.hostDrift.refresh({
        projectId: project.id,
        hostName: selectedHostSummary.host.name,
      });
      await Promise.all([invalidateHostDriftQueries(), invalidateDashboardQueries()]);
      toastManager.add({
        type: "success",
        title:
          result.disposition === "already-running"
            ? "Drift scan already running"
            : "Drift scan started",
        description:
          result.disposition === "already-running"
            ? `Continuing to track ${selectedHostSummary.host.name}.`
            : `Scanning ${selectedHostSummary.host.name} for drift.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to start drift scan for ${selectedHostSummary.host.name}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setDriftPending(false);
    }
  }, [
    driftPending,
    invalidateDashboardQueries,
    invalidateHostDriftQueries,
    project,
    projectRef,
    selectedHostSummary,
  ]);

  const handleCancelDrift = useCallback(async () => {
    if (!projectRef || !project || !selectedHostSummary || driftPending) {
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

    setDriftPending(true);
    try {
      await api.hostDrift.cancel({
        projectId: project.id,
        hostName: selectedHostSummary.host.name,
      });
      await Promise.all([invalidateHostDriftQueries(), invalidateDashboardQueries()]);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to cancel drift scan for ${selectedHostSummary.host.name}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setDriftPending(false);
    }
  }, [
    driftPending,
    invalidateDashboardQueries,
    invalidateHostDriftQueries,
    project,
    projectRef,
    selectedHostSummary,
  ]);

  const handleSubmitDriftSecret = useCallback(async () => {
    if (
      !projectRef ||
      !project ||
      !selectedHostSummary ||
      !selectedHostDrift?.awaitingAuthPhase ||
      driftSecretPending
    ) {
      return;
    }
    const secret = driftSecretInput;
    if (secret.trim().length === 0) {
      toastManager.add({
        type: "error",
        title: "Enter a password first",
        description: "Provide the requested password to continue the drift scan.",
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

    setDriftSecretPending(true);
    try {
      const result = await api.hostDrift.submitSecret({
        projectId: project.id,
        hostName: selectedHostSummary.host.name,
        phase: selectedHostDrift.awaitingAuthPhase,
        secret,
      });
      await Promise.all([invalidateHostDriftQueries(), invalidateDashboardQueries()]);
      if (!result.accepted) {
        toastManager.add({
          type: "error",
          title: "The drift scan did not accept that password",
          description: "Refresh the view and try again if the scan is still waiting for input.",
        });
        return;
      }
      setDriftSecretInput("");
    } catch (error) {
      toastManager.add({
        type: "error",
        title: `Failed to continue drift scan for ${selectedHostSummary.host.name}`,
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setDriftSecretPending(false);
    }
  }, [
    driftSecretInput,
    driftSecretPending,
    invalidateDashboardQueries,
    invalidateHostDriftQueries,
    project,
    projectRef,
    selectedHostDrift?.awaitingAuthPhase,
    selectedHostSummary,
  ]);

  const handleReconcileDrift = useCallback(
    async (intent: HostDriftReconcileIntent) => {
      if (!projectRef || !project || !selectedHostSummary || driftReconcilePendingIntent !== null) {
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

      setDriftReconcilePendingIntent(intent);
      try {
        const result = await api.hostDrift.reconcile({
          projectId: project.id,
          hostName: selectedHostSummary.host.name,
          intent,
        });
        toastManager.add({
          type: "success",
          title: "Planning thread created",
          description: `Opened a reconciliation thread for ${selectedHostSummary.host.name}.`,
        });
        await navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams({
            environmentId: projectRef.environmentId,
            threadId: result.threadId,
          }),
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: `Failed to open reconciliation for ${selectedHostSummary.host.name}`,
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      } finally {
        setDriftReconcilePendingIntent(null);
      }
    },
    [driftReconcilePendingIntent, navigate, project, projectRef, selectedHostSummary],
  );

  const handleToggleRolloutHost = useCallback((hostName: string) => {
    setRolloutSelectedHostNames((current) =>
      current.includes(hostName)
        ? current.filter((candidate) => candidate !== hostName)
        : [...current, hostName],
    );
  }, []);

  const handleMoveRolloutHost = useCallback((hostName: string, direction: "up" | "down") => {
    setRolloutSelectedHostNames((current) => {
      const index = current.indexOf(hostName);
      if (index < 0) {
        return current;
      }

      const targetIndex = direction === "up" ? index - 1 : index + 1;
      if (targetIndex < 0 || targetIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const displaced = next[targetIndex];
      next[targetIndex] = hostName;
      next[index] = displaced!;
      return next;
    });
  }, []);

  const handleStartRollout = useCallback(async () => {
    if (!projectRef || !project || rolloutPending) {
      return;
    }

    const hostNames = rolloutSelectedHostNames.filter((hostName) =>
      availableRolloutHostNames.includes(hostName),
    );
    if (hostNames.length === 0) {
      toastManager.add({
        type: "error",
        title: "Select at least one host",
        description: "Choose the hosts you want to include in this rollout.",
      });
      return;
    }

    if (rolloutMaxParallelism === null) {
      toastManager.add({
        type: "error",
        title: "Invalid parallelism",
        description: "Enter a whole number between 1 and 5.",
      });
      return;
    }

    if (
      rolloutMagicRollback &&
      rolloutHasConfirmTimeoutInput &&
      rolloutConfirmTimeoutSeconds === null
    ) {
      toastManager.add({
        type: "error",
        title: "Invalid confirm timeout",
        description: "Enter a positive number of seconds or leave the field empty.",
      });
      return;
    }

    if (!rolloutPreflightRequested || rolloutPreviewReports.length === 0) {
      toastManager.add({
        type: "error",
        title: "Run rollout checks first",
        description:
          "Review the preflight checks for the selected hosts before starting the rollout.",
      });
      return;
    }

    if (!rolloutPreviewCanProceed) {
      const firstAttentionSummary =
        rolloutPreviewReports
          .map((entry) => findFirstDeploymentAttentionSummary(entry.report))
          .find((summary) => summary !== null) ?? null;
      toastManager.add({
        type: "error",
        title: "Rollout checks need attention",
        description:
          firstAttentionSummary ??
          "Resolve the blocking checks or acknowledge the warnings before starting the rollout.",
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

    setRolloutPending(true);
    try {
      const result = await api.fleetDeployments.start({
        projectId: project.id,
        hostNames,
        maxParallelism: rolloutMaxParallelism,
        deployOnServer: rolloutDeployOnServer,
        activationStrategy: rolloutActivationStrategy,
        magicRollback: rolloutMagicRollback,
        ...(rolloutMagicRollback && rolloutConfirmTimeoutSeconds !== null
          ? {
              confirmTimeoutSeconds: rolloutConfirmTimeoutSeconds,
            }
          : {}),
        stopOnFirstFailure: true,
        ...(rolloutAcknowledgeWarnings ? { acknowledgeWarnings: true } : {}),
      });

      await Promise.all([
        invalidateFleetDeploymentQueries(),
        invalidateHostDeploymentQueries(),
        invalidateDashboardQueries(),
      ]);
      await navigate({
        to: "/$environmentId/flake/$projectId",
        params: buildFlakeRouteParams(projectRef),
        search: { view: "rollout" },
      });
      toastManager.add({
        type: "success",
        title:
          result.disposition === "already-running" ? "Rollout already running" : "Rollout started",
        description:
          result.disposition === "already-running"
            ? `Tracking the active rollout for ${result.rollout.hostEntries.length} hosts.`
            : `Started a rollout across ${hostNames.length} hosts.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to start fleet rollout",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setRolloutPending(false);
    }
  }, [
    availableRolloutHostNames,
    invalidateDashboardQueries,
    invalidateFleetDeploymentQueries,
    invalidateHostDeploymentQueries,
    navigate,
    project,
    projectRef,
    rolloutConfirmTimeoutSeconds,
    rolloutHasConfirmTimeoutInput,
    rolloutMagicRollback,
    rolloutMaxParallelism,
    rolloutPreviewCanProceed,
    rolloutPreviewReports,
    rolloutPreflightRequested,
    rolloutPending,
    rolloutSelectedHostNames,
    rolloutActivationStrategy,
    rolloutAcknowledgeWarnings,
    rolloutDeployOnServer,
  ]);

  const handleRunRolloutPreflight = useCallback(() => {
    if (!projectRef || !project || !rolloutCanRunPreflight) {
      return;
    }
    queryClient.removeQueries({
      queryKey: projectQueryKeys.hostDeploymentPreviewPrefix(projectRef.environmentId, project.id),
    });
    setRolloutAcknowledgeWarnings(false);
    setRolloutPreflightRequested(true);
  }, [project, projectRef, queryClient, rolloutCanRunPreflight]);

  const handleStopRollout = useCallback(async () => {
    if (!projectRef || !project || rolloutPending) {
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

    setRolloutPending(true);
    try {
      await api.fleetDeployments.stop({
        projectId: project.id,
      });
      await Promise.all([
        invalidateFleetDeploymentQueries(),
        invalidateHostDeploymentQueries(),
        invalidateDashboardQueries(),
      ]);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Failed to stop fleet rollout",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    } finally {
      setRolloutPending(false);
    }
  }, [
    invalidateDashboardQueries,
    invalidateFleetDeploymentQueries,
    invalidateHostDeploymentQueries,
    project,
    projectRef,
    rolloutPending,
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
                    <Button
                      size="sm"
                      variant={
                        selectedHostSummary === null && activeView === "rollout"
                          ? "secondary"
                          : "ghost"
                      }
                      onClick={() => selectDashboardView(null, "rollout")}
                    >
                      <RocketIcon className="size-3.5" />
                      Rollout
                    </Button>
                    <Button
                      size="sm"
                      variant={
                        selectedHostSummary === null && activeView === "secrets"
                          ? "secondary"
                          : "ghost"
                      }
                      onClick={() => selectDashboardView(null, "secrets")}
                    >
                      <LockKeyholeIcon className="size-3.5" />
                      Secrets
                    </Button>
                  </div>
                  <div className="mt-4 rounded-xl border border-border/50 bg-background/50 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <label className="flex min-w-0 items-start gap-3">
                        <Checkbox
                          checked={nixDesignerEnabled}
                          onCheckedChange={(checked) => {
                            if (!projectUiKey) {
                              return;
                            }
                            setProjectNixDesignerEnabled(projectUiKey, checked === true);
                          }}
                          aria-label="Enable Nix Designer MCP for new flake threads"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-foreground">
                            Nix Designer MCP
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">
                            New dashboard threads attach the project-scoped Nix MCP server when
                            enabled.
                          </span>
                        </span>
                      </label>
                      <span
                        className={cn(
                          "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                          nixDesignerStatusClasses(nixDesigner?.status),
                        )}
                      >
                        {formatNixDesignerStatusLabel(nixDesigner?.status)}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {nixDesignerRevision ? (
                        <span className="rounded-md border border-border/60 px-2 py-1">
                          rev {nixDesignerRevision}
                        </span>
                      ) : null}
                      {nixDesigner?.optionCount ? (
                        <span className="rounded-md border border-border/60 px-2 py-1">
                          {nixDesigner.optionCount.toLocaleString()} options
                        </span>
                      ) : null}
                      {nixDesigner?.packageCount ? (
                        <span className="rounded-md border border-border/60 px-2 py-1">
                          {nixDesigner.packageCount.toLocaleString()} packages
                        </span>
                      ) : null}
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={nixDesignerRebuildPending}
                        onClick={() => void handleRebuildNixDesigner()}
                      >
                        {nixDesignerRebuildPending ? (
                          <RefreshCcwIcon className="size-3 animate-spin" />
                        ) : (
                          <RefreshCcwIcon className="size-3" />
                        )}
                        Rebuild index
                      </Button>
                    </div>
                  </div>
                </section>

                <section className="rounded-2xl border border-border/60 bg-card/50 p-4">
                  <div className="mb-3 flex items-center justify-between gap-3">
                    <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground/70">
                      Hosts
                    </h2>
                    <Button
                      size="xs"
                      variant="outline"
                      onClick={() => handleCreateHostDialogChange(true)}
                      disabled={!canCreateHost}
                      title={
                        canCreateHost
                          ? undefined
                          : "Create host is unavailable until this repo exposes a flake."
                      }
                    >
                      Create host
                    </Button>
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
                        const generating =
                          summary.documentation.status === "generating" ||
                          pendingDocGenerationsByHost[summary.host.name] !== undefined;
                        const deploying = deployingHostName === summary.host.name;
                        const hostChangesSelected = isSelected && activeView === "changes";
                        const hostDocSelected = isSelected && activeView === "doc";
                        const hostDeploySelected = isSelected && activeView === "deploy";
                        const hostDriftSelected = isSelected && activeView === "drift";
                        const deployDisabledReason = deploymentReasonLabel(
                          summary.deployment.reason,
                        );
                        const hostMenuEntries = buildFlakeDashboardHostMenu({
                          documentationStatus: summary.documentation.status,
                          generating,
                        });
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
                                {summary.latestDrift ? (
                                  <span
                                    className={cn(
                                      "rounded-full border px-1.5 py-px text-[9px] font-medium uppercase tracking-[0.12em]",
                                      driftStatusClasses(summary.latestDrift.status),
                                    )}
                                  >
                                    {formatDriftStatusLabel(summary.latestDrift.status)}
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
                              <Button
                                size="xs"
                                variant={hostDriftSelected ? "secondary" : "ghost"}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  selectDashboardView(summary.host.name, "drift");
                                }}
                              >
                                <ShieldCheckIcon className="size-3" />
                                Drift
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
                                    {hostMenuEntries.map((entry) => {
                                      if (entry.kind === "separator") {
                                        return <MenuSeparator key={entry.id} />;
                                      }

                                      return (
                                        <MenuItem
                                          key={entry.action}
                                          disabled={entry.disabled}
                                          variant={entry.destructive ? "destructive" : "default"}
                                          onClick={(event) => {
                                            event.stopPropagation();
                                            void runFlakeDashboardHostMenuAction({
                                              action: entry.action,
                                              host: summary.host,
                                              onGenerateDoc: handleGenerateHostDoc,
                                              onOpenDeployPage: openHostDeployPage,
                                              onRemoveHost: handleRemoveHostThread,
                                              onStartThread: handleStartHostThread,
                                            });
                                          }}
                                        >
                                          {entry.action === "start-thread" ? (
                                            <PlayIcon />
                                          ) : entry.action === "open-deploy-page" ? (
                                            <SquareTerminalIcon />
                                          ) : entry.action === "generate-doc" ? (
                                            generating ? (
                                              <RefreshCcwIcon className="animate-spin" />
                                            ) : (
                                              <BookOpenIcon />
                                            )
                                          ) : (
                                            <Trash2Icon />
                                          )}
                                          {entry.label}
                                        </MenuItem>
                                      );
                                    })}
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
                        {...(canCreateHost
                          ? {
                              actionLabel: "Create host",
                              onAction: () => handleCreateHostDialogChange(true),
                            }
                          : {})}
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
                              : activeView === "drift"
                                ? `Drift for ${selectedHostSummary?.host.name ?? "host"}`
                                : activeView === "rollout"
                                  ? "Fleet rollout"
                                  : activeView === "secrets"
                                    ? "Project secrets"
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
                            ? selectedHostDocGenerating
                              ? selectedHostSummary?.documentation.generatedAt
                                ? `Refreshing in the background. Last generated ${formatTimestamp(selectedHostSummary.documentation.generatedAt)}.`
                                : "Generating documentation in the background."
                              : selectedHostSummary?.documentation.generatedAt
                                ? `Generated ${formatTimestamp(selectedHostSummary.documentation.generatedAt)}`
                                : "Manual host documentation is missing or needs to be generated."
                            : activeView === "deploy"
                              ? selectedHostDeployment
                                ? `${formatDeploymentStatusLabel(selectedHostDeployment.status)} deployment output for ${selectedHostDeployment.hostName}.`
                                : "Start or foreground a deployment for this host to inspect the latest terminal output here."
                              : activeView === "drift"
                                ? describeHostDriftSummary(selectedHostDrift)
                                : activeView === "rollout"
                                  ? selectedFleetDeployment
                                    ? `${formatDeploymentStatusLabel(selectedFleetDeployment.status)} rollout across ${selectedFleetDeployment.hostEntries.length} hosts.`
                                    : "Choose hosts, order them, then run a shared deploy-rs rollout from this page."
                                  : activeView === "secrets"
                                    ? describeProjectSecretsSummary(
                                        projectSecretsHostInventories,
                                        selectedProjectSecrets?.provider ?? null,
                                      )
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
                            <Button
                              size="sm"
                              variant={activeView === "drift" ? "secondary" : "ghost"}
                              onClick={() =>
                                selectDashboardView(selectedHostSummary.host.name, "drift")
                              }
                            >
                              <ShieldCheckIcon className="size-3.5" />
                              Drift
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
                        {activeView === "drift" && selectedHostDrift ? (
                          <>
                            <span
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                driftStatusClasses(selectedHostDrift.status),
                              )}
                            >
                              {formatDriftStatusLabel(selectedHostDrift.status)}
                            </span>
                            {selectedHostDrift.awaitingAuthPhase ? (
                              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                                {formatHostDriftAuthPhaseLabel(selectedHostDrift.awaitingAuthPhase)}
                              </span>
                            ) : null}
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
                        {activeView === "rollout" && selectedFleetDeployment ? (
                          <>
                            <span
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                deploymentStatusClasses(selectedFleetDeployment.status),
                              )}
                            >
                              {formatDeploymentStatusLabel(selectedFleetDeployment.status)}
                            </span>
                            <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                              {selectedFleetDeployment.hostEntries.length} hosts
                            </span>
                          </>
                        ) : null}
                        {activeView === "secrets" && selectedProjectSecrets ? (
                          <>
                            <span
                              className={cn(
                                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                selectedProjectSecrets.provider === "sops-nix"
                                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                  : "border-zinc-500/30 bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
                              )}
                            >
                              {formatSecretsProviderLabel(selectedProjectSecrets.provider)}
                            </span>
                            {totalProjectSecretCount > 0 ? (
                              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                {totalProjectSecretCount} secrets
                              </span>
                            ) : null}
                            {totalProjectSecretFailures > 0 ? (
                              <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300">
                                {totalProjectSecretFailures} issue
                                {totalProjectSecretFailures === 1 ? "" : "s"}
                              </span>
                            ) : null}
                          </>
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
                              title={
                                selectedHostDocGenerating
                                  ? "Generating host doc"
                                  : "No host doc yet"
                              }
                              description={
                                selectedHostDocGenerating
                                  ? `T3code is generating documentation for ${selectedHostSummary.host.name} in the background.`
                                  : `Generate documentation for ${selectedHostSummary.host.name} to materialize its current settings and apps.`
                              }
                              icon={<BookOpenIcon className="size-5" />}
                              actionLabel={
                                selectedHostDocGenerating ? "Generating doc" : "Generate doc"
                              }
                              onAction={() => void handleGenerateHostDoc(selectedHostSummary.host)}
                              pending={selectedHostDocGenerating}
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
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Activation
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatActivationStrategyLabel(
                                      selectedHostDeployment.activationStrategy,
                                    )}
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
                                <div className="lg:col-span-2">
                                  <DeploymentReportCard
                                    title="Latest preflight"
                                    report={selectedHostDeployment.preflightReport}
                                    emptyMessage="No preflight report was recorded for this deployment yet."
                                    showProceedState
                                  />
                                </div>
                                <div className="lg:col-span-2">
                                  <DeploymentReportCard
                                    title="Latest postflight"
                                    report={selectedHostDeployment.postflightReport}
                                    emptyMessage="No postflight report has been recorded yet."
                                  />
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
                      ) : activeView === "drift" && selectedHostSummary ? (
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
                                  onClick={() => void handleStartDrift()}
                                  disabled={driftPending}
                                >
                                  {driftPending ? (
                                    <RefreshCcwIcon className="size-3.5 animate-spin" />
                                  ) : (
                                    <ShieldCheckIcon className="size-3.5" />
                                  )}
                                  {selectedHostDrift ? "Run again" : "Run scan"}
                                </Button>
                                {isSelectedHostDriftActive ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void handleCancelDrift()}
                                    disabled={driftPending}
                                  >
                                    Cancel
                                  </Button>
                                ) : null}
                                {selectedHostDrift?.status === "completed" &&
                                orderedSelectedHostDriftCategoryResults.length > 0 ? (
                                  <>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() =>
                                        void handleReconcileDrift("reconcile-flake-to-host")
                                      }
                                      disabled={driftReconcilePendingIntent !== null}
                                    >
                                      {driftReconcilePendingIntent === "reconcile-flake-to-host" ? (
                                        <RefreshCcwIcon className="size-3.5 animate-spin" />
                                      ) : (
                                        <PlayIcon className="size-3.5" />
                                      )}
                                      Flake to host
                                    </Button>
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={() =>
                                        void handleReconcileDrift("reconcile-host-to-flake")
                                      }
                                      disabled={driftReconcilePendingIntent !== null}
                                    >
                                      {driftReconcilePendingIntent === "reconcile-host-to-flake" ? (
                                        <RefreshCcwIcon className="size-3.5 animate-spin" />
                                      ) : (
                                        <PlayIcon className="size-3.5" />
                                      )}
                                      Host to flake
                                    </Button>
                                  </>
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
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    selectDashboardView(selectedHostSummary.host.name, "deploy")
                                  }
                                >
                                  Deploy
                                </Button>
                              </div>
                            </div>

                            {selectedHostDrift ? (
                              <div className="mt-4 grid gap-3 lg:grid-cols-2">
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Started
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatTimestamp(selectedHostDrift.startedAt)}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Updated
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatTimestamp(selectedHostDrift.updatedAt)}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    SSH login
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {selectedHostSummary.host.sshUser
                                      ? `${selectedHostSummary.host.sshUser}@${selectedHostSummary.host.target}`
                                      : selectedHostSummary.host.target}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Activation user
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {selectedHostSummary.host.activationUser ?? "root"}
                                  </div>
                                </div>
                                {selectedHostDrift.lastError ? (
                                  <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 lg:col-span-2">
                                    <div className="text-[11px] uppercase tracking-widest text-amber-700 dark:text-amber-300">
                                      Latest issue
                                    </div>
                                    <div className="mt-1 whitespace-pre-wrap text-sm text-amber-950 dark:text-amber-50">
                                      {selectedHostDrift.lastError}
                                    </div>
                                  </div>
                                ) : null}
                              </div>
                            ) : hostDriftQuery.isPending ? (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="Loading drift state"
                                  description="Checking whether this host already has a saved drift scan."
                                  icon={<LoaderIcon className="size-5 animate-spin" />}
                                />
                              </div>
                            ) : (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="No drift scan yet"
                                  description={`Run a drift scan for ${selectedHostSummary.host.name} to compare the flake with the live host.`}
                                  icon={<ShieldCheckIcon className="size-5" />}
                                  actionLabel="Run scan"
                                  onAction={() => void handleStartDrift()}
                                  pending={driftPending}
                                />
                              </div>
                            )}
                          </div>

                          {selectedHostDrift?.awaitingAuthPhase ? (
                            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <h3 className="text-sm font-semibold text-amber-950 dark:text-amber-50">
                                    {formatHostDriftAuthPhaseLabel(
                                      selectedHostDrift.awaitingAuthPhase,
                                    )}{" "}
                                    required
                                  </h3>
                                  <p className="mt-1 text-sm text-amber-900/80 dark:text-amber-100/80">
                                    Enter the requested password to continue the scan. The value is
                                    only used for this workflow attempt.
                                  </p>
                                </div>
                                <span className="rounded-full border border-amber-500/30 bg-background/60 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-800 dark:text-amber-200">
                                  Waiting
                                </span>
                              </div>
                              <div className="mt-4 flex flex-col gap-3 sm:flex-row">
                                <Input
                                  type="password"
                                  value={driftSecretInput}
                                  onChange={(event) => setDriftSecretInput(event.target.value)}
                                  placeholder={
                                    selectedHostDrift.awaitingAuthPhase === "remote-sudo"
                                      ? "Remote sudo password"
                                      : "SSH login password"
                                  }
                                />
                                <Button
                                  onClick={() => void handleSubmitDriftSecret()}
                                  disabled={
                                    driftSecretPending || driftSecretInput.trim().length === 0
                                  }
                                >
                                  {driftSecretPending ? (
                                    <RefreshCcwIcon className="size-3.5 animate-spin" />
                                  ) : (
                                    <ShieldCheckIcon className="size-3.5" />
                                  )}
                                  Continue scan
                                </Button>
                              </div>
                            </div>
                          ) : null}

                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h3 className="text-sm font-semibold text-foreground">
                                  Category results
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                  Deterministic desired-vs-observed comparison for the current MVP
                                  categories.
                                </p>
                              </div>
                              {selectedHostDrift ? (
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
                                    Match {selectedHostDriftMatchCount}
                                  </span>
                                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                                    Drift {selectedHostDriftMismatchCount}
                                  </span>
                                  <span className="rounded-full border border-zinc-500/30 bg-zinc-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-zinc-700 dark:text-zinc-300">
                                    Unknown {selectedHostDriftUnknownCount}
                                  </span>
                                </div>
                              ) : null}
                            </div>

                            {selectedHostDrift &&
                            orderedSelectedHostDriftCategoryResults.length > 0 ? (
                              <div className="mt-4 grid gap-3 xl:grid-cols-2">
                                {orderedSelectedHostDriftCategoryResults.map((result) => (
                                  <div
                                    key={`${selectedHostSummary.host.name}:${result.category}`}
                                    className="rounded-xl border border-border/50 bg-background/50 p-3"
                                  >
                                    <div className="flex flex-wrap items-start justify-between gap-2">
                                      <div>
                                        <div className="text-sm font-medium text-foreground">
                                          {formatHostDriftCategoryLabel(result.category)}
                                        </div>
                                        <div className="mt-1 text-sm text-foreground">
                                          {result.summary}
                                        </div>
                                      </div>
                                      <span
                                        className={cn(
                                          "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                          hostDriftCategoryStatusClasses(result.status),
                                        )}
                                      >
                                        {formatHostDriftCategoryStatusLabel(result.status)}
                                      </span>
                                    </div>
                                    {result.detail ? (
                                      <div className="mt-3 whitespace-pre-wrap rounded-lg bg-muted/70 px-2.5 py-2 text-xs text-muted-foreground">
                                        {result.detail}
                                      </div>
                                    ) : null}
                                    <div className="mt-3 grid gap-2 sm:grid-cols-2">
                                      <div className="rounded-lg border border-border/50 bg-background/70 p-2.5">
                                        <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                          Desired
                                        </div>
                                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-foreground">
                                          {formatDriftValue(result.desiredValue)}
                                        </pre>
                                      </div>
                                      <div className="rounded-lg border border-border/50 bg-background/70 p-2.5">
                                        <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                          Observed
                                        </div>
                                        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap text-xs text-foreground">
                                          {formatDriftValue(result.observedValue)}
                                        </pre>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                              </div>
                            ) : selectedHostDrift ? (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="No category results yet"
                                  description="The drift scan has not produced comparison results yet."
                                  icon={<ShieldCheckIcon className="size-5" />}
                                />
                              </div>
                            ) : (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="Run a scan first"
                                  description="Category results appear here after a host drift scan completes."
                                  icon={<ShieldCheckIcon className="size-5" />}
                                />
                              </div>
                            )}
                          </div>

                          <div className="overflow-hidden rounded-xl border border-border/60 bg-background/60">
                            <div className="flex items-center justify-between gap-3 border-b border-border/50 px-4 py-3">
                              <div>
                                <h3 className="text-sm font-semibold text-foreground">Terminal</h3>
                                <p className="text-xs text-muted-foreground">
                                  Read-only drift scan output for the latest run on this host.
                                </p>
                              </div>
                              {selectedHostDrift ? (
                                <span
                                  className={cn(
                                    "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                    driftStatusClasses(selectedHostDrift.status),
                                  )}
                                >
                                  {formatDriftStatusLabel(selectedHostDrift.status)}
                                </span>
                              ) : null}
                            </div>
                            <div className="h-[56vh] min-h-[320px] p-2">
                              {selectedHostDrift ? (
                                <HostDriftTerminal
                                  environmentId={projectRef.environmentId}
                                  projectId={project.id}
                                  hostName={selectedHostSummary.host.name}
                                  cwd={selectedHostDrift.cwd}
                                  autoFocus
                                  onSessionExited={() => {
                                    void Promise.all([
                                      invalidateHostDriftQueries(),
                                      invalidateDashboardQueries(),
                                    ]);
                                  }}
                                />
                              ) : (
                                <div className="h-full p-2">
                                  <EmptyPanel
                                    title="No terminal output yet"
                                    description="The drift page will stream the latest run here once a scan has started."
                                    icon={<SquareTerminalIcon className="size-5" />}
                                  />
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      ) : activeView === "rollout" ? (
                        <div className="space-y-4 p-4 sm:p-5">
                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                  Latest rollout
                                </div>
                                <div className="mt-0.5 text-base font-semibold text-foreground">
                                  {selectedFleetDeployment?.rolloutId ?? "No rollout yet"}
                                </div>
                                <div className="mt-1 text-sm text-muted-foreground">
                                  Order hosts, keep one shared deploy configuration, and stop on
                                  first failure to limit blast radius.
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  size="sm"
                                  onClick={() => void handleStartRollout()}
                                  disabled={
                                    rolloutPending ||
                                    isSelectedFleetDeploymentActive ||
                                    selectedRolloutHostsCount === 0 ||
                                    !rolloutPreflightRequested ||
                                    rolloutPreviewPending ||
                                    !rolloutPreviewCanProceed ||
                                    rolloutMaxParallelismInvalid ||
                                    rolloutConfirmTimeoutInvalid ||
                                    availableRolloutHostNames.length === 0
                                  }
                                >
                                  {rolloutPending ? (
                                    <RefreshCcwIcon className="size-3.5 animate-spin" />
                                  ) : (
                                    <RocketIcon className="size-3.5" />
                                  )}
                                  {selectedFleetDeployment ? "Run again" : "Start rollout"}
                                </Button>
                                {isSelectedFleetDeploymentActive ? (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() => void handleStopRollout()}
                                    disabled={rolloutPending}
                                  >
                                    Cancel
                                  </Button>
                                ) : null}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => selectDashboardView(null, "changes")}
                                >
                                  Changes
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => selectDashboardView(null, "maintenance")}
                                >
                                  Maintenance
                                </Button>
                              </div>
                            </div>

                            {selectedFleetDeployment ? (
                              <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-6">
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Started
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatTimestamp(selectedFleetDeployment.startedAt)}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Finished
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {selectedFleetDeployment.finishedAt
                                      ? formatTimestamp(selectedFleetDeployment.finishedAt)
                                      : "Still running"}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Parallelism
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {selectedFleetDeployment.maxParallelism}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Mode
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatDeploymentModeLabel(
                                      selectedFleetDeployment.deployOnServer,
                                    )}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Activation
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatActivationStrategyLabel(
                                      selectedFleetDeployment.activationStrategy,
                                    )}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Magic rollback
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {selectedFleetDeployment.magicRollback === false
                                      ? "Disabled"
                                      : selectedFleetDeployment.confirmTimeoutSeconds
                                        ? `Enabled (${selectedFleetDeployment.confirmTimeoutSeconds}s)`
                                        : "Enabled"}
                                  </div>
                                </div>
                              </div>
                            ) : null}
                          </div>

                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h3 className="text-sm font-semibold text-foreground">
                                  Host order
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                  Checked hosts run in this order. Unchecked hosts stay out of the
                                  rollout.
                                </p>
                              </div>
                              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                {selectedRolloutHostsCount} selected
                              </span>
                            </div>

                            {availableRolloutHostNames.length > 0 ? (
                              <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
                                <div className="grid gap-2">
                                  {orderedRolloutHostNames.map((hostName) => {
                                    const isSelected = rolloutSelectedHostNames.includes(hostName);
                                    const selectedIndex =
                                      rolloutSelectedHostNames.indexOf(hostName);
                                    const latestHostEntry =
                                      rolloutLatestHostEntriesByName.get(hostName) ?? null;
                                    const hostSummary = hostSummariesByName.get(hostName) ?? null;
                                    return (
                                      <div
                                        key={hostName}
                                        className={cn(
                                          "rounded-xl border px-3 py-3 transition-colors",
                                          isSelected
                                            ? "border-primary/30 bg-primary/5"
                                            : "border-border/50 bg-background/50",
                                        )}
                                      >
                                        <div className="flex flex-wrap items-center justify-between gap-3">
                                          <label className="flex min-w-0 items-start gap-3">
                                            <Checkbox
                                              checked={isSelected}
                                              onCheckedChange={() =>
                                                handleToggleRolloutHost(hostName)
                                              }
                                              aria-label={`Include ${hostName} in rollout`}
                                            />
                                            <span className="min-w-0">
                                              <span className="block text-sm font-medium text-foreground">
                                                {hostName}
                                              </span>
                                              <span className="block truncate text-xs text-muted-foreground">
                                                {hostSummary?.host.target ?? "No target metadata"}
                                              </span>
                                            </span>
                                          </label>
                                          <div className="flex flex-wrap items-center gap-2">
                                            {isSelected ? (
                                              <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                                #{selectedIndex + 1}
                                              </span>
                                            ) : null}
                                            {latestHostEntry ? (
                                              <span
                                                className={cn(
                                                  "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                                  deploymentStatusClasses(latestHostEntry.status),
                                                )}
                                              >
                                                {formatDeploymentStatusLabel(
                                                  latestHostEntry.status,
                                                )}
                                              </span>
                                            ) : null}
                                            <Button
                                              size="xs"
                                              variant="ghost"
                                              onClick={() => handleMoveRolloutHost(hostName, "up")}
                                              disabled={!isSelected || selectedIndex <= 0}
                                            >
                                              <ArrowUpIcon className="size-3" />
                                              Up
                                            </Button>
                                            <Button
                                              size="xs"
                                              variant="ghost"
                                              onClick={() =>
                                                handleMoveRolloutHost(hostName, "down")
                                              }
                                              disabled={
                                                !isSelected ||
                                                selectedIndex < 0 ||
                                                selectedIndex >= rolloutSelectedHostNames.length - 1
                                              }
                                            >
                                              <ArrowDownIcon className="size-3" />
                                              Down
                                            </Button>
                                          </div>
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>

                                <div className="space-y-3">
                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                    <label className="grid gap-1.5">
                                      <span className="text-xs font-medium text-foreground">
                                        Max parallelism
                                      </span>
                                      <Input
                                        value={rolloutMaxParallelismInput}
                                        onChange={(event) =>
                                          setRolloutMaxParallelismInput(event.target.value)
                                        }
                                        inputMode="numeric"
                                        placeholder="1"
                                      />
                                      <span
                                        className={cn(
                                          "text-xs",
                                          rolloutMaxParallelismInvalid
                                            ? "text-destructive"
                                            : "text-muted-foreground",
                                        )}
                                      >
                                        {rolloutMaxParallelismInvalid
                                          ? "Use a whole number between 1 and 5."
                                          : "Default is 1. Keep this low while rollout safeguards are minimal."}
                                      </span>
                                    </label>
                                  </div>

                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                    <div className="text-xs font-medium text-foreground">
                                      Activation strategy
                                    </div>
                                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                                      <Button
                                        size="sm"
                                        variant={
                                          rolloutActivationStrategy === "switch"
                                            ? "secondary"
                                            : "outline"
                                        }
                                        onClick={() => {
                                          setRolloutActivationStrategy("switch");
                                          setRolloutAcknowledgeWarnings(false);
                                        }}
                                      >
                                        Switch live now
                                      </Button>
                                      <Button
                                        size="sm"
                                        variant={
                                          rolloutActivationStrategy === "boot"
                                            ? "secondary"
                                            : "outline"
                                        }
                                        onClick={() => {
                                          setRolloutActivationStrategy("boot");
                                          setRolloutAcknowledgeWarnings(false);
                                        }}
                                      >
                                        Stage for reboot
                                      </Button>
                                    </div>
                                    <div className="mt-2 text-xs text-muted-foreground">
                                      Use boot staging when switch inhibitors or reboot-requiring
                                      changes make live activation unsafe.
                                    </div>
                                  </div>

                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                    <label className="flex items-start gap-3">
                                      <Checkbox
                                        checked={rolloutDeployOnServer}
                                        onCheckedChange={(checked) => {
                                          setRolloutDeployOnServer(checked === true);
                                        }}
                                        aria-label="Deploy on server for rollout"
                                      />
                                      <span className="min-w-0">
                                        <span className="block text-sm font-medium text-foreground">
                                          Deploy on server
                                        </span>
                                        <span className="mt-0.5 block text-xs text-muted-foreground">
                                          Apply the same deploy-rs mode to every selected host in
                                          this rollout.
                                        </span>
                                      </span>
                                    </label>
                                  </div>

                                  <div className="space-y-3 rounded-xl border border-border/50 bg-background/50 p-3">
                                    <label className="flex items-start gap-3">
                                      <Checkbox
                                        checked={rolloutMagicRollback}
                                        onCheckedChange={(checked) => {
                                          setRolloutMagicRollback(checked !== false);
                                        }}
                                        aria-label="Use magic rollback verification for rollout"
                                      />
                                      <span className="min-w-0">
                                        <span className="block text-sm font-medium text-foreground">
                                          Use magic rollback verification
                                        </span>
                                        <span className="mt-0.5 block text-xs text-muted-foreground">
                                          Keep the normal safe path across all hosts in the rollout.
                                        </span>
                                      </span>
                                    </label>

                                    {rolloutMagicRollback ? (
                                      <label className="grid gap-1.5">
                                        <span className="text-xs font-medium text-foreground">
                                          Confirm timeout seconds
                                        </span>
                                        <Input
                                          value={rolloutConfirmTimeoutSecondsInput}
                                          onChange={(event) =>
                                            setRolloutConfirmTimeoutSecondsInput(event.target.value)
                                          }
                                          inputMode="numeric"
                                          placeholder={String(
                                            DEPLOY_RS_DEFAULT_CONFIRM_TIMEOUT_SECONDS,
                                          )}
                                        />
                                        <span
                                          className={cn(
                                            "text-xs",
                                            rolloutConfirmTimeoutInvalid
                                              ? "text-destructive"
                                              : "text-muted-foreground",
                                          )}
                                        >
                                          {rolloutConfirmTimeoutInvalid
                                            ? "Use a positive number of seconds or leave the field empty."
                                            : "Optional deploy-rs confirmation window for every host in the rollout."}
                                        </span>
                                      </label>
                                    ) : null}
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="No hosts available"
                                  description="Resolve flake hosts before starting a rollout."
                                  icon={<AlertCircleIcon className="size-5" />}
                                />
                              </div>
                            )}
                          </div>

                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h3 className="text-sm font-semibold text-foreground">Preflight</h3>
                                <p className="text-xs text-muted-foreground">
                                  These are the checks the rollout will reuse when each host starts.
                                </p>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() => handleRunRolloutPreflight()}
                                  disabled={rolloutPreviewPending || !rolloutCanRunPreflight}
                                >
                                  {rolloutPreviewPending ? (
                                    <RefreshCcwIcon className="size-3.5 animate-spin" />
                                  ) : (
                                    <ShieldCheckIcon className="size-3.5" />
                                  )}
                                  {rolloutPreflightRequested ? "Run again" : "Run checks"}
                                </Button>
                                {rolloutPreviewPending ? (
                                  <span className="rounded-full border border-border/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                                    Checking
                                  </span>
                                ) : null}
                                {rolloutPreviewHasWarnings ? (
                                  <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                                    Warnings
                                  </span>
                                ) : null}
                                {rolloutPreviewHasBlockingChecks ? (
                                  <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300">
                                    Blocked
                                  </span>
                                ) : null}
                                {!rolloutPreviewPending &&
                                rolloutPreviewReports.length > 0 &&
                                rolloutPreviewCanProceed ? (
                                  <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
                                    Ready
                                  </span>
                                ) : null}
                              </div>
                            </div>

                            {selectedRolloutHostsCount > 0 ? (
                              <div className="mt-4 space-y-3">
                                {rolloutPreviewHasWarnings ? (
                                  <label className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                                    <Checkbox
                                      checked={rolloutAcknowledgeWarnings}
                                      onCheckedChange={(checked) => {
                                        setRolloutAcknowledgeWarnings(checked === true);
                                      }}
                                      aria-label="Acknowledge rollout warnings"
                                    />
                                    <span className="min-w-0 text-sm text-amber-900 dark:text-amber-100">
                                      Acknowledge rollout warnings and continue with the current
                                      workspace state.
                                    </span>
                                  </label>
                                ) : null}

                                {rolloutPreviewReports.length > 0 ? (
                                  <div className="grid gap-2">
                                    {rolloutPreviewReports.map(({ hostName, report }) => (
                                      <div
                                        key={`rollout-preflight:${hostName}`}
                                        className="rounded-xl border border-border/50 bg-background/50 p-3"
                                      >
                                        <div className="flex flex-wrap items-start justify-between gap-2">
                                          <div>
                                            <div className="text-sm font-medium text-foreground">
                                              {hostName}
                                            </div>
                                            <div className="mt-1 text-xs text-muted-foreground">
                                              {findFirstDeploymentAttentionSummary(report) ??
                                                "All checks passed."}
                                            </div>
                                          </div>
                                          <div className="flex flex-wrap items-center gap-2">
                                            {report.warningCount > 0 ? (
                                              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-amber-700 dark:text-amber-300">
                                                {report.warningCount} warning
                                              </span>
                                            ) : null}
                                            {report.blockingFailureCount > 0 ? (
                                              <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300">
                                                Blocked
                                              </span>
                                            ) : (
                                              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
                                                Ready
                                              </span>
                                            )}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                ) : rolloutPreviewPending ? (
                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3 text-sm text-muted-foreground">
                                    Running preflight checks for the selected hosts.
                                  </div>
                                ) : rolloutCanRunPreflight ? (
                                  <div className="rounded-xl border border-border/50 bg-background/50 p-3 text-sm text-muted-foreground">
                                    Run preflight checks to inspect the selected hosts before
                                    starting the rollout.
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <div className="mt-4 rounded-xl border border-border/50 bg-background/50 p-3 text-sm text-muted-foreground">
                                Select at least one host to preview rollout safety checks.
                              </div>
                            )}
                          </div>

                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <h3 className="text-sm font-semibold text-foreground">
                                  Rollout hosts
                                </h3>
                                <p className="text-xs text-muted-foreground">
                                  Open a host deploy page to inspect the terminal for that child
                                  run.
                                </p>
                              </div>
                              {rolloutStatusCounts.length > 0 ? (
                                <div className="flex flex-wrap items-center gap-2">
                                  {rolloutStatusCounts.map(([status, count]) => (
                                    <span
                                      key={status}
                                      className={cn(
                                        "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                        deploymentStatusClasses(status),
                                      )}
                                    >
                                      {formatDeploymentStatusLabel(status)} {count}
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>

                            {selectedFleetDeployment ? (
                              <div className="mt-4 grid gap-2">
                                {selectedFleetDeployment.hostEntries.map((entry) => {
                                  const hostSummary =
                                    hostSummariesByName.get(entry.hostName) ?? null;
                                  return (
                                    <div
                                      key={`${selectedFleetDeployment.rolloutId}:${entry.hostName}`}
                                      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-background/50 px-3 py-3"
                                    >
                                      <div className="min-w-0">
                                        <div className="text-sm font-medium text-foreground">
                                          {entry.hostName}
                                        </div>
                                        <div className="truncate text-xs text-muted-foreground">
                                          {hostSummary?.host.target ?? "No target metadata"}
                                        </div>
                                        <div className="mt-1 text-[11px] text-muted-foreground">
                                          {entry.startedAt
                                            ? `Started ${formatTimestamp(entry.startedAt)}`
                                            : "Not started yet"}
                                          {entry.finishedAt
                                            ? ` • Finished ${formatTimestamp(entry.finishedAt)}`
                                            : ""}
                                        </div>
                                        {findFirstDeploymentAttentionSummary(
                                          entry.preflightReport,
                                        ) ? (
                                          <div className="mt-1 text-[11px] text-muted-foreground">
                                            Preflight:{" "}
                                            {findFirstDeploymentAttentionSummary(
                                              entry.preflightReport,
                                            )}
                                          </div>
                                        ) : null}
                                        {findFirstDeploymentAttentionSummary(
                                          entry.postflightReport,
                                        ) ? (
                                          <div className="mt-1 text-[11px] text-muted-foreground">
                                            Postflight:{" "}
                                            {findFirstDeploymentAttentionSummary(
                                              entry.postflightReport,
                                            )}
                                          </div>
                                        ) : null}
                                      </div>
                                      <div className="flex flex-wrap items-center gap-2">
                                        <span
                                          className={cn(
                                            "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                            deploymentStatusClasses(entry.status),
                                          )}
                                        >
                                          {formatDeploymentStatusLabel(entry.status)}
                                        </span>
                                        <Button
                                          size="xs"
                                          variant="outline"
                                          onClick={() => openHostDeployPage(entry.hostName)}
                                        >
                                          <SquareTerminalIcon className="size-3" />
                                          Open deploy page
                                        </Button>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            ) : (
                              <div className="mt-4">
                                <EmptyPanel
                                  title="No rollout yet"
                                  description="Start a rollout to track each host here and jump into its deploy output."
                                  icon={<RocketIcon className="size-5" />}
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      ) : activeView === "secrets" ? (
                        <div className="space-y-4 p-4 sm:p-5">
                          <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                              <div>
                                <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                  Provider
                                </div>
                                <div className="mt-0.5 text-base font-semibold text-foreground">
                                  {formatSecretsProviderLabel(
                                    selectedProjectSecrets?.provider ?? "none",
                                  )}
                                </div>
                                <div className="mt-1 text-sm text-muted-foreground">
                                  Secret values are never displayed or persisted. Only declarations,
                                  encrypted source paths, and validation state are shown here.
                                </div>
                              </div>
                              <div className="flex flex-wrap items-center gap-2">
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => selectDashboardView(null, "changes")}
                                >
                                  Changes
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => selectDashboardView(null, "rollout")}
                                >
                                  Rollout
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => selectDashboardView(null, "maintenance")}
                                >
                                  Maintenance
                                </Button>
                              </div>
                            </div>

                            {selectedProjectSecrets ? (
                              <div className="mt-4 grid gap-3 md:grid-cols-3">
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Declared secrets
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {totalProjectSecretCount}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Validation issues
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {totalProjectSecretFailures}
                                  </div>
                                </div>
                                <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Updated
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {formatTimestamp(selectedProjectSecrets.updatedAt)}
                                  </div>
                                </div>
                              </div>
                            ) : null}

                            {selectedProjectSecrets?.detectionSummary ? (
                              <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-100">
                                {selectedProjectSecrets.detectionSummary}
                              </div>
                            ) : null}
                          </div>

                          {projectSecretsQuery.isPending && !selectedProjectSecrets ? (
                            <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                              <EmptyPanel
                                title="Loading secrets"
                                description="Resolving sops-nix declarations for this flake..."
                                icon={<LoaderIcon className="size-5 animate-spin" />}
                              />
                            </div>
                          ) : projectSecretsHostInventories.length > 0 ? (
                            <div className="grid gap-4">
                              {projectSecretsHostInventories.map((inventory) => (
                                <div
                                  key={`secret-inventory:${inventory.hostName}`}
                                  className="rounded-xl border border-border/60 bg-card/50 p-4"
                                >
                                  <div className="flex flex-wrap items-start justify-between gap-3">
                                    <div>
                                      <h3 className="text-sm font-semibold text-foreground">
                                        {inventory.hostName}
                                      </h3>
                                      <p className="text-xs text-muted-foreground">
                                        {inventory.secretCount} declared secret
                                        {inventory.secretCount === 1 ? "" : "s"} across{" "}
                                        {inventory.sourceFileCount} encrypted source file
                                        {inventory.sourceFileCount === 1 ? "" : "s"}.
                                      </p>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2">
                                      {countFailingSecretChecks(inventory) > 0 ? (
                                        <span className="rounded-full border border-rose-500/30 bg-rose-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-rose-700 dark:text-rose-300">
                                          {countFailingSecretChecks(inventory)} issue
                                          {countFailingSecretChecks(inventory) === 1 ? "" : "s"}
                                        </span>
                                      ) : (
                                        <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300">
                                          Valid
                                        </span>
                                      )}
                                    </div>
                                  </div>

                                  <div className="mt-4 grid gap-3 xl:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
                                    <div className="space-y-2">
                                      {inventory.validationChecks.map((check) => (
                                        <div
                                          key={`${inventory.hostName}:${check.code}`}
                                          className="rounded-xl border border-border/50 bg-background/50 p-3"
                                        >
                                          <div className="flex flex-wrap items-start justify-between gap-2">
                                            <div>
                                              <div className="text-sm font-medium text-foreground">
                                                {check.label}
                                              </div>
                                              <div className="mt-1 text-xs text-muted-foreground">
                                                {check.summary}
                                              </div>
                                            </div>
                                            <span
                                              className={cn(
                                                "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                                secretValidationResultClasses(check.result),
                                              )}
                                            >
                                              {formatSecretValidationResultLabel(check.result)}
                                            </span>
                                          </div>
                                          {check.detail ? (
                                            <pre className="mt-3 overflow-x-auto rounded-lg bg-muted/80 px-3 py-2 text-[11px] text-foreground whitespace-pre-wrap">
                                              {check.detail}
                                            </pre>
                                          ) : null}
                                        </div>
                                      ))}
                                    </div>

                                    <div className="rounded-xl border border-border/50 bg-background/50 p-3">
                                      <div className="flex items-start justify-between gap-3">
                                        <div>
                                          <h4 className="text-sm font-semibold text-foreground">
                                            Encrypted sources
                                          </h4>
                                          <p className="text-xs text-muted-foreground">
                                            Links open the encrypted source file. Secret values are
                                            never decrypted here.
                                          </p>
                                        </div>
                                        <KeyRoundIcon className="mt-0.5 size-4 text-muted-foreground" />
                                      </div>

                                      {inventory.secrets.length > 0 ? (
                                        <div className="mt-4 grid gap-2">
                                          {inventory.secrets.map((secret) => {
                                            const openPath =
                                              secret.workspaceRelativeEncryptedSourcePath;
                                            const canOpen = openPath !== null;
                                            return (
                                              <div
                                                key={`${inventory.hostName}:${secret.name}`}
                                                className="rounded-xl border border-border/50 bg-background/60 px-3 py-3"
                                              >
                                                <div className="flex flex-wrap items-start justify-between gap-3">
                                                  <div className="min-w-0">
                                                    <div className="text-sm font-medium text-foreground">
                                                      {secret.name}
                                                    </div>
                                                    <div className="mt-1 break-all text-xs text-muted-foreground">
                                                      {secret.workspaceRelativeEncryptedSourcePath ??
                                                        secret.encryptedSourcePath ??
                                                        "No encrypted source file declared"}
                                                    </div>
                                                  </div>
                                                  {canOpen ? (
                                                    <Button
                                                      size="xs"
                                                      variant="outline"
                                                      onClick={() =>
                                                        void handleOpenSecretSource(openPath)
                                                      }
                                                    >
                                                      <FileTextIcon className="size-3" />
                                                      Open source
                                                    </Button>
                                                  ) : null}
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      ) : (
                                        <div className="mt-4 rounded-xl border border-border/50 bg-background/60 p-3 text-sm text-muted-foreground">
                                          No secrets are declared for this host.
                                        </div>
                                      )}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-xl border border-border/60 bg-card/50 p-4">
                              <EmptyPanel
                                title="No sops-nix secrets detected"
                                description={
                                  selectedProjectSecrets?.detectionSummary ??
                                  "This flake does not expose any sops-nix secret declarations yet."
                                }
                                icon={<LockKeyholeIcon className="size-5" />}
                              />
                            </div>
                          )}
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
                          <div className="max-h-[78vh] space-y-4 overflow-y-auto p-4 sm:p-5">
                            <div className="rounded-xl border border-border/60 bg-background/60 p-4">
                              <div className="flex flex-wrap items-start justify-between gap-3">
                                <div>
                                  <h3 className="text-sm font-semibold text-foreground">
                                    Nix Designer index
                                  </h3>
                                  <p className="mt-1 text-xs text-muted-foreground">
                                    Project-scoped option and package index used by designer
                                    threads.
                                  </p>
                                </div>
                                <div className="flex flex-wrap items-center gap-2">
                                  <span
                                    className={cn(
                                      "rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em]",
                                      nixDesignerStatusClasses(nixDesigner?.status),
                                    )}
                                  >
                                    {formatNixDesignerStatusLabel(nixDesigner?.status)}
                                  </span>
                                  <Button
                                    size="xs"
                                    variant="outline"
                                    disabled={nixDesignerRebuildPending}
                                    onClick={() => void handleRebuildNixDesigner()}
                                  >
                                    {nixDesignerRebuildPending ? (
                                      <RefreshCcwIcon className="size-3 animate-spin" />
                                    ) : (
                                      <RefreshCcwIcon className="size-3" />
                                    )}
                                    Rebuild
                                  </Button>
                                </div>
                              </div>
                              <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                                <div className="rounded-lg border border-border/50 bg-card/40 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Revision
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {nixDesignerRevision ?? "Unavailable"}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-border/50 bg-card/40 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Built
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {nixDesigner?.builtAt
                                      ? formatTimestamp(nixDesigner.builtAt)
                                      : "Never"}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-border/50 bg-card/40 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Options
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {(nixDesigner?.optionCount ?? 0).toLocaleString()}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-border/50 bg-card/40 p-3">
                                  <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                    Packages
                                  </div>
                                  <div className="mt-1 text-sm text-foreground">
                                    {(nixDesigner?.packageCount ?? 0).toLocaleString()}
                                  </div>
                                </div>
                              </div>
                              {nixDesigner?.staleReason ? (
                                <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                                  {nixDesigner.staleReason}
                                </div>
                              ) : null}
                              {nixDesigner?.lastError ? (
                                <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                                  {nixDesigner.lastError}
                                </div>
                              ) : null}
                            </div>
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
      <Dialog open={createHostDialogOpen} onOpenChange={handleCreateHostDialogChange}>
        <DialogPopup className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Host</DialogTitle>
            <DialogDescription>
              Start a guided, plan-first workflow for a new host. You can either scaffold it from
              scratch or inspect an existing machine over SSH before translating it to Nix. The new
              thread stays scoped to this host and starts in plan mode.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Host name</span>
              <Input
                autoFocus
                value={createHostName}
                placeholder="example-host"
                onChange={(event) => {
                  setCreateHostName(normalizeHostCreationHostName(event.target.value));
                }}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    createHostNameError === null &&
                    createHostSourceSshTargetError === null
                  ) {
                    event.preventDefault();
                    void handleCreateHostThread();
                  }
                }}
              />
              <span
                className={cn(
                  "text-xs",
                  createHostNameError ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {createHostNameError ?? "Used for the thread scope, t3hosts key, and host path."}
              </span>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Workflow</span>
              <select
                value={createHostBootstrapMode}
                onChange={(event) =>
                  setCreateHostBootstrapMode(
                    event.target.value === "existing-via-ssh" ? "existing-via-ssh" : "new-host",
                  )
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="new-host">Plan a new host</option>
                <option value="existing-via-ssh">Import existing host via SSH</option>
              </select>
              <span className="text-xs text-muted-foreground">
                Use SSH import when you want the agent to inspect a live machine first, present its
                findings, and then translate it into Nix config.
              </span>
            </label>

            {createHostRequiresSshTarget ? (
              <label className="grid gap-1.5">
                <span className="text-xs font-medium text-foreground">SSH discovery target</span>
                <Input
                  value={createHostSourceSshTarget}
                  placeholder="root@example-host"
                  onChange={(event) => setCreateHostSourceSshTarget(event.target.value)}
                />
                <span
                  className={cn(
                    "text-xs",
                    createHostSourceSshTargetError ? "text-destructive" : "text-muted-foreground",
                  )}
                >
                  {createHostSourceSshTargetError ??
                    "Preferred. If you already use SSH keys, load one into your local ssh-agent before starting. The workflow can fall back to a secure password prompt later if key auth is unavailable or fails. Do not paste passwords into the thread."}
                </span>
              </label>
            ) : null}

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Deploy target</span>
              <Input
                value={createHostTarget}
                placeholder={
                  normalizedCreateHostName ||
                  (createHostRequiresSshTarget ? "deployment target" : "host target")
                }
                onChange={(event) => setCreateHostTarget(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                {createHostRequiresSshTarget
                  ? "Optional. This is the eventual deploy target for the flake host. It defaults to the host name until you provide the final target."
                  : "Optional. Defaults to the host name until you provide the final install target."}
              </span>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">OS family</span>
              <select
                value={createHostOsFamily}
                onChange={(event) =>
                  setCreateHostOsFamily(event.target.value === "darwin" ? "darwin" : "nixos")
                }
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >
                <option value="nixos">NixOS</option>
                <option value="darwin">Darwin</option>
              </select>
            </label>

            <label className="grid gap-1.5">
              <span className="text-xs font-medium text-foreground">Host type</span>
              <Input
                value={createHostType}
                placeholder="server, laptop, vm..."
                onChange={(event) => setCreateHostType(event.target.value)}
              />
              <span className="text-xs text-muted-foreground">
                Optional. This seeds the plan but the agent should still discover the repo layout.
              </span>
            </label>
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => handleCreateHostDialogChange(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => void handleCreateHostThread()}
              disabled={
                createHostNameError !== null ||
                createHostSourceSshTargetError !== null ||
                !canCreateHost
              }
            >
              Create thread
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={deployDialogHostSummary !== null}
        onOpenChange={(open) => {
          if (!open) {
            handleCloseDeployDialog();
          }
        }}
      >
        <DialogPopup className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>
              {deployDialogHostSummary
                ? `Deploy ${deployDialogHostSummary.host.name}?`
                : "Deploy host?"}
            </DialogTitle>
            <DialogDescription>
              Review the live preflight checks before opening the dedicated host deployment page.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {deployDialogHostSummary ? (
              <>
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]">
                  <div className="space-y-4">
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
                            documentationStatusClasses(
                              deployDialogHostSummary.documentation.status,
                            ),
                          )}
                        >
                          {formatDocumentationStatusLabel(
                            deployDialogHostSummary.documentation.status,
                          )}
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
                          Activation
                        </div>
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <Button
                            size="sm"
                            variant={
                              deployActivationStrategy === "switch" ? "secondary" : "outline"
                            }
                            disabled={deployingHostName !== null}
                            onClick={() => {
                              setDeployActivationStrategy("switch");
                              setDeployAcknowledgeWarnings(false);
                            }}
                          >
                            Switch live now
                          </Button>
                          <Button
                            size="sm"
                            variant={deployActivationStrategy === "boot" ? "secondary" : "outline"}
                            disabled={deployingHostName !== null}
                            onClick={() => {
                              setDeployActivationStrategy("boot");
                              setDeployAcknowledgeWarnings(false);
                            }}
                          >
                            Stage for reboot
                          </Button>
                        </div>
                        <div className="mt-2 text-xs text-muted-foreground">
                          Choose boot staging when switch inhibitors or reboot-requiring changes
                          make live activation unsafe.
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
                      <div className="space-y-3 rounded-xl border border-border/50 bg-background/50 p-3">
                        <label className="flex items-start gap-3">
                          <Checkbox
                            checked={deployMagicRollback}
                            disabled={deployingHostName !== null}
                            onCheckedChange={(checked) => {
                              setDeployMagicRollback(checked !== false);
                            }}
                            aria-label="Use magic rollback verification"
                          />
                          <span className="min-w-0">
                            <span className="block text-sm font-medium text-foreground">
                              Use magic rollback verification
                            </span>
                            <span className="mt-0.5 block text-xs text-muted-foreground">
                              Keep this enabled for the normal safe path. Disable it only when the
                              deployment is expected to break SSH confirmation entirely, such as a
                              network or host identity change that outlives the reconnect window.
                            </span>
                          </span>
                        </label>
                        {deployMagicRollback ? (
                          <div className="space-y-2">
                            <div>
                              <div className="text-[11px] uppercase tracking-widest text-muted-foreground/70">
                                Confirm Timeout
                              </div>
                              <div className="mt-1 flex items-center gap-2">
                                <div className="w-32">
                                  <Input
                                    type="number"
                                    min={1}
                                    step={1}
                                    inputMode="numeric"
                                    nativeInput
                                    value={deployConfirmTimeoutSecondsInput}
                                    disabled={deployingHostName !== null}
                                    aria-label="Confirm timeout in seconds"
                                    placeholder={String(DEPLOY_RS_DEFAULT_CONFIRM_TIMEOUT_SECONDS)}
                                    onChange={(event) =>
                                      setDeployConfirmTimeoutSecondsInput(event.currentTarget.value)
                                    }
                                  />
                                </div>
                                <span className="text-xs text-muted-foreground">seconds</span>
                              </div>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Leave empty to use deploy-rs&apos; default of{" "}
                              {DEPLOY_RS_DEFAULT_CONFIRM_TIMEOUT_SECONDS} seconds. Increase this
                              when activation temporarily restarts networking and the host needs
                              longer to become reachable again.
                            </div>
                            {deployDialogConfirmTimeoutInvalid ? (
                              <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-800 dark:text-rose-200">
                                Confirm timeout must be a positive number of seconds.
                              </div>
                            ) : null}
                          </div>
                        ) : (
                          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200">
                            deploy-rs will stop waiting for post-activation confirmation and will
                            not auto-rollback if the host becomes unreachable after activation.
                          </div>
                        )}
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
                  </div>

                  <div className="space-y-4 xl:sticky xl:top-0 xl:self-start">
                    {deployDialogPreviewQuery.isError ? (
                      <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-800 dark:text-rose-200">
                        {deployDialogPreviewQuery.error instanceof Error
                          ? deployDialogPreviewQuery.error.message
                          : "Failed to load deployment checks."}
                      </div>
                    ) : deployDialogPreviewQuery.isPending ? (
                      <div className="rounded-xl border border-border/50 bg-background/40 p-3 text-sm text-muted-foreground">
                        Running deployment checks for this host.
                      </div>
                    ) : (
                      <DeploymentReportCard
                        title="Preflight checks"
                        report={deployDialogPreviewReport}
                        emptyMessage="Preflight checks will appear here once the deploy settings are valid."
                        showProceedState
                      />
                    )}

                    {deployDialogHasWarnings ? (
                      <label className="flex items-start gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
                        <Checkbox
                          checked={deployAcknowledgeWarnings}
                          disabled={deployingHostName !== null}
                          onCheckedChange={(checked) => {
                            setDeployAcknowledgeWarnings(checked === true);
                          }}
                          aria-label="Acknowledge deployment warnings"
                        />
                        <span className="min-w-0 text-sm text-amber-900 dark:text-amber-100">
                          Acknowledge warnings and continue with the current workspace state.
                        </span>
                      </label>
                    ) : null}
                  </div>
                </div>
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
                deployingHostName !== null ||
                deployDialogConfirmTimeoutInvalid ||
                deployDialogPreviewQuery.isPending ||
                !deployDialogCanProceed
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
