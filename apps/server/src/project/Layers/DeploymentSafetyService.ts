import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildDeployRsInvocation,
  type DeploymentCheck,
  type DeploymentCheckCode,
  type DeploymentCheckRecommendedAction,
  type DeploymentCheckResult,
  type DeploymentCheckSeverity,
  type DeploymentPostflightReport,
  type DeploymentPreflightReport,
  type FlakeHost,
  type HostDeploymentPreviewInput,
  type HostDeploymentPreviewResult,
  DeploymentSafetyError,
} from "@t3tools/contracts";
import { Effect, FileSystem, Layer, Option, Path } from "effect";

import { GitStatusBroadcaster } from "../../git/Services/GitStatusBroadcaster.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runProcess, type ProcessRunResult } from "../../processRunner.ts";
import { DeployRsResolver } from "../Services/DeployRsResolver.ts";
import {
  DeploymentSafetyService,
  type DeploymentSafetyServiceShape,
} from "../Services/DeploymentSafetyService.ts";
import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";

const DEFAULT_SSH_TIMEOUT_MS = 7_500;
const DEFAULT_DRY_ACTIVATE_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_BUFFER_BYTES = 256 * 1024;
const REMOTE_PREVIEW_SUDO_REQUIRED_MARKER = "__T3_REMOTE_PREVIEW_SUDO_REQUIRED__";
const REMOTE_PREVIEW_ARCHIVE_EXCLUDES = [
  ".git",
  "node_modules",
  "*/node_modules",
  ".turbo",
  "*/.turbo",
  ".direnv",
  "*/.direnv",
  ".devenv",
  "*/.devenv",
  "dist",
  "*/dist",
  "build",
  "*/build",
  ".next",
  "*/.next",
  ".cache",
  "*/.cache",
  "coverage",
  "*/coverage",
  "result",
  "*/result",
] as const;

interface HostConnection {
  readonly targetHost: string;
  readonly sshUser: string | null;
  readonly sshTarget: string | null;
  readonly activationUser: string;
}

