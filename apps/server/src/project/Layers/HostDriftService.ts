import crypto from "node:crypto";

import {
  CommandId,
  DEFAULT_RUNTIME_MODE,
  DEFAULT_TERMINAL_ID,
  MessageId,
  ThreadId,
  type FlakeHost,
  type HostDriftCategory,
  type HostDriftCategoryResult,
  type HostDriftGetInput,
  type HostDriftReconcileIntent,
  type HostDriftStatus,
  type HostDriftSummary,
  type HostDriftTerminalEvent,
  type HostDriftTerminalSnapshot,
  HostDriftError,
  type ModelSelection,
  type ProjectId,
  type ProviderKind,
  type ServerProvider,
} from "@t3tools/contracts";
import { listLoginShellCandidates, readEnvironmentFromLoginShell } from "@t3tools/shared/shell";
import {
  Cache,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";

import { runProcess } from "../../processRunner.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HostDriftRepository } from "../../persistence/Services/HostDrift.ts";
import {
  isActiveHostDriftStatus,
  type PersistedHostDrift,
} from "../../persistence/Services/HostDrift.ts";
import { ProviderRegistry } from "../../provider/Services/ProviderRegistry.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { EphemeralWorkflowSecretVault } from "../Services/EphemeralWorkflowSecretVault.ts";
import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";
import { HostDriftService, type HostDriftServiceShape } from "../Services/HostDriftService.ts";

const HOST_DRIFT_OWNER_PREFIX = "host-drift:";
const MAX_PROMPT_RESPONSES = 6;
const SSH_PASSWORD_PROMPT = /password:\s*$/i;
const SSH_AUTH_FAILURE =
  /permission denied|authentication failed|no supported authentication methods/i;
const SSH_HOST_KEY_FAILURE =
  /host key verification failed|remote host identification has changed|offending .* key/i;
const SUDO_AUTH_FAILURE = /sorry, try again|incorrect password attempt|a password is required/i;
const HOST_DRIFT_NEEDS_SUDO_MARKER = "__T3_HOST_DRIFT_NEEDS_SUDO__";
const HOST_DRIFT_SUDO_PROMPT = "__T3_HOST_DRIFT_SUDO_PASSWORD__";
const DEFAULT_SSH_TIMEOUT_SECONDS = 8;
const DEFAULT_NIX_EVAL_TIMEOUT_MS = 20_000;
const DEFAULT_PROCESS_BUFFER_BYTES = 512 * 1024;

type DriftRunnerPhase = "key" | "ssh-password" | "sudo-password";

type DesiredDriftSnapshot = {
  readonly [K in HostDriftCategory]:
    | {
        readonly resolved: true;
        readonly value: unknown;
      }
    | {
        readonly resolved: false;
        readonly detail: string;
      };
};

type ObservedDriftSnapshot = {
  readonly identity: {
    readonly hostname: string | null;
  } | null;
  readonly system: string | null;
  readonly users: ReadonlyArray<string> | null;
  readonly enabledServices: ReadonlyArray<string> | null;
  readonly firewallPorts: {
    readonly tcp: ReadonlyArray<number>;
    readonly udp: ReadonlyArray<number>;
  } | null;
};

interface HostConnection {
  readonly targetHost: string;
  readonly sshUser: string | null;
  readonly sshTarget: string | null;
}

interface HostDriftRunState {
  readonly projectId: ProjectId;
  readonly hostName: string;
  readonly hostNameNormalized: string;
  readonly sshTarget: string;
  readonly terminalOwnerId: string;
  readonly cwd: string;
  readonly desiredSnapshot: DesiredDriftSnapshot;
  phase: DriftRunnerPhase;
  outputTail: string;
  activeSshPassword: string | null;
  activeSudoPassword: string | null;
  readonly redactedSecrets: Set<string>;
  sshPromptResponses: number;
  sudoPromptResponses: number;
}

function normalizeHostName(value: string): string {
  return value.trim().toLowerCase();
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
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sshTransportArgs(): ReadonlyArray<string> {
  return [
    "-o",
    "LogLevel=ERROR",
    "-o",
    "StrictHostKeyChecking=no",
    "-o",
    "UserKnownHostsFile=/dev/null",
    "-o",
    `ConnectTimeout=${DEFAULT_SSH_TIMEOUT_SECONDS}`,
  ];
}

function ownerIdFor(projectId: ProjectId, hostNameNormalized: string): string {
  return `${HOST_DRIFT_OWNER_PREFIX}${projectId}:${hostNameNormalized}`;
}

function toHostDriftError(message: string, cause?: unknown): HostDriftError {
  return new HostDriftError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toSummary(row: PersistedHostDrift): HostDriftSummary {
  const { hostNameNormalized: _ignoredHostNameNormalized, ...summary } = row;
  return summary;
}

function toPersisted(summary: HostDriftSummary, hostNameNormalized: string): PersistedHostDrift {
  return {
    ...summary,
    hostNameNormalized,
  };
}

function mapTerminalSnapshot(snapshot: {
  threadId: string;
  terminalId: string;
  cwd: string;
  worktreePath: string | null;
  status: "starting" | "running" | "exited" | "error";
  pid: number | null;
  history: string;
  exitCode: number | null;
  exitSignal: number | null;
  updatedAt: string;
}): HostDriftTerminalSnapshot {
  return {
    terminalOwnerId: snapshot.threadId,
    terminalId: snapshot.terminalId,
    cwd: snapshot.cwd,
    worktreePath: snapshot.worktreePath,
    status: snapshot.status,
    pid: snapshot.pid,
    history: snapshot.history,
    exitCode: snapshot.exitCode,
    exitSignal: snapshot.exitSignal,
    updatedAt: snapshot.updatedAt,
  };
}

function mapTerminalEvent(event: {
  type: HostDriftTerminalEvent["type"];
  threadId: string;
  terminalId: string;
  createdAt: string;
  snapshot?: {
    threadId: string;
    terminalId: string;
    cwd: string;
    worktreePath: string | null;
    status: "starting" | "running" | "exited" | "error";
    pid: number | null;
    history: string;
    exitCode: number | null;
    exitSignal: number | null;
    updatedAt: string;
  };
  data?: string;
  exitCode?: number | null;
  exitSignal?: number | null;
  message?: string;
  hasRunningSubprocess?: boolean;
}): HostDriftTerminalEvent {
  switch (event.type) {
    case "started":
    case "restarted":
      return {
        type: event.type,
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        snapshot: mapTerminalSnapshot(event.snapshot!),
      };
    case "output":
      return {
        type: "output",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        data: event.data!,
      };
    case "exited":
      return {
        type: "exited",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        exitCode: event.exitCode ?? null,
        exitSignal: event.exitSignal ?? null,
      };
    case "error":
      return {
        type: "error",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        message: event.message!,
      };
    case "cleared":
      return {
        type: "cleared",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
      };
    case "activity":
      return {
        type: "activity",
        terminalOwnerId: event.threadId,
        terminalId: event.terminalId,
        createdAt: event.createdAt,
        hasRunningSubprocess: event.hasRunningSubprocess ?? false,
      };
  }
}

function sanitizePlainOutput(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "");
}

function capTail(value: string, maxLength = 512): string {
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(value.length - maxLength);
}

function redactText(value: string, secrets: Iterable<string>): string {
  let next = value;
  const candidates = [...secrets]
    .flatMap((secret) =>
      secret.length > 0 ? [secret, `${secret}\r\n`, `${secret}\n`, `${secret}\r`] : [],
    )
    .toSorted((left, right) => right.length - left.length);
  for (const secret of candidates) {
    next = next.split(secret).join("[redacted]");
  }
  return next;
}

function findSshAgentSocket(): string | null {
  const existing = process.env.SSH_AUTH_SOCK?.trim();
  if (existing) {
    return existing;
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    return null;
  }
  for (const shell of listLoginShellCandidates(process.platform, process.env.SHELL)) {
    try {
      const environment = readEnvironmentFromLoginShell(shell, ["SSH_AUTH_SOCK"]);
      const socket = environment.SSH_AUTH_SOCK?.trim();
      if (socket) {
        return socket;
      }
    } catch {
      continue;
    }
  }
  return null;
}

function categoryStartMarker(category: HostDriftCategory): string {
  return `__T3_HOST_DRIFT_${category.toUpperCase()}_START__`;
}

function categoryEndMarker(category: HostDriftCategory): string {
  return `__T3_HOST_DRIFT_${category.toUpperCase()}_END__`;
}

function extractCategoryBlock(history: string, category: HostDriftCategory): string | null {
  const startMarker = categoryStartMarker(category);
  const endMarker = categoryEndMarker(category);
  const startIndex = history.lastIndexOf(startMarker);
  if (startIndex === -1) {
    return null;
  }
  const afterStart = startIndex + startMarker.length;
  const endIndex = history.indexOf(endMarker, afterStart);
  if (endIndex === -1) {
    return null;
  }
  const extracted = history.slice(afterStart, endIndex).trim();
  return extracted.length > 0 ? extracted : "";
}

function parseListBlock(value: string | null): ReadonlyArray<string> | null {
  if (value === null) {
    return null;
  }
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .toSorted((left, right) => left.localeCompare(right));
}

function addPorts(target: Set<number>, raw: string) {
  for (const part of raw.split(",")) {
    const value = Number.parseInt(part.trim(), 10);
    if (!Number.isNaN(value) && value > 0 && value <= 65_535) {
      target.add(value);
    }
  }
}

function parseFirewallPorts(raw: string | null): {
  readonly tcp: ReadonlyArray<number>;
  readonly udp: ReadonlyArray<number>;
} | null {
  if (raw === null) {
    return null;
  }
  const tcp = new Set<number>();
  const udp = new Set<number>();

  for (const match of raw.matchAll(/\b(tcp|udp)\b[^\n]*?\bdport\b\s+\{\s*([0-9,\s]+)\s*\}/g)) {
    const protocol = match[1];
    const ports = match[2];
    if (protocol !== undefined && ports !== undefined) {
      addPorts(protocol === "tcp" ? tcp : udp, ports);
    }
  }
  for (const match of raw.matchAll(/\b(tcp|udp)\b[^\n]*?\bdport\b\s+([0-9]+)/g)) {
    const protocol = match[1];
    const rawValue = match[2];
    const value = rawValue === undefined ? Number.NaN : Number.parseInt(rawValue, 10);
    if (protocol !== undefined && !Number.isNaN(value) && value > 0 && value <= 65_535) {
      (protocol === "tcp" ? tcp : udp).add(value);
    }
  }
  for (const match of raw.matchAll(/-p\s+(tcp|udp)[^\n]*?--dport\s+([0-9]+)/g)) {
    const protocol = match[1];
    const rawValue = match[2];
    const value = rawValue === undefined ? Number.NaN : Number.parseInt(rawValue, 10);
    if (protocol !== undefined && !Number.isNaN(value) && value > 0 && value <= 65_535) {
      (protocol === "tcp" ? tcp : udp).add(value);
    }
  }

  return {
    tcp: [...tcp].toSorted((left, right) => left - right),
    udp: [...udp].toSorted((left, right) => left - right),
  };
}

function parseObservedDriftSnapshot(history: string): ObservedDriftSnapshot {
  const plainHistory = sanitizePlainOutput(history);
  const identityBlock = extractCategoryBlock(plainHistory, "identity");
  const systemBlock = extractCategoryBlock(plainHistory, "system");
  const usersBlock = extractCategoryBlock(plainHistory, "users");
  const enabledServicesBlock = extractCategoryBlock(plainHistory, "enabledServices");
  const firewallPortsBlock = extractCategoryBlock(plainHistory, "firewallPorts");

  return {
    identity:
      identityBlock === null
        ? null
        : {
            hostname: trimToNull(identityBlock),
          },
    system: trimToNull(systemBlock),
    users: parseListBlock(usersBlock),
    enabledServices: parseListBlock(enabledServicesBlock),
    firewallPorts: parseFirewallPorts(firewallPortsBlock),
  };
}

function sortedUniqueStrings(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [
    ...new Set(values.map((value) => value.trim()).filter((value) => value.length > 0)),
  ].toSorted((left, right) => left.localeCompare(right));
}

function sortedUniqueInts(values: ReadonlyArray<number>): ReadonlyArray<number> {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value > 0))].toSorted(
    (left, right) => left - right,
  );
}

