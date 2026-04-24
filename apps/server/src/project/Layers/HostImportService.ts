import crypto from "node:crypto";

import {
  CommandId,
  DEFAULT_TERMINAL_ID,
  EventId,
  HostImportError,
  type ProjectId,
  type ThreadId,
  type HostImportGetInput,
  type HostImportStartInput,
  type HostImportStartResult,
  type HostImportStatus,
  type HostImportSubmitSecretResult,
  type HostImportSummary,
  type HostImportTerminalEvent,
  type HostImportTerminalSnapshot,
} from "@t3tools/contracts";
import {
  HOST_CREATION_WORKFLOW_KIND,
  resolveHostCreationBootstrapMode,
} from "@t3tools/shared/hostWorkflow";
import {
  HOST_IMPORT_FINDINGS_END_MARKER,
  HOST_IMPORT_FINDINGS_START_MARKER,
  HOST_IMPORT_NEEDS_SUDO_MARKER,
  HOST_IMPORT_REMOTE_SCRIPT,
  HOST_IMPORT_REMOTE_SCRIPT_NAME,
  HOST_IMPORT_RUNNER_SCRIPT,
  HOST_IMPORT_RUNNER_SCRIPT_NAME,
  HOST_IMPORT_SUDO_PROMPT,
} from "../hostImportScripts.ts";
import { listLoginShellCandidates, readEnvironmentFromLoginShell } from "@t3tools/shared/shell";
import {
  Cache,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Semaphore,
  Stream,
  SynchronizedRef,
} from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { HostImportRepository } from "../../persistence/Services/HostImports.ts";
import {
  isActiveHostImportStatus,
  type PersistedHostImport,
} from "../../persistence/Services/HostImports.ts";
import { TerminalManager } from "../../terminal/Services/Manager.ts";
import { EphemeralWorkflowSecretVault } from "../Services/EphemeralWorkflowSecretVault.ts";
import { HostImportService, type HostImportServiceShape } from "../Services/HostImportService.ts";

const HOST_IMPORT_OWNER_PREFIX = "host-import:";
const MAX_PROMPT_RESPONSES = 6;
const SSH_PASSWORD_PROMPT = /password:\s*$/i;
const SSH_AUTH_FAILURE =
  /permission denied|authentication failed|no supported authentication methods/i;
const SSH_HOST_KEY_FAILURE =
  /host key verification failed|remote host identification has changed|offending .* key/i;
const SUDO_AUTH_FAILURE = /sorry, try again|incorrect password attempt|a password is required/i;

type RunnerPhase = "key" | "ssh-password" | "sudo-password";

interface HostImportRunState {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly hostName: string;
  readonly sshTarget: string;
  readonly terminalOwnerId: string;
  readonly cwd: string;
  phase: RunnerPhase;
  outputTail: string;
  activeSshPassword: string | null;
  activeSudoPassword: string | null;
  readonly redactedSecrets: Set<string>;
  sshPromptResponses: number;
  sudoPromptResponses: number;
}

interface HelperScriptPaths {
  readonly directory: string;
  readonly runnerPath: string;
  readonly remotePath: string;
}

function ownerIdFor(projectId: string, threadId: string): string {
  return `${HOST_IMPORT_OWNER_PREFIX}${projectId}:${threadId}`;
}