function normalizeHostName(value: string): string {
  return value.trim().toLowerCase();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function normalizeNixSystem(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function controllerNixSystem(): string | null {
  if (process.platform === "darwin") {
    if (process.arch === "arm64") {
      return "aarch64-darwin";
    }
    if (process.arch === "x64") {
      return "x86_64-darwin";
    }
    return null;
  }

  if (process.platform === "linux") {
    if (process.arch === "arm64") {
      return "aarch64-linux";
    }
    if (process.arch === "x64") {
      return "x86_64-linux";
    }
    return null;
  }

  return null;
}

function crossSystemDryActivationSkipSummary(host: FlakeHost): string | null {
  const targetSystem = normalizeNixSystem(host.system);
  const controllerSystem = controllerNixSystem();
  if (targetSystem === null || controllerSystem === null || targetSystem === controllerSystem) {
    return null;
  }
  return `The controller is ${controllerSystem} and ${host.name} targets ${targetSystem}, so the live switch preview will run on the host over SSH instead of locally.`;
}

function toDeploymentSafetyError(message: string, cause?: unknown): DeploymentSafetyError {
  return new DeploymentSafetyError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function makeCheck(input: {
  code: DeploymentCheckCode;
  label: string;
  severity: DeploymentCheckSeverity;
  result: DeploymentCheckResult;
  summary: string;
  detail?: string | null;
  recommendedAction?: DeploymentCheckRecommendedAction;
}): DeploymentCheck {
  return {
    code: input.code,
    label: input.label,
    severity: input.severity,
    result: input.result,
    summary: input.summary,
    detail: input.detail?.trim() ? input.detail.trim() : null,
    recommendedAction: input.recommendedAction ?? null,
  };
}

function summarizeOutput(stdout: string, stderr: string): string | null {
  const parts = [stderr.trim(), stdout.trim()].filter((part) => part.length > 0);
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n\n");
}

function containsSwitchInhibitor(output: string): boolean {
  return (
    /Switching into this system is not recommended/i.test(output) ||
    /nixos-rebuild boot/i.test(output) ||
    /NIXOS_NO_CHECK=1/i.test(output) ||
    /changes to critical components of the system/i.test(output)
  );
}

function containsRemotePreviewSudoRequired(output: string): boolean {
  return output.includes(REMOTE_PREVIEW_SUDO_REQUIRED_MARKER);
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function parseSshTarget(value: string): {
  readonly user: string | null;
  readonly host: string;
} {
  const trimmed = value.trim();
  const atIndex = trimmed.lastIndexOf("@");
  if (atIndex <= 0) {
    return {
      user: null,
      host: trimmed,
    };
  }
  return {
    user: trimToNull(trimmed.slice(0, atIndex)),
    host: trimmed.slice(atIndex + 1),
  };
}

function formatSshTarget(host: string, user: string | null): string {
  return user === null ? host : `${user}@${host}`;
}

function resolveHostConnection(host: FlakeHost): HostConnection {
  const parsedTarget = parseSshTarget(host.target);
  const sshUser = trimToNull(host.sshUser) ?? parsedTarget.user;
  return {
    targetHost: parsedTarget.host,
    sshUser,
    sshTarget: sshUser === null ? null : formatSshTarget(parsedTarget.host, sshUser),
    activationUser: trimToNull(host.activationUser) ?? "root",
  };
}

function sshTransportArgs(): ReadonlyArray<string> {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    "LogLevel=ERROR",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    "PasswordAuthentication=no",
    "-o",
    "KbdInteractiveAuthentication=no",
    "-o",
    `ConnectTimeout=${Math.ceil(DEFAULT_SSH_TIMEOUT_MS / 1000)}`,
  ];
}

function buildRemotePreviewArchiveArgs(outputPath: string): ReadonlyArray<string> {
  return [
    ...REMOTE_PREVIEW_ARCHIVE_EXCLUDES.flatMap((pattern) => ["--exclude", pattern] as const),
    "-cf",
    outputPath,
    ".",
  ];
}

function toPreflightReport(input: {
  activationStrategy: HostDeploymentPreviewInput["activationStrategy"];
  acknowledgeWarnings: boolean;
  checks: ReadonlyArray<DeploymentCheck>;
}): DeploymentPreflightReport {
  const checks = [...input.checks];
  const blockingFailureCount = checks.filter(
    (check) => check.severity === "blocking" && check.result === "fail",
  ).length;
  const warningCount = checks.filter((check) => check.result === "warn").length;

  return {
    activationStrategy: input.activationStrategy ?? "switch",
    acknowledgedWarnings: input.acknowledgeWarnings,
    canProceed:
      blockingFailureCount === 0 && (warningCount === 0 || input.acknowledgeWarnings === true),
    blockingFailureCount,
    warningCount,
    checks,
    updatedAt: new Date().toISOString(),
  };
}

interface ResolvedPreviewContext {
  readonly workspaceRoot: string;
  readonly selectedHost: FlakeHost | null;
  readonly flakeExists: boolean;
  readonly deployTarget: "deployable" | "missing-deploy-target" | "evaluation-failed" | "missing";
}

function makeSshReachabilityCheck(host: FlakeHost | null) {
  if (host === null) {
    return Effect.succeed(
      makeCheck({
        code: "ssh-reachability",
        label: "SSH reachability",
        severity: "blocking",
        result: "skipped",
        summary: "Skipped because the host could not be resolved from the flake.",
      }),
    );
  }

  return Effect.promise(async () => {
    const connection = resolveHostConnection(host);
    if (connection.sshTarget === null) {
      return makeCheck({
        code: "ssh-reachability",
        label: "SSH reachability",
        severity: "blocking",
        result: "fail",
        summary: "SSH user is not configured for this host.",
        detail: `Set t3hosts.${host.name}.sshUser so deployments and live previews know which SSH login to use for ${connection.targetHost}.`,
      });
    }

    try {
      const result = await runProcess(
        "ssh",
        [...sshTransportArgs(), connection.sshTarget, "true"],
        {
          allowNonZeroExit: true,
          timeoutMs: DEFAULT_SSH_TIMEOUT_MS,
          maxBufferBytes: DEFAULT_PROCESS_BUFFER_BYTES,
          outputMode: "truncate",
        },
      );

      if (result.code === 0) {
        return makeCheck({
          code: "ssh-reachability",
          label: "SSH reachability",
          severity: "blocking",
          result: "pass",
          summary: `SSH connectivity to ${connection.sshTarget} succeeded.`,
        });
      }

      return makeCheck({
        code: "ssh-reachability",
        label: "SSH reachability",
        severity: "blocking",
        result: "fail",
        summary: `Could not reach ${connection.sshTarget} over SSH.`,
        detail: summarizeOutput(result.stdout, result.stderr),
      });
    } catch (cause) {
      return makeCheck({
        code: "ssh-reachability",
        label: "SSH reachability",
        severity: "blocking",
        result: "fail",
        summary: `Could not reach ${connection.sshTarget} over SSH.`,
        detail: cause instanceof Error ? cause.message : "SSH connectivity check failed.",
      });
    }
  });
}

async function runRemoteLiveSwitchPreview(input: {
  readonly workspaceRoot: string;
  readonly host: FlakeHost;
}): Promise<ProcessRunResult> {
  const connection = resolveHostConnection(input.host);
  if (connection.sshTarget === null) {
    return {
      stdout: "",
      stderr: `Host ${input.host.name} is missing t3hosts.${input.host.name}.sshUser.`,
      code: 125,
      signal: null,
      timedOut: false,
    };
  }

  const transportArgs = sshTransportArgs();
  const localTempDir = await mkdtemp(join(tmpdir(), "t3-deploy-preview-"));
  const localArchivePath = join(localTempDir, "workspace.tar");

  try {
    await runProcess("tar", buildRemotePreviewArchiveArgs(localArchivePath), {
      cwd: input.workspaceRoot,
      env: {
        ...process.env,
        COPYFILE_DISABLE: "1",
      },
      timeoutMs: Math.max(DEFAULT_DRY_ACTIVATE_TIMEOUT_MS, 60_000),
      maxBufferBytes: DEFAULT_PROCESS_BUFFER_BYTES,
      outputMode: "truncate",
    });

    const dryActivateCommand = `nixos-rebuild dry-activate --flake ${shellQuote(`.#${input.host.name}`)}`;
    const remoteScript = [
      "set -eu",
      "TMPDIR=$(mktemp -d)",
      'cleanup() { rm -rf "$TMPDIR"; }',
      "trap cleanup EXIT INT TERM",
      'cat > "$TMPDIR/workspace.tar"',
      'cd "$TMPDIR"',
      "tar -xf workspace.tar",
      "rm -f workspace.tar",
      `if [ "$(id -un)" = ${shellQuote(connection.activationUser)} ]; then`,
      `  ${dryActivateCommand}`,
      `elif sudo -n -u ${shellQuote(connection.activationUser)} true >/dev/null 2>&1; then`,
      `  sudo -n -u ${shellQuote(connection.activationUser)} ${dryActivateCommand}`,
      connection.activationUser === "root"
        ? `elif sudo -n true >/dev/null 2>&1; then\n  sudo -n ${dryActivateCommand}`
        : null,
      "else",
      `  echo ${shellQuote(REMOTE_PREVIEW_SUDO_REQUIRED_MARKER)} >&2`,
      "  exit 125",
      "fi",
    ]
      .filter((line): line is string => line !== null)
      .join("\n");

    const sshInvocation = [
      "ssh",
      ...transportArgs,
      connection.sshTarget,
      "/bin/sh",
      "-lc",
      remoteScript,
    ]
      .map(shellQuote)
      .join(" ");

    return await runProcess(
      "/bin/sh",
      ["-lc", `${sshInvocation} < ${shellQuote(localArchivePath)}`],
      {
        allowNonZeroExit: true,
        timeoutMs: Math.max(DEFAULT_DRY_ACTIVATE_TIMEOUT_MS, 90_000),
        maxBufferBytes: DEFAULT_PROCESS_BUFFER_BYTES,
        outputMode: "truncate",
      },
    );
  } finally {
    await rm(localTempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export const DeploymentSafetyServiceLive = Layer.effect(
  DeploymentSafetyService,
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const flakeMetadataResolver = yield* FlakeMetadataResolver;
    const deployRsResolver = yield* DeployRsResolver;
    const gitStatusBroadcaster = yield* GitStatusBroadcaster;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const resolvePreviewContext = Effect.fn("deploymentSafety.resolvePreviewContext")(function* (
      input: HostDeploymentPreviewInput,
    ) {
      const projectOption = yield* projectionSnapshotQuery
        .getProjectShellById(input.projectId)
        .pipe(
          Effect.mapError((cause) =>
            toDeploymentSafetyError("Failed to load the selected flake.", cause),
          ),
        );
      if (Option.isNone(projectOption)) {
        return yield* toDeploymentSafetyError(`Flake ${input.projectId} was not found.`);
      }

      const project = projectOption.value;
      const flakeFile = path.join(project.workspaceRoot, "flake.nix");
      const flakeExists =
        (yield* fileSystem.stat(flakeFile).pipe(
          Effect.map((stats) => stats.type === "File"),
          Effect.catch(() => Effect.succeed(false)),
        )) === true;

      const flakeMetadata =
        project.flakeMetadata ??
        (yield* flakeMetadataResolver
          .resolve(project.workspaceRoot)
          .pipe(
            Effect.mapError((cause) =>
              toDeploymentSafetyError("Failed to resolve flake host metadata.", cause),
            ),
          ));
      const hosts =
        flakeMetadata.hosts.length > 0
          ? flakeMetadata.hosts
          : flakeMetadata.host
            ? [flakeMetadata.host]
            : [];

      const hostNameNormalized = normalizeHostName(input.hostName);
      const selectedHost =
        hosts.find((host) => normalizeHostName(host.name) === hostNameNormalized) ?? null;

      let deployTarget: ResolvedPreviewContext["deployTarget"] = "missing";
      if (selectedHost !== null) {
        const hostDeployments = yield* deployRsResolver
          .resolveHostDeployments({
            workspaceRoot: project.workspaceRoot,
            hosts,
          })
          .pipe(
            Effect.mapError((cause) =>
              toDeploymentSafetyError("Failed to resolve deploy-rs host targets.", cause),
            ),
          );
        const deployment = hostDeployments.get(hostNameNormalized) ?? null;
        deployTarget =
          deployment === null
            ? "missing"
            : deployment.status === "deployable"
              ? "deployable"
              : (deployment.reason ?? "missing");
      }

      return {
        workspaceRoot: project.workspaceRoot,
        selectedHost,
        flakeExists,
        deployTarget,
      } satisfies ResolvedPreviewContext;
    });

    const preview: DeploymentSafetyServiceShape["preview"] = (input) =>
      Effect.gen(function* () {
        const context = yield* resolvePreviewContext(input);
        const acknowledgeWarnings = input.acknowledgeWarnings === true;
        const activationStrategy = input.activationStrategy ?? "switch";

        const flakeExistsCheck = makeCheck({
          code: "flake-exists",
          label: "flake.nix",
          severity: "blocking",
          result: context.flakeExists ? "pass" : "fail",
          summary: context.flakeExists
            ? "flake.nix is present in the project workspace."
            : "flake.nix is missing from the project workspace.",
        });

        const hostExistsCheck = makeCheck({
          code: "host-exists",
          label: "Host metadata",
          severity: "blocking",
          result: context.selectedHost !== null ? "pass" : "fail",
          summary:
            context.selectedHost !== null
              ? `Host ${input.hostName} exists in the flake metadata.`
              : `Host ${input.hostName} was not found in the flake metadata.`,
        });

        const deployTargetCheck =
          context.selectedHost === null
            ? makeCheck({
                code: "deploy-rs-target",
                label: "deploy-rs target",
                severity: "blocking",
                result: "skipped",
                summary: "Skipped because the host is not present in flake metadata.",
              })
            : context.deployTarget === "deployable"
              ? makeCheck({
                  code: "deploy-rs-target",
                  label: "deploy-rs target",
                  severity: "blocking",
                  result: "pass",
                  summary: `deploy-rs exposes a target for ${context.selectedHost.name}.`,
                })
              : makeCheck({
                  code: "deploy-rs-target",
                  label: "deploy-rs target",
                  severity: "blocking",
                  result: "fail",
                  summary:
                    context.deployTarget === "evaluation-failed"
                      ? "Could not evaluate deploy-rs targets for this flake."
                      : `Host ${input.hostName} does not have a deploy-rs target configured.`,
                });

        const gitStatusCheckEffect = gitStatusBroadcaster.refreshStatus(context.workspaceRoot).pipe(
          Effect.map((status) =>
            status.isRepo
              ? status.hasWorkingTreeChanges
                ? makeCheck({
                    code: "git-status",
                    label: "Git status",
                    severity: "warning",
                    result: "warn",
                    summary: "The git working tree has local changes.",
                    recommendedAction: "acknowledge-warnings",
                  })
                : makeCheck({
                    code: "git-status",
                    label: "Git status",
                    severity: "info",
                    result: "pass",
                    summary: "The git working tree is clean.",
                  })
              : makeCheck({
                  code: "git-status",
                  label: "Git status",
                  severity: "warning",
                  result: "warn",
                  summary: "Git status is unavailable because this workspace is not a repository.",
                  recommendedAction: "acknowledge-warnings",
                }),
          ),
          Effect.catch((cause) =>
            Effect.succeed(
              makeCheck({
                code: "git-status",
                label: "Git status",
                severity: "warning",
                result: "warn",
                summary: "Could not refresh git status for this workspace.",
                detail: cause instanceof Error ? cause.message : "Git status refresh failed.",
                recommendedAction: "acknowledge-warnings",
              }),
            ),
          ),
        );

        const [gitStatusCheck, sshReachabilityCheck] = yield* Effect.all(
          [gitStatusCheckEffect, makeSshReachabilityCheck(context.selectedHost)],
          {
            concurrency: "unbounded",
          },
        );

        const switchActivationPreviewCheck: DeploymentCheck =
          activationStrategy !== "switch"
            ? makeCheck({
                code: "switch-activation-preview",
                label: "Live switch preview",
                severity: "info",
                result: "skipped",
                summary: "Skipped because this deployment is staged for next boot.",
              })
            : context.selectedHost === null || context.deployTarget !== "deployable"
              ? makeCheck({
                  code: "switch-activation-preview",
                  label: "Live switch preview",
                  severity: "blocking",
                  result: "skipped",
                  summary: "Skipped until the host and deploy-rs target are valid.",
                })
              : sshReachabilityCheck.result !== "pass"
                ? makeCheck({
                    code: "switch-activation-preview",
                    label: "Live switch preview",
                    severity: "blocking",
                    result: "skipped",
                    summary: "Skipped until SSH reachability succeeds.",
                  })
                : yield* Effect.promise(async () => {
                    const selectedHost = context.selectedHost;
                    if (selectedHost === null) {
                      return makeCheck({
                        code: "switch-activation-preview",
                        label: "Live switch preview",
                        severity: "blocking",
                        result: "skipped",
                        summary: "Skipped until the host metadata is available.",
                      });
                    }
                    const crossSystemMessage = crossSystemDryActivationSkipSummary(selectedHost);

                    try {
                      const result =
                        crossSystemMessage === null
                          ? await (() => {
                              const invocation = buildDeployRsInvocation(selectedHost.name, {
                                deployOnServer: input.deployOnServer === true,
                                magicRollback: input.magicRollback,
                                confirmTimeoutSeconds: input.confirmTimeoutSeconds,
                                activationStrategy: "switch",
                                dryActivate: true,
                              });
                              return runProcess(invocation.command, invocation.args, {
                                cwd: context.workspaceRoot,
                                allowNonZeroExit: true,
                                timeoutMs: DEFAULT_DRY_ACTIVATE_TIMEOUT_MS,
                                maxBufferBytes: DEFAULT_PROCESS_BUFFER_BYTES,
                                outputMode: "truncate",
                              });
                            })()
                          : await runRemoteLiveSwitchPreview({
                              workspaceRoot: context.workspaceRoot,
                              host: selectedHost,
                            });

                      const detail = summarizeOutput(result.stdout, result.stderr);
                      if (containsRemotePreviewSudoRequired(detail ?? "")) {
                        return makeCheck({
                          code: "switch-activation-preview",
                          label: "Live switch preview",
                          severity: "warning",
                          result: "warn",
                          summary:
                            "Could not run the target-side live switch preview because the configured activation user requires interactive sudo.",
                          detail,
                          recommendedAction: "acknowledge-warnings",
                        });
                      }
                      if (containsSwitchInhibitor(detail ?? "")) {
                        return makeCheck({
                          code: "switch-activation-preview",
                          label: "Live switch preview",
                          severity: "blocking",
                          result: "fail",
                          summary: "Live switch is not recommended for this deployment.",
                          detail,
                          recommendedAction: "use-boot-activation",
                        });
                      }
                      if (result.code === 0) {
                        return makeCheck({
                          code: "switch-activation-preview",
                          label: "Live switch preview",
                          severity: "info",
                          result: "pass",
                          summary:
                            crossSystemMessage === null
                              ? "Live switch dry activation completed without inhibitors."
                              : "Target-side live switch preview completed over SSH without inhibitors.",
                          detail: crossSystemMessage ?? null,
                        });
                      }
                      return makeCheck({
                        code: "switch-activation-preview",
                        label: "Live switch preview",
                        severity: "warning",
                        result: "warn",
                        summary:
                          crossSystemMessage === null
                            ? "Could not complete the live switch dry activation preview."
                            : "Could not complete the target-side live switch preview over SSH.",
                        detail,
                        recommendedAction: "acknowledge-warnings",
                      });
                    } catch (cause) {
                      return makeCheck({
                        code: "switch-activation-preview",
                        label: "Live switch preview",
                        severity: "warning",
                        result: "warn",
                        summary:
                          crossSystemMessage === null
                            ? "Could not complete the live switch dry activation preview."
                            : "Could not complete the target-side live switch preview over SSH.",
                        detail:
                          cause instanceof Error ? cause.message : "Live switch preview failed.",
                        recommendedAction: "acknowledge-warnings",
                      });
                    }
                  });

        return {
          report: toPreflightReport({
            activationStrategy,
            acknowledgeWarnings,
            checks: [
              flakeExistsCheck,
              hostExistsCheck,
              deployTargetCheck,
              gitStatusCheck,
              sshReachabilityCheck,
              switchActivationPreviewCheck,
            ],
          }),
        } satisfies HostDeploymentPreviewResult;
      });

    const buildPostflightReport: DeploymentSafetyServiceShape["buildPostflightReport"] = (input) =>
      Effect.gen(function* () {
        const previewContext = yield* resolvePreviewContext({
          projectId: input.projectId,
          hostName: input.hostName,
          activationStrategy: input.activationStrategy,
        });

        const sshCheck = yield* makeSshReachabilityCheck(previewContext.selectedHost).pipe(
          Effect.map((check) =>
            makeCheck({
              code: "postflight-ssh-reachability",
              label: "Post-deploy SSH reachability",
              severity: check.severity,
              result: check.result,
              summary: check.summary,
              detail: check.detail,
              recommendedAction: check.recommendedAction,
            }),
          ),
        );

        const rebootPendingCheck =
          input.activationStrategy === "boot"
            ? makeCheck({
                code: "reboot-pending",
                label: "Reboot required",
                severity: "warning",
                result: "warn",
                summary: "The deployment is staged for next boot and still needs a reboot.",
              })
            : null;

        return {
          activationStrategy: input.activationStrategy,
          checks: rebootPendingCheck === null ? [sshCheck] : [sshCheck, rebootPendingCheck],
          updatedAt: new Date().toISOString(),
        } satisfies DeploymentPostflightReport;
      });

    return {
      preview,
      buildPostflightReport,
    } satisfies DeploymentSafetyServiceShape;
  }),
);