function diffStrings(
  desired: ReadonlyArray<string>,
  observed: ReadonlyArray<string>,
): { readonly missing: ReadonlyArray<string>; readonly extra: ReadonlyArray<string> } {
  const desiredSet = new Set(desired);
  const observedSet = new Set(observed);
  return {
    missing: desired.filter((value) => !observedSet.has(value)),
    extra: observed.filter((value) => !desiredSet.has(value)),
  };
}

function diffNumbers(
  desired: ReadonlyArray<number>,
  observed: ReadonlyArray<number>,
): { readonly missing: ReadonlyArray<number>; readonly extra: ReadonlyArray<number> } {
  const desiredSet = new Set(desired);
  const observedSet = new Set(observed);
  return {
    missing: desired.filter((value) => !observedSet.has(value)),
    extra: observed.filter((value) => !desiredSet.has(value)),
  };
}

function asProviderModelSelection(provider: ProviderKind, model: string): ModelSelection {
  switch (provider) {
    case "codex":
      return { provider, model };
    case "claudeAgent":
      return { provider, model };
    case "cursor":
      return { provider, model };
    case "opencode":
      return { provider, model };
  }
}

function chooseFallbackModelSelection(
  providers: ReadonlyArray<ServerProvider>,
): ModelSelection | null {
  for (const provider of providers) {
    if (!provider.enabled || !provider.installed || provider.status === "disabled") {
      continue;
    }
    const model = provider.models[0]?.slug ?? null;
    if (!model) {
      continue;
    }
    return asProviderModelSelection(provider.provider, model);
  }
  return null;
}

function buildReconcileThreadTitle(hostName: string, intent: HostDriftReconcileIntent): string {
  return intent === "reconcile-flake-to-host"
    ? `Reconcile flake to host: ${hostName}`
    : `Reconcile host to flake: ${hostName}`;
}