function toHostImportError(message: string, cause?: unknown): HostImportError {
  return new HostImportError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function toSummary(row: PersistedHostImport): HostImportSummary {
  const { terminalOwnerId: _ignoredTerminalOwnerId, cwd: _ignoredCwd, ...summary } = row;
  return summary;
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
}): HostImportTerminalSnapshot {
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
  type: HostImportTerminalEvent["type"];
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
}): HostImportTerminalEvent {
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

function extractFindingsSummary(history: string): string | null {
  const startIndex = history.lastIndexOf(HOST_IMPORT_FINDINGS_START_MARKER);
  if (startIndex === -1) {
    return null;
  }
  const afterStart = startIndex + HOST_IMPORT_FINDINGS_START_MARKER.length;
  const endIndex = history.indexOf(HOST_IMPORT_FINDINGS_END_MARKER, afterStart);
  if (endIndex === -1) {
    return null;
  }
  const extracted = history.slice(afterStart, endIndex).trim();
  return extracted.length > 0 ? extracted : null;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

const makeHostImportService = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const hostImportRepository = yield* HostImportRepository;
  const terminalManager = yield* TerminalManager;
  const secretVault = yield* EphemeralWorkflowSecretVault;
  const serverConfig = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const helperScriptPaths: HelperScriptPaths = {
    directory: path.join(serverConfig.stateDir, "host-import"),
    runnerPath: path.join(serverConfig.stateDir, "host-import", HOST_IMPORT_RUNNER_SCRIPT_NAME),
    remotePath: path.join(serverConfig.stateDir, "host-import", HOST_IMPORT_REMOTE_SCRIPT_NAME),
  };

  const ensureHelperScripts = () =>
    Effect.gen(function* () {
      yield* fileSystem.makeDirectory(helperScriptPaths.directory, { recursive: true });
      yield* fileSystem.writeFileString(helperScriptPaths.runnerPath, HOST_IMPORT_RUNNER_SCRIPT);
      yield* fileSystem.writeFileString(helperScriptPaths.remotePath, HOST_IMPORT_REMOTE_SCRIPT);
      yield* fileSystem.chmod(helperScriptPaths.runnerPath, 0o700);
      yield* fileSystem.chmod(helperScriptPaths.remotePath, 0o700);
    }).pipe(
      Effect.mapError((cause) =>
        toHostImportError("Failed to prepare the secure host import helper scripts.", cause),
      ),
    );
  yield* ensureHelperScripts();

  const ownerLockCache = yield* Cache.make({
    capacity: 256,
    timeToLive: Duration.minutes(10),
    lookup: () => Semaphore.make(1),
  });

  const runStatesRef = yield* SynchronizedRef.make(new Map<string, HostImportRunState>());

  const withOwnerLock = <A, E, R>(
    terminalOwnerId: string,
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E, R> =>
    Effect.flatMap(Cache.get(ownerLockCache, terminalOwnerId), (semaphore) =>
      semaphore.withPermit(effect),
    );

  const readRunStates = SynchronizedRef.get(runStatesRef);

  const getRunState = (terminalOwnerId: string) =>
    readRunStates.pipe(Effect.map((states) => states.get(terminalOwnerId) ?? null));

  const rememberRunState = (state: HostImportRunState) =>
    SynchronizedRef.update(runStatesRef, (current) => {
      const next = new Map(current);
      next.set(state.terminalOwnerId, state);
      return next;
    });

  const deleteRunState = (terminalOwnerId: string) =>
    SynchronizedRef.update(runStatesRef, (current) => {
      if (!current.has(terminalOwnerId)) {
        return current;
      }
      const next = new Map(current);
      next.delete(terminalOwnerId);
      return next;
    });

  const registerOutputSanitizer = (state: HostImportRunState) =>
    terminalManager.registerOutputSanitizer(state.terminalOwnerId, (chunk) =>
      redactText(chunk, state.redactedSecrets),
    );

  const clearRunSecrets = (state: HostImportRunState) => {
    state.activeSshPassword = null;
    state.activeSudoPassword = null;
    state.outputTail = "";
    state.redactedSecrets.clear();
    state.sshPromptResponses = 0;
    state.sudoPromptResponses = 0;
  };

  const clearRunState = (state: HostImportRunState) =>
    Effect.all(
      [
        secretVault.clearThread(state.threadId),
        terminalManager.unregisterOutputSanitizer(state.terminalOwnerId),
        deleteRunState(state.terminalOwnerId),
      ],
      { discard: true },
    ).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          clearRunSecrets(state);
        }),
      ),
    );

  const appendActivity = (input: {
    readonly threadId: ThreadId;
    readonly tone: "info" | "error";
    readonly kind: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly createdAt: string;
  }) =>
    orchestrationEngine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:host-import:${crypto.randomUUID()}`),
        threadId: input.threadId,
        activity: {
          id: EventId.make(crypto.randomUUID()),
          tone: input.tone,
          kind: input.kind,
          summary: input.summary,
          payload: input.payload,
          turnId: null,
          createdAt: input.createdAt,
        },
        createdAt: input.createdAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));

  const resolveSshAgentSocket = Effect.fn("hostImport.resolveSshAgentSocket")(() =>
    Effect.sync(findSshAgentSocket),
  );

  const persistSummary = (row: PersistedHostImport) =>
    hostImportRepository
      .upsert(row)
      .pipe(
        Effect.mapError((cause) =>
          toHostImportError("Failed to persist host import state.", cause),
        ),
      );

  const updateSummary = (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly mutate: (current: PersistedHostImport) => PersistedHostImport;
  }) =>
    hostImportRepository
      .getByProjectAndThread({
        projectId: input.projectId,
        threadId: input.threadId,
      })
      .pipe(
        Effect.mapError((cause) => toHostImportError("Failed to load host import state.", cause)),
        Effect.flatMap((current) =>
          Option.match(current, {
            onNone: () => Effect.succeed(null),
            onSome: (row) => {
              const nextRow = input.mutate(row);
              return persistSummary(nextRow).pipe(Effect.as(nextRow));
            },
          }),
        ),
      );

  const resolveStartContext = Effect.fn("hostImport.resolveStartContext")(function* (
    input: HostImportStartInput | HostImportGetInput,
  ) {
    const [projectOption, threadOption] = yield* Effect.all([
      projectionSnapshotQuery.getProjectShellById(input.projectId),
      projectionSnapshotQuery.getThreadShellById(input.threadId),
    ]).pipe(
      Effect.mapError((cause) =>
        toHostImportError("Failed to load the host import thread context.", cause),
      ),
    );

    if (Option.isNone(projectOption)) {
      return yield* toHostImportError(`Flake ${input.projectId} was not found for host import.`);
    }
    if (Option.isNone(threadOption)) {
      return yield* toHostImportError(`Thread ${input.threadId} was not found for host import.`);
    }

    const project = projectOption.value;
    const thread = threadOption.value;
    if (thread.projectId !== input.projectId) {
      return yield* toHostImportError("The selected thread does not belong to the selected flake.");
    }

    const workflow = thread.workflow;
    if (
      !workflow ||
      workflow.kind !== HOST_CREATION_WORKFLOW_KIND ||
      resolveHostCreationBootstrapMode(workflow.bootstrapMode) !== "existing-via-ssh"
    ) {
      return yield* toHostImportError("This thread is not configured for SSH-based host import.");
    }
    const sshTarget = workflow.sourceSshTarget?.trim() ?? "";
    if (sshTarget.length === 0) {
      return yield* toHostImportError(
        "The SSH discovery target is missing for this host import thread.",
      );
    }

    return {
      project,
      thread,
      hostName: workflow.hostName,
      sshTarget,
      terminalOwnerId: ownerIdFor(input.projectId, input.threadId),
      cwd: project.workspaceRoot,
    } as const;
  });

  const launchPhase = Effect.fn("hostImport.launchPhase")(function* (
    state: HostImportRunState,
    phase: RunnerPhase,
  ) {
    const sshAuthSock = yield* resolveSshAgentSocket();
    state.phase = phase;
    state.outputTail = "";
    state.sshPromptResponses = 0;
    state.sudoPromptResponses = 0;

    const current = yield* hostImportRepository
      .getByProjectAndThread({
        projectId: state.projectId,
        threadId: state.threadId,
      })
      .pipe(
        Effect.mapError((cause) =>
          toHostImportError("Failed to load host import state before launch.", cause),
        ),
        Effect.flatMap((row) =>
          Option.match(row, {
            onNone: () =>
              Effect.fail(toHostImportError("Host import state is missing before launch.")),
            onSome: Effect.succeed,
          }),
        ),
      );

    const startingAt = new Date().toISOString();
    yield* persistSummary({
      ...current,
      status: "starting",
      finishedAt: null,
      updatedAt: startingAt,
      lastError: null,
      exitCode: null,
      exitSignal: null,
    });

    const env: Record<string, string> = {
      T3CODE_HOST_IMPORT_PHASE: phase,
      T3CODE_HOST_IMPORT_TARGET: state.sshTarget,
      T3CODE_HOST_IMPORT_REMOTE_SCRIPT: helperScriptPaths.remotePath,
    };
    if (sshAuthSock) {
      env.SSH_AUTH_SOCK = sshAuthSock;
    }

    yield* registerOutputSanitizer(state);
    yield* terminalManager
      .openCommand({
        threadId: state.terminalOwnerId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: state.cwd,
        worktreePath: null,
        command: `exec ${shellQuote(helperScriptPaths.runnerPath)}`,
        env,
      })
      .pipe(
        Effect.mapError((cause) =>
          toHostImportError("Failed to start the secure host import terminal.", cause),
        ),
      );
  });

  const repairActiveImports = hostImportRepository.listActive().pipe(
    Effect.mapError((cause) => toHostImportError("Failed to repair active host imports.", cause)),
    Effect.flatMap((rows) =>
      Effect.forEach(
        rows,
        (row) => {
          const now = new Date().toISOString();
          return persistSummary({
            ...row,
            status: "failed",
            finishedAt: row.finishedAt ?? now,
            updatedAt: now,
            lastError: "The server restarted before secure host import completed.",
          });
        },
        { discard: true },
      ),
    ),
  );
  yield* repairActiveImports;

  const finalizeSuccessfulImport = Effect.fn("hostImport.finalizeSuccessfulImport")(function* (
    state: HostImportRunState,
    createdAt: string,
    exitCode: number | null,
    exitSignal: number | null,
    history: string,
  ) {
    const findingsSummary = extractFindingsSummary(history);
    const updated = yield* updateSummary({
      projectId: state.projectId,
      threadId: state.threadId,
      mutate: (current) => ({
        ...current,
        status: "completed",
        finishedAt: createdAt,
        updatedAt: createdAt,
        lastError: null,
        findingsSummary,
        exitCode,
        exitSignal,
      }),
    }).pipe(
      Effect.flatMap((row) =>
        row === null
          ? Effect.fail(toHostImportError("Host import state disappeared before completion."))
          : Effect.succeed(row),
      ),
    );

    yield* appendActivity({
      threadId: state.threadId,
      tone: "info",
      kind: "host-import.findings-ready",
      summary: `Secure host analysis for ${state.hostName} is ready for review.`,
      payload: {
        hostName: state.hostName,
        sshTarget: state.sshTarget,
        status: updated.status,
      },
      createdAt,
    });

    yield* clearRunState(state);
  });

  const transitionToAwaitingPassword = Effect.fn("hostImport.transitionToAwaitingPassword")(
    function* (
      state: HostImportRunState,
      nextStatus: Extract<HostImportStatus, "awaiting-ssh-password" | "awaiting-sudo-password">,
      createdAt: string,
      lastError: string | null,
    ) {
      state.outputTail = "";
      if (nextStatus === "awaiting-ssh-password") {
        state.phase = state.activeSudoPassword ? "sudo-password" : "ssh-password";
        state.activeSshPassword = null;
      } else {
        state.phase = "sudo-password";
        state.activeSudoPassword = null;
      }
      const updated = yield* updateSummary({
        projectId: state.projectId,
        threadId: state.threadId,
        mutate: (current) => ({
          ...current,
          status: nextStatus,
          finishedAt: null,
          updatedAt: createdAt,
          lastError,
        }),
      }).pipe(
        Effect.flatMap((row) =>
          row === null
            ? Effect.fail(
                toHostImportError("Host import state disappeared while awaiting a password."),
              )
            : Effect.succeed(row),
        ),
      );

      yield* rememberRunState(state);
      yield* appendActivity({
        threadId: state.threadId,
        tone: "info",
        kind: "host-import.auth-required",
        summary:
          nextStatus === "awaiting-ssh-password"
            ? `Secure host analysis for ${state.hostName} needs an SSH password.`
            : `Secure host analysis for ${state.hostName} needs a remote sudo password.`,
        payload: {
          hostName: state.hostName,
          sshTarget: state.sshTarget,
          status: updated.status,
        },
        createdAt,
      });
    },
  );

  const failImport = Effect.fn("hostImport.failImport")(function* (
    state: HostImportRunState,
    createdAt: string,
    exitCode: number | null,
    exitSignal: number | null,
    message: string,
  ) {
    const sanitizedMessage = redactText(message, state.redactedSecrets).trim();
    yield* updateSummary({
      projectId: state.projectId,
      threadId: state.threadId,
      mutate: (current) => ({
        ...current,
        status: "failed",
        finishedAt: createdAt,
        updatedAt: createdAt,
        lastError:
          sanitizedMessage.length > 0
            ? sanitizedMessage
            : (current.lastError ?? "Secure host analysis failed."),
        exitCode,
        exitSignal,
      }),
    });
    yield* appendActivity({
      threadId: state.threadId,
      tone: "error",
      kind: "host-import.failed",
      summary: `Secure host analysis for ${state.hostName} failed.`,
      payload: {
        hostName: state.hostName,
        sshTarget: state.sshTarget,
      },
      createdAt,
    });
    yield* clearRunState(state);
  });

  const maybeAnswerPrompt = Effect.fn("hostImport.maybeAnswerPrompt")(function* (
    state: HostImportRunState,
    chunk: string,
  ) {
    const plainChunk = sanitizePlainOutput(chunk);
    state.outputTail = capTail(`${state.outputTail}${plainChunk}`);

    if (
      state.activeSudoPassword !== null &&
      state.outputTail.includes(HOST_IMPORT_SUDO_PROMPT) &&
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

  const classifyExit = Effect.fn("hostImport.classifyExit")(function* (
    state: HostImportRunState,
    createdAt: string,
    exitCode: number | null,
    exitSignal: number | null,
  ) {
    const history = yield* terminalManager.readHistory({
      threadId: state.terminalOwnerId,
      terminalId: DEFAULT_TERMINAL_ID,
    });
    const plainHistory = sanitizePlainOutput(history);

    if (exitCode === 0 && extractFindingsSummary(history) !== null) {
      return yield* finalizeSuccessfulImport(state, createdAt, exitCode, exitSignal, history);
    }

    if (plainHistory.includes(HOST_IMPORT_NEEDS_SUDO_MARKER) || exitCode === 42) {
      return yield* transitionToAwaitingPassword(
        state,
        "awaiting-sudo-password",
        createdAt,
        "Remote sudo access is required to continue secure host analysis.",
      );
    }

    if (SSH_HOST_KEY_FAILURE.test(plainHistory)) {
      return yield* failImport(
        state,
        createdAt,
        exitCode,
        exitSignal,
        "SSH host key verification failed. Fix the known_hosts entry before retrying secure host import.",
      );
    }

    if (SSH_AUTH_FAILURE.test(plainHistory)) {
      return yield* transitionToAwaitingPassword(
        state,
        "awaiting-ssh-password",
        createdAt,
        "Authentication failed.",
      );
    }

    if (state.phase === "sudo-password" && SUDO_AUTH_FAILURE.test(plainHistory)) {
      return yield* transitionToAwaitingPassword(
        state,
        "awaiting-sudo-password",
        createdAt,
        "Remote sudo authentication failed.",
      );
    }

    return yield* failImport(
      state,
      createdAt,
      exitCode,
      exitSignal,
      plainHistory.trim().slice(-2_000) || "Secure host analysis failed.",
    );
  });

  const unsubscribe = yield* terminalManager.subscribe((event) => {
    if (!event.threadId.startsWith(HOST_IMPORT_OWNER_PREFIX)) {
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
            threadId: state.threadId,
            mutate: (current) => ({
              ...current,
              status: "running",
              finishedAt: null,
              updatedAt: event.snapshot.updatedAt,
              lastError: null,
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
            threadId: state.threadId,
            mutate: (current) => ({
              ...current,
              status: "running",
              updatedAt: event.createdAt,
            }),
          });
          return;
        case "error":
          yield* failImport(
            state,
            event.createdAt,
            null,
            null,
            event.message || "Secure host analysis failed to start.",
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

  const getPersisted = (input: HostImportGetInput) =>
    hostImportRepository
      .getByProjectAndThread(input)
      .pipe(
        Effect.mapError((cause) => toHostImportError("Failed to load host import state.", cause)),
      );

  const get: HostImportServiceShape["get"] = (input) =>
    getPersisted(input).pipe(Effect.map(Option.match({ onNone: () => null, onSome: toSummary })));

  const start: HostImportServiceShape["start"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      const terminalOwnerId = context.terminalOwnerId;
      return yield* withOwnerLock(
        terminalOwnerId,
        Effect.gen(function* () {
          yield* ensureHelperScripts();
          const existing = yield* getPersisted(input);

          if (Option.isSome(existing) && isActiveHostImportStatus(existing.value.status)) {
            const liveSnapshot = yield* terminalManager
              .getSnapshot({
                threadId: terminalOwnerId,
                terminalId: DEFAULT_TERMINAL_ID,
              })
              .pipe(
                Effect.mapError((cause) =>
                  toHostImportError("Failed to inspect the active host import session.", cause),
                ),
              );
            if (liveSnapshot !== null && liveSnapshot.status === "running") {
              return {
                disposition: "already-running",
                summary: toSummary(existing.value),
              } satisfies HostImportStartResult;
            }
          }

          const startedAt = new Date().toISOString();
          const row: PersistedHostImport = {
            projectId: input.projectId,
            threadId: input.threadId,
            hostName: context.hostName,
            sshTarget: context.sshTarget,
            terminalOwnerId,
            cwd: context.cwd,
            status: "starting",
            startedAt,
            finishedAt: null,
            updatedAt: startedAt,
            lastError: null,
            findingsSummary: null,
            exitCode: null,
            exitSignal: null,
          };

          const existingRunState = yield* getRunState(terminalOwnerId);
          if (existingRunState) {
            yield* clearRunState(existingRunState);
          }

          const runState: HostImportRunState = {
            projectId: input.projectId,
            threadId: input.threadId,
            hostName: context.hostName,
            sshTarget: context.sshTarget,
            terminalOwnerId,
            cwd: context.cwd,
            phase: "key",
            outputTail: "",
            activeSshPassword: null,
            activeSudoPassword: null,
            redactedSecrets: new Set(),
            sshPromptResponses: 0,
            sudoPromptResponses: 0,
          };
          yield* rememberRunState(runState);
          yield* persistSummary(row);
          yield* appendActivity({
            threadId: input.threadId,
            tone: "info",
            kind: "host-import.started",
            summary: `Started secure host analysis for ${context.hostName}.`,
            payload: {
              hostName: context.hostName,
              sshTarget: context.sshTarget,
            },
            createdAt: startedAt,
          });
          yield* launchPhase(runState, "key");

          return {
            disposition: "started",
            summary: toSummary(row),
          } satisfies HostImportStartResult;
        }),
      );
    });

  const cancel: HostImportServiceShape["cancel"] = (input) =>
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
          const next: PersistedHostImport = {
            ...existing.value,
            status: "canceled",
            finishedAt: canceledAt,
            updatedAt: canceledAt,
            lastError: existing.value.lastError,
          };
          yield* persistSummary(next);
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
            yield* secretVault.clearThread(input.threadId);
            yield* terminalManager.unregisterOutputSanitizer(context.terminalOwnerId);
          }
          return toSummary(next);
        }),
      );
    });

  const submitSecret: HostImportServiceShape["submitSecret"] = (input) =>
    Effect.gen(function* () {
      const context = yield* resolveStartContext(input);
      return yield* withOwnerLock(
        context.terminalOwnerId,
        Effect.gen(function* () {
          const current = yield* getPersisted({
            projectId: input.projectId,
            threadId: input.threadId,
          });
          if (Option.isNone(current)) {
            return yield* toHostImportError("Host import has not been started yet.");
          }
          const currentSummary = current.value;
          if (
            (input.phase === "ssh-login" && currentSummary.status !== "awaiting-ssh-password") ||
            (input.phase === "remote-sudo" && currentSummary.status !== "awaiting-sudo-password")
          ) {
            return {
              accepted: false,
              status: currentSummary.status,
            } satisfies HostImportSubmitSecretResult;
          }

          let runState = yield* getRunState(context.terminalOwnerId);
          if (!runState) {
            runState = {
              projectId: input.projectId,
              threadId: input.threadId,
              hostName: context.hostName,
              sshTarget: context.sshTarget,
              terminalOwnerId: context.terminalOwnerId,
              cwd: context.cwd,
              phase:
                currentSummary.status === "awaiting-sudo-password"
                  ? "sudo-password"
                  : "ssh-password",
              outputTail: "",
              activeSshPassword: null,
              activeSudoPassword: null,
              redactedSecrets: new Set(),
              sshPromptResponses: 0,
              sudoPromptResponses: 0,
            };
            yield* rememberRunState(runState);
          }

          yield* secretVault.set({
            threadId: input.threadId,
            phase: input.phase,
            secret: input.secret,
          });
          const consumed = yield* secretVault.take({
            threadId: input.threadId,
            phase: input.phase,
          });
          if (!consumed) {
            return {
              accepted: false,
              status: currentSummary.status,
            } satisfies HostImportSubmitSecretResult;
          }

          runState.redactedSecrets.add(consumed);
          if (input.phase === "ssh-login") {
            runState.activeSshPassword = consumed;
          } else {
            runState.activeSudoPassword = consumed;
          }

          const nextPhase: RunnerPhase =
            input.phase === "remote-sudo" || runState.phase === "sudo-password"
              ? "sudo-password"
              : "ssh-password";

          yield* launchPhase(runState, nextPhase);
          return {
            accepted: true,
            status: "starting",
          } satisfies HostImportSubmitSecretResult;
        }),
      );
    });

  const openTerminal: HostImportServiceShape["openTerminal"] = (input) =>
    Effect.gen(function* () {
      const persisted = yield* getPersisted({
        projectId: input.projectId,
        threadId: input.threadId,
      }).pipe(
        Effect.flatMap((row) =>
          Option.match(row, {
            onNone: () => Effect.fail(toHostImportError("No secure host import exists yet.")),
            onSome: Effect.succeed,
          }),
        ),
      );

      const liveSnapshot = yield* terminalManager
        .getSnapshot({
          threadId: persisted.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostImportError("Failed to open the secure host import terminal.", cause),
          ),
        );
      if (liveSnapshot !== null) {
        if (input.cols && input.rows && liveSnapshot.status === "running") {
          yield* terminalManager
            .resize({
              threadId: persisted.terminalOwnerId,
              terminalId: DEFAULT_TERMINAL_ID,
              cols: input.cols,
              rows: input.rows,
            })
            .pipe(Effect.ignore);
        }
        return mapTerminalSnapshot(liveSnapshot);
      }

      const history = yield* terminalManager
        .readHistory({
          threadId: persisted.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
        })
        .pipe(
          Effect.mapError((cause) =>
            toHostImportError("Failed to load secure host import terminal history.", cause),
          ),
        );

      return {
        terminalOwnerId: persisted.terminalOwnerId,
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: persisted.cwd,
        worktreePath: null,
        status:
          persisted.status === "starting"
            ? "starting"
            : persisted.status === "running"
              ? "running"
              : "exited",
        pid: null,
        history,
        exitCode: persisted.exitCode,
        exitSignal: persisted.exitSignal,
        updatedAt: persisted.updatedAt,
      } satisfies HostImportTerminalSnapshot;
    });

  const resizeTerminal: HostImportServiceShape["resizeTerminal"] = (input) =>
    Effect.gen(function* () {
      const persisted = yield* getPersisted({
        projectId: input.projectId,
        threadId: input.threadId,
      });
      if (Option.isNone(persisted) || !isActiveHostImportStatus(persisted.value.status)) {
        return;
      }
      yield* terminalManager
        .resize({
          threadId: persisted.value.terminalOwnerId,
          terminalId: DEFAULT_TERMINAL_ID,
          cols: input.cols,
          rows: input.rows,
        })
        .pipe(Effect.ignore);
    });

  const subscribeTerminalEvents: HostImportServiceShape["subscribeTerminalEvents"] = (input) =>
    Stream.callback<HostImportTerminalEvent, HostImportError>((queue) =>
      Effect.gen(function* () {
        const persisted = yield* getPersisted({
          projectId: input.projectId,
          threadId: input.threadId,
        }).pipe(
          Effect.flatMap((row) =>
            Option.match(row, {
              onNone: () => Effect.fail(toHostImportError("No secure host import exists yet.")),
              onSome: Effect.succeed,
            }),
          ),
        );

        return yield* Effect.acquireRelease(
          terminalManager.subscribe((event) => {
            if (event.threadId !== persisted.terminalOwnerId) {
              return Effect.void;
            }
            return Queue.offer(queue, mapTerminalEvent(event as never)).pipe(Effect.asVoid);
          }),
          (release) => Effect.sync(release),
        ).pipe(
          Effect.mapError((cause) =>
            toHostImportError("Failed to subscribe to secure host import terminal events.", cause),
          ),
        );
      }),
    );

  return {
    start,
    get,
    cancel,
    submitSecret,
    openTerminal,
    resizeTerminal,
    subscribeTerminalEvents,
  } satisfies HostImportServiceShape;
});

export const HostImportServiceLive = Layer.effect(HostImportService, makeHostImportService);