function buildReconcilePrompt(input: {
  readonly hostName: string;
  readonly intent: HostDriftReconcileIntent;
  readonly summary: HostDriftSummary;
}): string {
  const intentDescription =
    input.intent === "reconcile-flake-to-host"
      ? "Update the flake so the declared state matches the live host where appropriate."
      : "Update the host so the live state converges on the flake where appropriate.";
  const payload = JSON.stringify(
    {
      hostName: input.summary.hostName,
      status: input.summary.status,
      categoryResults: input.summary.categoryResults,
      updatedAt: input.summary.updatedAt,
    },
    null,
    2,
  );
  return [
    `Plan a reconciliation workflow for host ${input.hostName}.`,
    intentDescription,
    "Do not implement changes yet.",
    "Use the structured drift payload below as the source of truth, call out uncertainties, and keep the blast radius minimal.",
    "Finish with a single decision-complete <proposed_plan>.",
    "",
    "```json",
    payload,
    "```",
  ].join("\n");
}

function buildRemoteObservationScript(phase: DriftRunnerPhase): string {
  const needsInteractiveSudo = phase === "sudo-password";
  return [
    "set -eu",
    `printf '%s\\n' ${shellQuote(categoryStartMarker("identity"))}`,
    "(hostname 2>/dev/null || uname -n || true)",
    `printf '%s\\n' ${shellQuote(categoryEndMarker("identity"))}`,
    `printf '%s\\n' ${shellQuote(categoryStartMarker("system"))}`,
    "(nix eval --impure --raw --expr builtins.currentSystem 2>/dev/null || true)",
    `printf '%s\\n' ${shellQuote(categoryEndMarker("system"))}`,
    `printf '%s\\n' ${shellQuote(categoryStartMarker("users"))}`,
    "(getent passwd 2>/dev/null || cat /etc/passwd 2>/dev/null || true) | awk -F: '($3 == 0) || ($3 >= 1000 && $1 != \"nobody\") { print $1 }' | sort -u",
    `printf '%s\\n' ${shellQuote(categoryEndMarker("users"))}`,
    `printf '%s\\n' ${shellQuote(categoryStartMarker("enabledServices"))}`,
    "(systemctl list-unit-files --type=service --state=enabled --no-legend --no-pager 2>/dev/null || true) | awk '{ print $1 }' | sed 's/\\.service$//' | sort -u",
    `printf '%s\\n' ${shellQuote(categoryEndMarker("enabledServices"))}`,
    needsInteractiveSudo
      ? `sudo -p ${shellQuote(HOST_DRIFT_SUDO_PROMPT)} -v`
      : `if ! sudo -n true >/dev/null 2>&1; then echo ${shellQuote(HOST_DRIFT_NEEDS_SUDO_MARKER)}; exit 42; fi`,
    `printf '%s\\n' ${shellQuote(categoryStartMarker("firewallPorts"))}`,
    "(sudo -n sh -lc 'nft list ruleset 2>/dev/null || iptables-save 2>/dev/null || true') || true",
    `printf '%s\\n' ${shellQuote(categoryEndMarker("firewallPorts"))}`,
  ].join("\n");
}

function buildDriftCommand(sshTarget: string, phase: DriftRunnerPhase): string {
  const sshCommand = [
    "ssh",
    ...sshTransportArgs(),
    sshTarget,
    "/bin/sh",
    "-lc",
    shellQuote(buildRemoteObservationScript(phase)),
  ]
    .map(shellQuote)
    .join(" ");
  return `/bin/sh -lc ${shellQuote(sshCommand)}`;
}

function normalizeNixSystem(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized.length > 0 ? normalized : null;
}

function resolvedSnapshotValue<T>(value: T): { readonly resolved: true; readonly value: T } {
  return {
    resolved: true,
    value,
  };
}

function formatUnknownResult(
  category: HostDriftCategory,
  summary: string,
  updatedAt: string,
  detail?: string | null,
  desiredValue?: unknown,
  observedValue?: unknown,
): HostDriftCategoryResult {
  return {
    category,
    status: "unknown",
    summary,
    detail: detail?.trim() ? detail.trim() : null,
    desiredValue: desiredValue ?? null,
    observedValue: observedValue ?? null,
    updatedAt,
  };
}

const makeHostDriftService = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const providerRegistry = yield* ProviderRegistry;
  const flakeMetadataResolver = yield* FlakeMetadataResolver;
  const terminalManager = yield* TerminalManager;
  const hostDriftRepository = yield* HostDriftRepository;
  const secretVault = yield* EphemeralWorkflowSecretVault;

  const ownerLockCache = yield* Cache.make({
    capacity: 256,
    timeToLive: Duration.minutes(10),
    lookup: () => Semaphore.make(1),
  });

  const runStatesRef = yield* SynchronizedRef.make(new Map<string, HostDriftRunState>());

  const withOwnerLock = <A, E, R>(
    terminalOwnerId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(Cache.get(ownerLockCache, terminalOwnerId), (semaphore) =>
      semaphore.withPermit(effect),
    );

  const getRunState = (terminalOwnerId: string) =>
    SynchronizedRef.get(runStatesRef).pipe(Effect.map((current) => current.get(terminalOwnerId)));

  const rememberRunState = (state: HostDriftRunState) =>
    SynchronizedRef.update(runStatesRef, (current) => {
      const next = new Map(current);
      next.set(state.terminalOwnerId, state);
      return next;
    });

  const registerOutputSanitizer = (state: HostDriftRunState) =>
    terminalManager.registerOutputSanitizer(state.terminalOwnerId, (chunk) =>
      redactText(chunk, state.redactedSecrets),
    );

  const clearRunSecrets = (state: HostDriftRunState) => {
    state.activeSshPassword = null;
    state.activeSudoPassword = null;
    state.outputTail = "";
    state.sshPromptResponses = 0;
    state.sudoPromptResponses = 0;
  };

  const clearRunState = (state: HostDriftRunState) =>
    Effect.all([
      SynchronizedRef.update(runStatesRef, (current) => {
        const next = new Map(current);
        next.delete(state.terminalOwnerId);
        return next;
      }),
      secretVault.clearThread(state.terminalOwnerId),
      terminalManager.unregisterOutputSanitizer(state.terminalOwnerId),
    ]).pipe(Effect.asVoid);

  const getPersisted = (input: HostDriftGetInput) =>
    hostDriftRepository
      .getByProjectAndHost({
        projectId: input.projectId,
        hostNameNormalized: normalizeHostName(input.hostName),
      })
      .pipe(
        Effect.mapError((cause) => toHostDriftError("Failed to load host drift state.", cause)),
      );

  const updateSummary = (input: {
    readonly projectId: ProjectId;
    readonly hostNameNormalized: string;
    readonly mutate: (current: PersistedHostDrift) => PersistedHostDrift;
  }) =>
    hostDriftRepository
      .getByProjectAndHost({
        projectId: input.projectId,
        hostNameNormalized: input.hostNameNormalized,
      })
      .pipe(
        Effect.mapError((cause) => toHostDriftError("Failed to load host drift state.", cause)),
        Effect.flatMap((current) =>
          Option.match(current, {
            onNone: () => Effect.succeed(null),
            onSome: (value) =>
              hostDriftRepository.upsert(input.mutate(value)).pipe(
                Effect.mapError((cause) =>
                  toHostDriftError("Failed to persist host drift state.", cause),
                ),
                Effect.as(input.mutate(value)),
              ),
          }),
        ),
      );

  const resolveStartContext = Effect.fn("hostDrift.resolveStartContext")(function* (
    input: HostDriftGetInput,
  ) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
      Effect.mapError((cause) => toHostDriftError("Failed to load the selected flake.", cause)),
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () => Effect.fail(toHostDriftError(`Flake ${input.projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

    const flakeMetadata =
      project.flakeMetadata ??
      (yield* flakeMetadataResolver
        .resolve(project.workspaceRoot)
        .pipe(
          Effect.mapError((cause) =>
            toHostDriftError("Failed to resolve flake host metadata.", cause),
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

    if (selectedHost === null) {
      return yield* toHostDriftError(`Host ${input.hostName} was not found in the selected flake.`);
    }

    const connection = resolveHostConnection(selectedHost);
    if (connection.sshTarget === null) {
      return yield* toHostDriftError(
        `Host ${selectedHost.name} is missing halHosts.${selectedHost.name}.sshUser.`,
      );
    }

    return {
      project,
      selectedHost,
      hostNameNormalized,
      terminalOwnerId: ownerIdFor(input.projectId, hostNameNormalized),
      sshTarget: connection.sshTarget,
      cwd: project.workspaceRoot,
    } as const;
  });

  const runNixEvalJson = Effect.fn("hostDrift.runNixEvalJson")(function* (
    workspaceRoot: string,
    attrPath: string,
  ) {
    return yield* Effect.tryPromise({
      try: async () => {
        const result = await runProcess("nix", ["eval", "--json", attrPath], {
          cwd: workspaceRoot,
          timeoutMs: DEFAULT_NIX_EVAL_TIMEOUT_MS,
          maxBufferBytes: DEFAULT_PROCESS_BUFFER_BYTES,
          outputMode: "truncate",
        });
        return JSON.parse(result.stdout);
      },
      catch: (cause) =>
        new HostDriftError({
          message: `Failed to evaluate ${attrPath} for host drift resolution.`,
          cause,
        }),
    });
  });

  const resolveDesiredSnapshot = Effect.fn("hostDrift.resolveDesiredSnapshot")(function* (
    workspaceRoot: string,
    host: FlakeHost,
  ) {
    const desiredIdentity = {
      hostName: host.name,
      target: host.target,
      sshUser: host.sshUser ?? null,
      activationUser: host.activationUser ?? null,
      type: host.type ?? null,
    };

    const desiredSystem = normalizeNixSystem(host.system);
    const fallbackUnknown = (detail: string) =>
      ({
        resolved: false as const,
        detail,
      }) as const;

    if (host.type !== "nixos") {
      return {
        identity: resolvedSnapshotValue(desiredIdentity),
        system:
          desiredSystem === null
            ? fallbackUnknown("The host does not declare a target system in halHosts.")
            : resolvedSnapshotValue(desiredSystem),
        users: fallbackUnknown("User drift is only resolved for nixos hosts in this MVP."),
        enabledServices: fallbackUnknown(
          "Enabled service drift is only resolved for nixos hosts in this MVP.",
        ),
        firewallPorts: fallbackUnknown(
          "Firewall drift is only resolved for nixos hosts in this MVP.",
        ),
      };
    }

    const hostAttr = `.#
      nixosConfigurations.${host.name}`.replace(/\s+/g, "");
    const [usersValue, servicesValue, firewallValue] = yield* Effect.all(
      [
        runNixEvalJson(workspaceRoot, `${hostAttr}.config.users.users`).pipe(
          Effect.catch(() => Effect.succeed(null)),
        ),
        runNixEvalJson(workspaceRoot, `${hostAttr}.config.systemd.services`).pipe(
          Effect.catch(() => Effect.succeed(null)),
        ),
        runNixEvalJson(workspaceRoot, `${hostAttr}.config.networking.firewall`).pipe(
          Effect.catch(() => Effect.succeed(null)),
        ),
      ] as const,
      { concurrency: "unbounded" },
    );

    const users =
      usersValue && typeof usersValue === "object"
        ? sortedUniqueStrings(
            Object.entries(usersValue as Record<string, unknown>)
              .filter(([name, config]) => {
                if (name === "root") {
                  return true;
                }
                if (!config || typeof config !== "object") {
                  return false;
                }
                return (config as Record<string, unknown>).isNormalUser === true;
              })
              .map(([name]) => name),
          )
        : null;

    const enabledServices =
      servicesValue && typeof servicesValue === "object"
        ? sortedUniqueStrings(
            Object.entries(servicesValue as Record<string, unknown>)
              .filter(([, config]) => {
                if (!config || typeof config !== "object") {
                  return false;
                }
                const wantedBy = (config as Record<string, unknown>).wantedBy;
                return Array.isArray(wantedBy) && wantedBy.length > 0;
              })
              .map(([name]) => name),
          )
        : null;

    const firewallPorts =
      firewallValue && typeof firewallValue === "object"
        ? {
            tcp: sortedUniqueInts(
              Array.isArray((firewallValue as Record<string, unknown>).allowedTCPPorts)
                ? ((firewallValue as Record<string, unknown>).allowedTCPPorts as number[])
                : [],
            ),
            udp: sortedUniqueInts(
              Array.isArray((firewallValue as Record<string, unknown>).allowedUDPPorts)
                ? ((firewallValue as Record<string, unknown>).allowedUDPPorts as number[])
                : [],
            ),
          }
        : null;

    return {
      identity: resolvedSnapshotValue(desiredIdentity),
      system:
        desiredSystem === null
          ? fallbackUnknown("The host does not declare a target system in halHosts.")
          : resolvedSnapshotValue(desiredSystem),
      users:
        users === null
          ? fallbackUnknown("Could not resolve declared users from the flake.")
          : resolvedSnapshotValue(users),
      enabledServices:
        enabledServices === null
          ? fallbackUnknown("Could not resolve declared enabled services from the flake.")
          : resolvedSnapshotValue(enabledServices),
      firewallPorts:
        firewallPorts === null
          ? fallbackUnknown("Could not resolve declared firewall ports from the flake.")
          : resolvedSnapshotValue(firewallPorts),
    };
  });

  const buildCategoryResults = (
    desiredSnapshot: DesiredDriftSnapshot,
    observedSnapshot: ObservedDriftSnapshot,
    updatedAt: string,
  ): ReadonlyArray<HostDriftCategoryResult> => {
    const results: HostDriftCategoryResult[] = [];

    const desiredIdentity = desiredSnapshot.identity;
    const observedIdentity = observedSnapshot.identity;
    if (
      !desiredIdentity.resolved ||
      observedIdentity === null ||
      observedIdentity.hostname === null
    ) {
      results.push(
        formatUnknownResult(
          "identity",
          "Could not compare host identity.",
          updatedAt,
          !desiredIdentity.resolved ? desiredIdentity.detail : "Remote hostname was unavailable.",
          desiredIdentity.resolved ? desiredIdentity.value : null,
          observedIdentity,
        ),
      );
    } else {
      const desired = desiredIdentity.value as {
        readonly hostName: string;
      };
      const observed = observedIdentity.hostname;
      const matches = normalizeHostName(desired.hostName) === normalizeHostName(observed);
      results.push({
        category: "identity",
        status: matches ? "match" : "drift",
        summary: matches
          ? `Observed hostname ${observed} matches ${desired.hostName}.`
          : `Observed hostname ${observed} differs from ${desired.hostName}.`,
        detail: null,
        desiredValue: desiredIdentity.value,
        observedValue: observedIdentity,
        updatedAt,
      });
    }

    const desiredSystem = desiredSnapshot.system;
    if (!desiredSystem.resolved || observedSnapshot.system === null) {
      results.push(
        formatUnknownResult(
          "system",
          "Could not compare the target system.",
          updatedAt,
          !desiredSystem.resolved ? desiredSystem.detail : "Live system metadata was unavailable.",
          desiredSystem.resolved ? desiredSystem.value : null,
          observedSnapshot.system,
        ),
      );
    } else {
      const desired = normalizeNixSystem(String(desiredSystem.value));
      const observed = normalizeNixSystem(observedSnapshot.system);
      const matches = desired !== null && desired === observed;
      results.push({
        category: "system",
        status: matches ? "match" : "drift",
        summary: matches
          ? `Observed system ${observedSnapshot.system} matches the flake target.`
          : `Observed system ${observedSnapshot.system} differs from ${String(desiredSystem.value)}.`,
        detail: null,
        desiredValue: desiredSystem.value,
        observedValue: observedSnapshot.system,
        updatedAt,
      });
    }

    const desiredUsers = desiredSnapshot.users;
    if (!desiredUsers.resolved || observedSnapshot.users === null) {
      results.push(
        formatUnknownResult(
          "users",
          "Could not compare declared users.",
          updatedAt,
          !desiredUsers.resolved ? desiredUsers.detail : "Live user data was unavailable.",
          desiredUsers.resolved ? desiredUsers.value : null,
          observedSnapshot.users,
        ),
      );
    } else {
      const desired = desiredUsers.value as ReadonlyArray<string>;
      const observed = observedSnapshot.users;
      const { missing, extra } = diffStrings(desired, observed);
      results.push({
        category: "users",
        status: missing.length === 0 && extra.length === 0 ? "match" : "drift",
        summary:
          missing.length === 0 && extra.length === 0
            ? "Declared users match the live host."
            : "Declared users differ from the live host.",
        detail:
          missing.length === 0 && extra.length === 0
            ? null
            : [
                `Missing on host: ${missing.join(", ") || "none"}`,
                `Extra on host: ${extra.join(", ") || "none"}`,
              ].join("\n"),
        desiredValue: desired,
        observedValue: observed,
        updatedAt,
      });
    }

    const desiredServices = desiredSnapshot.enabledServices;
    if (!desiredServices.resolved || observedSnapshot.enabledServices === null) {
      results.push(
        formatUnknownResult(
          "enabledServices",
          "Could not compare enabled services.",
          updatedAt,
          !desiredServices.resolved
            ? desiredServices.detail
            : "Live enabled service data was unavailable.",
          desiredServices.resolved ? desiredServices.value : null,
          observedSnapshot.enabledServices,
        ),
      );
    } else {
      const desired = desiredServices.value as ReadonlyArray<string>;
      const observed = observedSnapshot.enabledServices;
      const { missing, extra } = diffStrings(desired, observed);
      results.push({
        category: "enabledServices",
        status: missing.length === 0 && extra.length === 0 ? "match" : "drift",
        summary:
          missing.length === 0 && extra.length === 0
            ? "Declared enabled services match the live host."
            : "Declared enabled services differ from the live host.",
        detail:
          missing.length === 0 && extra.length === 0
            ? null
            : [
                `Missing on host: ${missing.join(", ") || "none"}`,
                `Extra on host: ${extra.join(", ") || "none"}`,
              ].join("\n"),
        desiredValue: desired,
        observedValue: observed,
        updatedAt,
      });
    }

    const desiredFirewall = desiredSnapshot.firewallPorts;
    if (!desiredFirewall.resolved || observedSnapshot.firewallPorts === null) {
      results.push(
        formatUnknownResult(
          "firewallPorts",
          "Could not compare firewall ports.",
          updatedAt,
          !desiredFirewall.resolved
            ? desiredFirewall.detail
            : "Live firewall port data was unavailable.",
          desiredFirewall.resolved ? desiredFirewall.value : null,
          observedSnapshot.firewallPorts,
        ),
      );
    } else {
      const desired = desiredFirewall.value as {
        readonly tcp: ReadonlyArray<number>;
        readonly udp: ReadonlyArray<number>;
      };
      const observed = observedSnapshot.firewallPorts;
      const tcpDiff = diffNumbers(desired.tcp, observed.tcp);
      const udpDiff = diffNumbers(desired.udp, observed.udp);
      const matches =
        tcpDiff.missing.length === 0 &&
        tcpDiff.extra.length === 0 &&
        udpDiff.missing.length === 0 &&
        udpDiff.extra.length === 0;
      results.push({
        category: "firewallPorts",
        status: matches ? "match" : "drift",
        summary: matches
          ? "Declared firewall ports match the live host."
          : "Declared firewall ports differ from the live host.",
        detail: matches
          ? null
          : [
              `Missing TCP on host: ${tcpDiff.missing.join(", ") || "none"}`,
              `Extra TCP on host: ${tcpDiff.extra.join(", ") || "none"}`,
              `Missing UDP on host: ${udpDiff.missing.join(", ") || "none"}`,
              `Extra UDP on host: ${udpDiff.extra.join(", ") || "none"}`,
            ].join("\n"),
        desiredValue: desired,
        observedValue: observed,
        updatedAt,
      });
    }

    return results;
  };

  const persistCategoryResults = (
    state: HostDriftRunState,
    results: ReadonlyArray<HostDriftCategoryResult>,
  ) =>
    hostDriftRepository
      .replaceCategoryResults({
        projectId: state.projectId,
        hostNameNormalized: state.hostNameNormalized,
        categoryResults: results,
      })
      .pipe(
        Effect.mapError((cause) =>
          toHostDriftError("Failed to persist host drift category results.", cause),
        ),
      );

  const launchPhase = Effect.fn("hostDrift.launchPhase")(function* (
    state: HostDriftRunState,
    nextPhase: DriftRunnerPhase,
  ) {
    state.phase = nextPhase;
    state.outputTail = "";
    state.sshPromptResponses = 0;
    state.sudoPromptResponses = 0;

    yield* registerOutputSanitizer(state);
    const sshAgentSocket = findSshAgentSocket();

    const current = yield* hostDriftRepository
      .getByProjectAndHost({
        projectId: state.projectId,
        hostNameNormalized: state.hostNameNormalized,
      })
      .pipe(
        Effect.mapError((cause) =>
          toHostDriftError("Failed to load host drift state before launch.", cause),
        ),
      );
    if (Option.isNone(current)) {
      return yield* toHostDriftError("Host drift state is missing before launch.");
    }

    yield* hostDriftRepository
      .upsert({
        ...current.value,
        status: "starting",
        finishedAt: null,
        updatedAt: new Date().toISOString(),
        lastError: null,
        awaitingAuthPhase: null,
        exitCode: null,
        exitSignal: null,
      })
      .pipe(
        Effect.mapError((cause) =>
          toHostDriftError("Failed to persist host drift launch state.", cause),
        ),
      );

    yield* terminalManager
      .openCommand({
        threadId: state.terminalOwnerId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: state.cwd,
        cols: 120,
        rows: 30,
        command: buildDriftCommand(state.sshTarget, nextPhase),
        ...(sshAgentSocket ? { env: { SSH_AUTH_SOCK: sshAgentSocket } } : {}),
      })
      .pipe(
        Effect.mapError((cause) =>
          toHostDriftError("Failed to start the host drift terminal.", cause),
        ),
      );
  });

  const repairActiveDrifts = hostDriftRepository.listActive().pipe(
    Effect.mapError((cause) => toHostDriftError("Failed to repair active host drift runs.", cause)),
    Effect.flatMap((rows) =>
      Effect.forEach(rows, (row) =>
        hostDriftRepository
          .upsert({
            ...row,
            status: "error",
            finishedAt: row.finishedAt ?? new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            lastError:
              row.lastError ?? "The host drift run stopped unexpectedly during server restart.",
          })
          .pipe(
            Effect.mapError((cause) =>
              toHostDriftError("Failed to persist repaired host drift state.", cause),
            ),
          ),
      ),
    ),
  );
  yield* repairActiveDrifts;

  const transitionToAwaitingAuth = Effect.fn("hostDrift.transitionToAwaitingAuth")(function* (
    state: HostDriftRunState,
    phase: "ssh-login" | "remote-sudo",
    createdAt: string,
    lastError: string | null,
  ) {
    state.outputTail = "";
    if (phase === "ssh-login") {
      state.phase = "ssh-password";
      state.activeSshPassword = null;
    } else {
      state.phase = "sudo-password";
      state.activeSudoPassword = null;
    }
    const updated = yield* updateSummary({
      projectId: state.projectId,
      hostNameNormalized: state.hostNameNormalized,
      mutate: (current) => ({
        ...current,
        status: "idle",
        finishedAt: null,
        updatedAt: createdAt,
        lastError,
        awaitingAuthPhase: phase,
        exitCode: null,
        exitSignal: null,
      }),
    }).pipe(
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(
              toHostDriftError("Host drift state disappeared while awaiting authentication."),
            )
          : Effect.succeed(row),
      ),
    );
    yield* rememberRunState(state);
    return updated;
  });

  const failRun = Effect.fn("hostDrift.failRun")(function* (
    state: HostDriftRunState,
    createdAt: string,
    exitCode: number | null,
    exitSignal: number | null,
    message: string,
  ) {
    const sanitizedMessage = redactText(message, state.redactedSecrets).trim();
    yield* updateSummary({
      projectId: state.projectId,
      hostNameNormalized: state.hostNameNormalized,
      mutate: (current) => ({
        ...current,
        status: "failed",
        finishedAt: createdAt,
        updatedAt: createdAt,
        lastError:
          sanitizedMessage.length > 0
            ? sanitizedMessage
            : (current.lastError ?? "Host drift scan failed."),
        awaitingAuthPhase: null,
        exitCode,
        exitSignal,
      }),
    });
    yield* clearRunState(state);
  });

  const completeRun = Effect.fn("hostDrift.completeRun")(function* (
    state: HostDriftRunState,
    createdAt: string,
    exitCode: number | null,
    exitSignal: number | null,
    history: string,
  ) {
    const observedSnapshot = parseObservedDriftSnapshot(history);
    const categoryResults = buildCategoryResults(
      state.desiredSnapshot,
      observedSnapshot,
      createdAt,
    );
    yield* persistCategoryResults(state, categoryResults);
    yield* updateSummary({
      projectId: state.projectId,
      hostNameNormalized: state.hostNameNormalized,
      mutate: (current) => ({
        ...current,
        status: "completed",
        finishedAt: createdAt,
        updatedAt: createdAt,
        lastError: null,
        awaitingAuthPhase: null,
        exitCode,
        exitSignal,
        categoryResults: [...categoryResults],
      }),
    });
    yield* clearRunState(state);
  });

  const maybeAnswerPrompt = Effect.fn("hostDrift.maybeAnswerPrompt")(function* (
    state: HostDriftRunState,
    chunk: string,
  ) {
    const plainChunk = sanitizePlainOutput(chunk);
    state.outputTail = capTail(`${state.outputTail}${plainChunk}`);

    if (
      state.activeSudoPassword !== null &&
      state.outputTail.includes(HOST_DRIFT_SUDO_PROMPT) &&
      state.sudoPromptResponses < MAX_PROMPT_RESPONSES
    ) {
      state.outputTail = "";
      state.sudoPromptResponses += 1;
      yield* terminalManager
        .write({
          threadId: state.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
          data: `${state.activeSudoPassword}\n`,
        })
        .pipe(Effect.ignoreCause({ log: true }));
      return;
    }

    if (
      state.activeSshPassword !== null &&
      SSH_PASSWORD_PROMPT.test(state.outputTail) &&
      state.sshPromptResponses < MAX_PROMPT_RESPONSES
    ) {
      state.outputTail = "";
      state.sshPromptResponses += 1;
      yield* terminalManager
        .write({
          threadId: state.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
          data: `${state.activeSshPassword}\n`,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
  });

  const classifyExit = Effect.fn("hostDrift.classifyExit")(function* (
    state: HostDriftRunState,
    createdAt: string,
    exitCode: number | null,
    exitSignal: number | null,
  ) {
    const history = yield* terminalManager.readHistory({
      threadId: state.terminalOwnerId,
      terminalId: DEFAULT_TERMINAL_ID,
    });
    const plainHistory = sanitizePlainOutput(history);

    if (exitCode === 0) {
      return yield* completeRun(state, createdAt, exitCode, exitSignal, history);
    }

    if (plainHistory.includes(HOST_DRIFT_NEEDS_SUDO_MARKER) || exitCode === 42) {
      return yield* transitionToAwaitingAuth(
        state,
        "remote-sudo",
        createdAt,
        "Remote sudo access is required to continue the drift scan.",
      );
    }

    if (SSH_HOST_KEY_FAILURE.test(plainHistory)) {
      return yield* failRun(
        state,
        createdAt,
        exitCode,
        exitSignal,
        "SSH host key verification failed. Fix the known_hosts entry before retrying the drift scan.",
      );
    }

    if (SSH_AUTH_FAILURE.test(plainHistory)) {
      return yield* transitionToAwaitingAuth(
        state,
        "ssh-login",
        createdAt,
        "Authentication failed.",
      );
    }

    if (state.phase === "sudo-password" && SUDO_AUTH_FAILURE.test(plainHistory)) {
      return yield* transitionToAwaitingAuth(
        state,
        "remote-sudo",
        createdAt,
        "Remote sudo authentication failed.",
      );
    }

    return yield* failRun(
      state,
      createdAt,
      exitCode,
      exitSignal,
      plainHistory.trim().slice(-2_000) || "Host drift scan failed.",
    );
  });

  const unsubscribe = yield* terminalManager.subscribe((event) => {
    if (!event.threadId.startsWith(HOST_DRIFT_OWNER_PREFIX)) {
      return Effect.void;
    }
    return Effect.gen(function* () {
      const state = yield* getRunState(event.threadId);
      if (!state) {
        return;
      }

      switch (event.type) {
        case "started":
        case "restarted":
          yield* updateSummary({
            projectId: state.projectId,
            hostNameNormalized: state.hostNameNormalized,
            mutate: (current) => ({
              ...current,
              status: "running",
              finishedAt: null,
              updatedAt: event.snapshot.updatedAt,
              lastError: null,
              awaitingAuthPhase: null,
              exitCode: null,
              exitSignal: null,
            }),
          });
          return;
        case "output":
          yield* maybeAnswerPrompt(state, event.data);
          return;
        case "activity":
          if (!event.hasRunningSubprocess) {
            return;
          }
          yield* updateSummary({
            projectId: state.projectId,
            hostNameNormalized: state.hostNameNormalized,
            mutate: (current) => ({
              ...current,
              status: "running",
              updatedAt: event.createdAt,
            }),
          });
          return;
        case "error":
          yield* failRun(
            state,
            event.createdAt,
            null,
            null,
            event.message || "Host drift scan failed to start.",
          );
          return;
        case "exited":
          yield* classifyExit(
            state,
            event.createdAt,
            event.exitCode ?? null,
            event.exitSignal ?? null,
          );
          return;
        case "cleared":
          return;
      }
    }).pipe(Effect.ignoreCause({ log: true }));
  });
  yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

  const get: HostDriftServiceShape["get"] = (input) =>
    getPersisted(input).pipe(Effect.map(Option.match({ onNone: () => null, onSome: toSummary })));

  const listByProjectId: HostDriftServiceShape["listByProjectId"] = (projectId) =>
    hostDriftRepository.listByProjectId({ projectId }).pipe(
      Effect.mapError((cause) => toHostDriftError("Failed to load host drift state.", cause)),
      Effect.map(
        (rows) =>
          new Map(
            rows.map((row) => [row.hostNameNormalized, toSummary(row)] as const),
          ) as ReadonlyMap<string, HostDriftSummary>,
      ),
    );

  const refresh: HostDriftServiceShape["refresh"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      return yield* withOwnerLock(
        context.terminalOwnerId,
        Effect.gen(function* () {
          const existing = yield* getPersisted(input);
          if (Option.isSome(existing) && isActiveHostDriftStatus(existing.value.status)) {
            const liveSnapshot = yield* terminalManager
              .getSnapshot({
                threadId: context.terminalOwnerId,
                terminalId: DEFAULT_TERMINAL_ID,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toHostDriftError("Failed to inspect the active drift terminal.", cause),
                ),
              );
            if (liveSnapshot !== null && liveSnapshot.status === "running") {
              return {
                disposition: "already-running",
                summary: toSummary(existing.value),
              } as const;
            }
          }

          const desiredSnapshot = yield* resolveDesiredSnapshot(
            context.project.workspaceRoot,
            context.selectedHost,
          );
          const startedAt = new Date().toISOString();
          const summary: HostDriftSummary = {
            projectId: input.projectId,
            hostName: context.selectedHost.name,
            terminalOwnerId: context.terminalOwnerId,
            cwd: context.project.workspaceRoot,
            status: "starting",
            startedAt,
            finishedAt: null,
            updatedAt: startedAt,
            lastError: null,
            awaitingAuthPhase: null,
            exitCode: null,
            exitSignal: null,
            categoryResults: Option.match(existing, {
              onNone: () => [],
              onSome: (value) => value.categoryResults,
            }),
          };

          const existingRunState = yield* getRunState(context.terminalOwnerId);
          if (existingRunState) {
            yield* clearRunState(existingRunState);
          }

          const runState: HostDriftRunState = {
            projectId: input.projectId,
            hostName: context.selectedHost.name,
            hostNameNormalized: context.hostNameNormalized,
            sshTarget: context.sshTarget,
            terminalOwnerId: context.terminalOwnerId,
            cwd: context.project.workspaceRoot,
            desiredSnapshot,
            phase: "key",
            outputTail: "",
            activeSshPassword: null,
            activeSudoPassword: null,
            redactedSecrets: new Set(),
            sshPromptResponses: 0,
            sudoPromptResponses: 0,
          };
          yield* rememberRunState(runState);
          yield* hostDriftRepository
            .upsert(toPersisted(summary, context.hostNameNormalized))
            .pipe(
              Effect.mapError((cause) =>
                toHostDriftError("Failed to persist host drift state.", cause),
              ),
            );
          yield* launchPhase(runState, "key");

          return {
            disposition: "started",
            summary,
          } as const;
        }),
      );
    });

  const cancel: HostDriftServiceShape["cancel"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      return yield* withOwnerLock(
        context.terminalOwnerId,
        Effect.gen(function* () {
          const existing = yield* getPersisted(input);
          if (Option.isNone(existing)) {
            return null;
          }
          const canceledAt = new Date().toISOString();
          const next: PersistedHostDrift = {
            ...existing.value,
            status: "canceled",
            finishedAt: canceledAt,
            updatedAt: canceledAt,
            awaitingAuthPhase: null,
          };
          yield* hostDriftRepository
            .upsert(next)
            .pipe(
              Effect.mapError((cause) =>
                toHostDriftError("Failed to persist host drift state.", cause),
              ),
            );
          yield* terminalManager
            .close({
              threadId: context.terminalOwnerId,
              terminalId: DEFAULT_TERMINAL_ID,
            })
            .pipe(Effect.ignore);
          const runState = yield* getRunState(context.terminalOwnerId);
          if (runState) {
            yield* clearRunState(runState);
          } else {
            yield* secretVault.clearThread(context.terminalOwnerId);
            yield* terminalManager.unregisterOutputSanitizer(context.terminalOwnerId);
          }
          return toSummary(next);
        }),
      );
    });

  const submitSecret: HostDriftServiceShape["submitSecret"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      return yield* withOwnerLock(
        context.terminalOwnerId,
        Effect.gen(function* () {
          const current = yield* getPersisted({
            projectId: input.projectId,
            hostName: input.hostName,
          });
          if (Option.isNone(current)) {
            return yield* toHostDriftError("Host drift has not been started yet.");
          }
          const currentSummary = current.value;
          if (currentSummary.awaitingAuthPhase !== input.phase) {
            return {
              accepted: false,
              status: currentSummary.status,
            };
          }

          let runState = yield* getRunState(context.terminalOwnerId);
          if (!runState) {
            const desiredSnapshot = yield* resolveDesiredSnapshot(
              context.project.workspaceRoot,
              context.selectedHost,
            );
            runState = {
              projectId: input.projectId,
              hostName: context.selectedHost.name,
              hostNameNormalized: context.hostNameNormalized,
              sshTarget: context.sshTarget,
              terminalOwnerId: context.terminalOwnerId,
              cwd: context.project.workspaceRoot,
              desiredSnapshot,
              phase: input.phase === "remote-sudo" ? "sudo-password" : "ssh-password",
              outputTail: "",
              activeSshPassword: null,
              activeSudoPassword: null,
              redactedSecrets: new Set(),
              sshPromptResponses: 0,
              sudoPromptResponses: 0,
            };
            yield* rememberRunState(runState);
          }
          if (!runState) {
            return yield* toHostDriftError(
              "Host drift run state could not be prepared for authentication retry.",
            );
          }

          yield* secretVault.set({
            threadId: context.terminalOwnerId,
            phase: input.phase,
            secret: input.secret,
          });
          const consumed = yield* secretVault.take({
            threadId: context.terminalOwnerId,
            phase: input.phase,
          });
          if (!consumed) {
            return {
              accepted: false,
              status: currentSummary.status,
            };
          }

          runState.redactedSecrets.add(consumed);
          if (input.phase === "ssh-login") {
            runState.activeSshPassword = consumed;
          } else {
            runState.activeSudoPassword = consumed;
          }

          yield* launchPhase(
            runState,
            input.phase === "remote-sudo" ? "sudo-password" : "ssh-password",
          );
          return {
            accepted: true,
            status: "starting" as HostDriftStatus,
          };
        }),
      );
    });

  const reconcile: HostDriftServiceShape["reconcile"] = (input) =>
    Effect.gen(function* () {
      const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
        Effect.mapError((cause) => toHostDriftError("Failed to load the selected flake.", cause)),
        Effect.flatMap((result) =>
          Option.match(result, {
            onNone: () => Effect.fail(toHostDriftError(`Flake ${input.projectId} was not found.`)),
            onSome: Effect.succeed,
          }),
        ),
      );
      const summary = yield* get({
        projectId: input.projectId,
        hostName: input.hostName,
      }).pipe(
        Effect.flatMap((value) =>
          value === null
            ? Effect.fail(toHostDriftError("No drift scan is available for this host yet."))
            : Effect.succeed(value),
        ),
      );
      if (summary.status !== "completed" || summary.categoryResults.length === 0) {
        return yield* toHostDriftError(
          "Complete a drift scan before opening a reconciliation planning thread.",
        );
      }

      const fallbackModelSelection = chooseFallbackModelSelection(
        yield* providerRegistry.getProviders,
      );
      const modelSelection = project.defaultModelSelection ?? fallbackModelSelection;
      if (modelSelection === null) {
        return yield* toHostDriftError(
          "The project does not have a default model selection and no provider fallback was available.",
        );
      }

      const createdAt = new Date().toISOString();
      const threadId = ThreadId.make(crypto.randomUUID());
      const title = buildReconcileThreadTitle(input.hostName, input.intent);
      const message = buildReconcilePrompt({
        hostName: input.hostName,
        intent: input.intent,
        summary,
      });

      yield* orchestrationEngine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          projectId: input.projectId,
          title,
          modelSelection,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: "plan",
          branch: null,
          worktreePath: null,
          scopedHostName: input.hostName,
          workflow: null,
          createdAt,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostDriftError("Failed to create the reconciliation planning thread.", cause),
          ),
        );

      yield* orchestrationEngine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(crypto.randomUUID()),
          threadId,
          message: {
            messageId: MessageId.make(crypto.randomUUID()),
            role: "user",
            text: message,
            attachments: [],
          },
          modelSelection,
          titleSeed: title,
          runtimeMode: DEFAULT_RUNTIME_MODE,
          interactionMode: "plan",
          createdAt,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostDriftError("Failed to start the reconciliation planning turn.", cause),
          ),
        );

      return {
        threadId,
      };
    });

  const openTerminal: HostDriftServiceShape["openTerminal"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      const persisted = yield* getPersisted({
        projectId: input.projectId,
        hostName: input.hostName,
      });
      if (Option.isNone(persisted)) {
        return yield* toHostDriftError("No host drift run exists yet.");
      }

      const liveSnapshot = yield* terminalManager
        .getSnapshot({
          threadId: context.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostDriftError("Failed to open the host drift terminal.", cause),
          ),
        );
      if (liveSnapshot !== null) {
        if (input.cols !== undefined && input.rows !== undefined) {
          yield* terminalManager
            .resize({
              threadId: context.terminalOwnerId,
              terminalId: DEFAULT_TERMINAL_ID,
              cols: input.cols,
              rows: input.rows,
            })
            .pipe(
              Effect.mapError((cause) =>
                toHostDriftError("Failed to resize the live host drift terminal.", cause),
              ),
            );
        }
        return mapTerminalSnapshot(liveSnapshot);
      }

      const history = yield* terminalManager
        .readHistory({
          threadId: context.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostDriftError("Failed to load host drift terminal history.", cause),
          ),
        );
      return {
        terminalOwnerId: context.terminalOwnerId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: context.cwd,
        worktreePath: null,
        status:
          persisted.value.status === "failed" || persisted.value.status === "error"
            ? "error"
            : "exited",
        pid: null,
        history,
        exitCode: persisted.value.exitCode,
        exitSignal: persisted.value.exitSignal,
        updatedAt: persisted.value.updatedAt,
      };
    });

  const resizeTerminal: HostDriftServiceShape["resizeTerminal"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      const persisted = yield* getPersisted({
        projectId: input.projectId,
        hostName: input.hostName,
      });
      if (Option.isNone(persisted) || !isActiveHostDriftStatus(persisted.value.status)) {
        return;
      }
      yield* terminalManager
        .resize({
          threadId: context.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
          cols: input.cols,
          rows: input.rows,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostDriftError("Failed to resize the host drift terminal.", cause),
          ),
        );
    });

  const subscribeTerminalEvents: HostDriftServiceShape["subscribeTerminalEvents"] = (input) =>
    Stream.callback<HostDriftTerminalEvent, HostDriftError>((queue) =>
      Effect.gen(function* () {
        const context = yield* resolveStartContext(input);
        const persisted = yield* getPersisted(input);
        if (Option.isNone(persisted)) {
          return yield* toHostDriftError("No host drift run exists yet.");
        }

        const unsubscribeTerminal = yield* terminalManager.subscribe((event) => {
          if (event.threadId !== context.terminalOwnerId) {
            return Effect.void;
          }
          return Queue.offer(queue, mapTerminalEvent(event)).pipe(Effect.asVoid);
        });

        return () => {
          unsubscribeTerminal();
        };
      }).pipe(
        Effect.mapError((cause) =>
          toHostDriftError("Failed to subscribe to host drift terminal events.", cause),
        ),
      ),
    );

  return {
    refresh,
    get,
    listByProjectId,
    cancel,
    submitSecret,
    reconcile,
    openTerminal,
    resizeTerminal,
    subscribeTerminalEvents,
  } satisfies HostDriftServiceShape;
});

export const HostDriftServiceLive = Layer.effect(HostDriftService, makeHostDriftService);
