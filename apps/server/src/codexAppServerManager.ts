import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import readline from "node:readline";

import {
  ApprovalRequestId,
  EventId,
  ProviderItemId,
  ProviderRequestKind,
  type ProviderTurnContext,
  type ProviderUserInputAnswers,
  ThreadId,
  TurnId,
  type ProviderApprovalDecision,
  type ProviderEvent,
  type ProviderSession,
  type ProviderTurnStartResult,
  RuntimeMode,
  ProviderInteractionMode,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { Effect, Context } from "effect";

import {
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  parseCodexCliVersion,
} from "./provider/codexCliVersion.ts";
import {
  readCodexAccountSnapshot,
  resolveCodexModelForAccount,
  type CodexAccountSnapshot,
} from "./provider/codexAccount.ts";
import { buildCodexInitializeParams, killCodexChildProcess } from "./provider/codexAppServer.ts";

export { buildCodexInitializeParams } from "./provider/codexAppServer.ts";
export { readCodexAccountSnapshot, resolveCodexModelForAccount } from "./provider/codexAccount.ts";

type PendingRequestKey = string;

interface PendingRequest {
  method: string;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingApprovalRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  method:
    | "item/commandExecution/requestApproval"
    | "item/fileChange/requestApproval"
    | "item/fileRead/requestApproval";
  requestKind: ProviderRequestKind;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface PendingUserInputRequest {
  requestId: ApprovalRequestId;
  jsonRpcId: string | number;
  threadId: ThreadId;
  turnId?: TurnId;
  itemId?: ProviderItemId;
}

interface CodexUserInputAnswer {
  answers: string[];
}

interface CodexSessionContext {
  session: ProviderSession;
  account: CodexAccountSnapshot;
  child: ChildProcessWithoutNullStreams;
  output: readline.Interface;
  pending: Map<PendingRequestKey, PendingRequest>;
  pendingApprovals: Map<ApprovalRequestId, PendingApprovalRequest>;
  pendingUserInputs: Map<ApprovalRequestId, PendingUserInputRequest>;
  collabReceiverTurns: Map<string, TurnId>;
  nextRequestId: number;
  stopping: boolean;
}

interface JsonRpcError {
  code?: number;
  message?: string;
}

interface JsonRpcRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: string | number;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface CodexAppServerSendTurnInput {
  readonly threadId: ThreadId;
  readonly input?: string;
  readonly attachments?: ReadonlyArray<{ type: "image"; url: string }>;
  readonly model?: string;
  readonly serviceTier?: string | null;
  readonly effort?: string;
  readonly interactionMode?: ProviderInteractionMode;
  readonly providerContext?: ProviderTurnContext;
}

export interface CodexAppServerStartSessionInput {
  readonly threadId: ThreadId;
  readonly provider?: "codex";
  readonly cwd?: string;
  readonly model?: string;
  readonly serviceTier?: string;
  readonly resumeCursor?: unknown;
  readonly binaryPath: string;
  readonly homePath?: string;
  readonly runtimeMode: RuntimeMode;
}

export interface CodexThreadTurnSnapshot {
  id: TurnId;
  items: unknown[];
}

export interface CodexThreadSnapshot {
  threadId: string;
  turns: CodexThreadTurnSnapshot[];
}

const CODEX_VERSION_CHECK_TIMEOUT_MS = 4_000;

const ANSI_ESCAPE_CHAR = String.fromCharCode(27);
const ANSI_ESCAPE_REGEX = new RegExp(`${ANSI_ESCAPE_CHAR}\\[[0-9;]*m`, "g");
const CODEX_STDERR_LOG_REGEX =
  /^\d{4}-\d{2}-\d{2}T\S+\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+\S+:\s+(.*)$/;
const BENIGN_ERROR_LOG_SNIPPETS = [
  "state db missing rollout path for thread",
  "state db record_discrepancy: find_thread_path_by_id_str_in_subdir, falling_back",
];
const RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS = [
  "not found",
  "missing thread",
  "no such thread",
  "unknown thread",
  "does not exist",
];
export const CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Plan Mode

You are in Plan Mode until developer instructions change it.

Rules:
- Do not implement or mutate repo-tracked files.
- You may explore, inspect, and run non-mutating checks.
- Resolve discoverable facts by exploring before asking questions.
- Ask about preferences and tradeoffs when they materially affect the design.
- Final output may contain at most one <proposed_plan> block.
- Only produce that block when the plan is decision-complete.

The final plan must include:
- a title
- a brief summary
- important API/interface/type changes
- test cases and scenarios
- explicit assumptions and defaults
</collaboration_mode>`;

export const CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS = `<collaboration_mode># Collaboration Mode: Default

You are in Default mode.

Rules:
- Execute the user's request instead of planning unless the user explicitly asks for a plan.
- Make reasonable assumptions and continue when risk is low.
- Ask only when a missing detail is necessary to avoid a likely wrong change.
- Keep responses concise and action-oriented.
</collaboration_mode>`;

export function buildCodexDeveloperInstructions(input: {
  readonly interactionMode: "default" | "plan";
  readonly providerContext?: ProviderTurnContext;
}): string {
  const sections = [
    input.interactionMode === "plan"
      ? CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS
      : CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  ];
  const context = input.providerContext;

  if (context?.projectKind === "nix-flake") {
    sections.push(
      [
        "You are operating inside a Nix flake management workspace.",
        "",
        "Priorities:",
        "- Prefer minimal, predictable changes.",
        "- Treat host scope, deployment behavior, and flake correctness as first-class.",
        "- Prefer editing the narrowest host- or module-specific files that satisfy the request.",
        "- Do not broaden changes across multiple hosts unless the user asks.",
        "- Prefer source truth in flake files over generated documentation when they disagree.",
        "- If present, use .t3code/changes.md and .t3code/docs/hosts/*.md as supporting context, not as sole truth.",
        "- Call out likely host impact when a change appears to affect deployment, networking, shared modules, or multiple hosts.",
      ].join("\n"),
    );
  }

  if (context?.scopedHostName?.trim()) {
    const hostName = context.scopedHostName.trim();
    sections.push(
      [
        `This thread is scoped to host: ${hostName}.`,
        "",
        "Default behavior:",
        "- Treat other hosts as out of scope.",
        `- Prefer host-local files, modules, and deploy targets for ${hostName}.`,
        "- Do not modify other hosts unless the user explicitly broadens scope.",
        "- If shared modules must be changed, minimize blast radius and explain the cross-host impact.",
      ].join("\n"),
    );
  }

  const relevantPaths = new Set<string>();
  const documentationPaths = context?.flake?.documentationPaths;
  if (documentationPaths?.generalChanges?.trim()) {
    relevantPaths.add(documentationPaths.generalChanges.trim());
  }
  if (documentationPaths?.hostDoc?.trim()) {
    relevantPaths.add(documentationPaths.hostDoc.trim());
  }
  if (relevantPaths.size > 0) {
    sections.push(
      [
        "Relevant project context may exist in:",
        ...[...relevantPaths].map((path) => `- ${path}`),
      ].join("\n"),
    );
  }

  return sections.join("\n\n");
}

function mapCodexRuntimeMode(runtimeMode: RuntimeMode): {
  readonly approvalPolicy: "untrusted" | "on-request" | "never";
  readonly sandbox: "read-only" | "workspace-write" | "danger-full-access";
} {
  switch (runtimeMode) {
    case "approval-required":
      return {
        approvalPolicy: "untrusted",
        sandbox: "read-only",
      };
    case "auto-accept-edits":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
      };
    case "full-access":
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
      };
  }
}

/**
 * On Windows with `shell: true`, `child.kill()` only terminates the `cmd.exe`
 * wrapper, leaving the actual command running. Use `taskkill /T` to kill the
 * entire process tree instead.
 */
function killChildTree(child: ChildProcessWithoutNullStreams): void {
  killCodexChildProcess(child);
}

export function normalizeCodexModelSlug(
  model: string | undefined | null,
  preferredId?: string,
): string | undefined {
  const normalized = normalizeModelSlug(model);
  if (!normalized) {
    return undefined;
  }

  if (preferredId?.endsWith("-codex") && preferredId !== normalized) {
    return preferredId;
  }

  return normalized;
}

function buildCodexCollaborationMode(input: {
  readonly interactionMode?: "default" | "plan";
  readonly model?: string;
  readonly effort?: string;
  readonly providerContext?: ProviderTurnContext;
}):
  | {
      mode: "default" | "plan";
      settings: {
        model: string;
        reasoning_effort: string;
        developer_instructions: string;
      };
    }
  | undefined {
  if (input.interactionMode === undefined) {
    return undefined;
  }
  const model = normalizeCodexModelSlug(input.model) ?? "gpt-5.3-codex";
  return {
    mode: input.interactionMode,
    settings: {
      model,
      reasoning_effort: input.effort ?? "medium",
      developer_instructions: buildCodexDeveloperInstructions({
        interactionMode: input.interactionMode,
        ...(input.providerContext !== undefined ? { providerContext: input.providerContext } : {}),
      }),
    },
  };
}

function toCodexUserInputAnswer(value: unknown): CodexUserInputAnswer {
  if (typeof value === "string") {
    return { answers: [value] };
  }

  if (Array.isArray(value)) {
    const answers = value.filter((entry): entry is string => typeof entry === "string");
    return { answers };
  }

  if (value && typeof value === "object") {
    const maybeAnswers = (value as { answers?: unknown }).answers;
    if (Array.isArray(maybeAnswers)) {
      const answers = maybeAnswers.filter((entry): entry is string => typeof entry === "string");
      return { answers };
    }
  }

  throw new Error("User input answers must be strings or arrays of strings.");
}

function toCodexUserInputAnswers(
  answers: ProviderUserInputAnswers,
): Record<string, CodexUserInputAnswer> {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [
      questionId,
      toCodexUserInputAnswer(value),
    ]),
  );
}

export function classifyCodexStderrLine(rawLine: string): { message: string } | null {
  const line = rawLine.replaceAll(ANSI_ESCAPE_REGEX, "").trim();
  if (!line) {
    return null;
  }

  const match = line.match(CODEX_STDERR_LOG_REGEX);
  if (match) {
    const level = match[1];
    if (level && level !== "ERROR") {
      return null;
    }

    const isBenignError = BENIGN_ERROR_LOG_SNIPPETS.some((snippet) => line.includes(snippet));
    if (isBenignError) {
      return null;
    }
  }

  return { message: line };
}

export function isRecoverableThreadResumeError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (!message.includes("thread/resume")) {
    return false;
  }

  return RECOVERABLE_THREAD_RESUME_ERROR_SNIPPETS.some((snippet) => message.includes(snippet));
}

export interface CodexAppServerManagerEvents {
  event: [event: ProviderEvent];
}

export class CodexAppServerManager extends EventEmitter<CodexAppServerManagerEvents> {
  private readonly sessions = new Map<ThreadId, CodexSessionContext>();

  private runPromise: (effect: Effect.Effect<unknown, never>) => Promise<unknown>;
  constructor(services?: Context.Context<never>) {
    super();
    this.runPromise = services ? Effect.runPromiseWith(services) : Effect.runPromise;
  }

  async startSession(input: CodexAppServerStartSessionInput): Promise<ProviderSession> {
    const threadId = input.threadId;
    const now = new Date().toISOString();
    let context: CodexSessionContext | undefined;

    try {
      const existingContext = this.sessions.get(threadId);
      if (existingContext) {
        await Effect.logWarning("codex app-server replacing existing session", {
          threadId,
          existingStatus: existingContext.session.status,
        }).pipe(this.runPromise);
        try {
          this.disposeSession(existingContext, {
            emitLifecycleEvent: false,
          });
        } catch (error) {
          await Effect.logWarning("codex app-server failed to dispose existing session", {
            threadId,
            existingStatus: existingContext.session.status,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
        }
      }

      const resolvedCwd = input.cwd ?? process.cwd();

      const session: ProviderSession = {
        provider: "codex",
        status: "connecting",
        runtimeMode: input.runtimeMode,
        model: normalizeCodexModelSlug(input.model),
        cwd: resolvedCwd,
        threadId,
        createdAt: now,
        updatedAt: now,
      };

      const codexBinaryPath = input.binaryPath;
      const codexHomePath = input.homePath;
      this.assertSupportedCodexCliVersion({
        binaryPath: codexBinaryPath,
        cwd: resolvedCwd,
        ...(codexHomePath ? { homePath: codexHomePath } : {}),
      });
      const child = spawn(codexBinaryPath, ["app-server"], {
        cwd: resolvedCwd,
        env: {
          ...process.env,
          ...(codexHomePath ? { CODEX_HOME: codexHomePath } : {}),
        },
        stdio: ["pipe", "pipe", "pipe"],
        shell: process.platform === "win32",
      });
      const output = readline.createInterface({ input: child.stdout });

      context = {
        session,
        account: {
          type: "unknown",
          planType: null,
          sparkEnabled: true,
        },
        child,
        output,
        pending: new Map(),
        pendingApprovals: new Map(),
        pendingUserInputs: new Map(),
        collabReceiverTurns: new Map(),
        nextRequestId: 1,
        stopping: false,
      };

      this.sessions.set(threadId, context);
      this.attachProcessListeners(context);

      this.emitLifecycleEvent(context, "session/connecting", "Starting codex app-server");

      await this.sendRequest(context, "initialize", buildCodexInitializeParams());

      this.writeMessage(context, { method: "initialized" });
      try {
        const modelListResponse = await this.sendRequest(context, "model/list", {});
        console.log("codex model/list response", modelListResponse);
      } catch (error) {
        console.log("codex model/list failed", error);
      }
      try {
        const accountReadResponse = await this.sendRequest(context, "account/read", {});
        console.log("codex account/read response", accountReadResponse);
        context.account = readCodexAccountSnapshot(accountReadResponse);
        console.log("codex subscription status", {
          type: context.account.type,
          planType: context.account.planType,
          sparkEnabled: context.account.sparkEnabled,
        });
      } catch (error) {
        console.log("codex account/read failed", error);
      }

      const normalizedModel = resolveCodexModelForAccount(
        normalizeCodexModelSlug(input.model),
        context.account,
      );
      const sessionOverrides = {
        model: normalizedModel ?? null,
        ...(input.serviceTier !== undefined ? { serviceTier: input.serviceTier } : {}),
        cwd: input.cwd ?? null,
        ...mapCodexRuntimeMode(input.runtimeMode ?? "full-access"),
      };

      const threadStartParams = {
        ...sessionOverrides,
        experimentalRawEvents: false,
      };
      const resumeThreadId = readResumeThreadId(input);
      this.emitLifecycleEvent(
        context,
        "session/threadOpenRequested",
        resumeThreadId
          ? `Attempting to resume thread ${resumeThreadId}.`
          : "Starting a new Codex thread.",
      );
      await Effect.logInfo("codex app-server opening thread", {
        threadId,
        requestedRuntimeMode: input.runtimeMode,
        requestedModel: normalizedModel ?? null,
        requestedCwd: resolvedCwd,
        resumeThreadId: resumeThreadId ?? null,
      }).pipe(this.runPromise);

      let threadOpenMethod: "thread/start" | "thread/resume" = "thread/start";
      let threadOpenResponse: unknown;
      if (resumeThreadId) {
        try {
          threadOpenMethod = "thread/resume";
          threadOpenResponse = await this.sendRequest(context, "thread/resume", {
            ...sessionOverrides,
            threadId: resumeThreadId,
          });
        } catch (error) {
          if (!isRecoverableThreadResumeError(error)) {
            this.emitErrorEvent(
              context,
              "session/threadResumeFailed",
              error instanceof Error ? error.message : "Codex thread resume failed.",
            );
            await Effect.logWarning("codex app-server thread resume failed", {
              threadId,
              requestedRuntimeMode: input.runtimeMode,
              resumeThreadId,
              recoverable: false,
              cause: error instanceof Error ? error.message : String(error),
            }).pipe(this.runPromise);
            throw error;
          }

          threadOpenMethod = "thread/start";
          this.emitLifecycleEvent(
            context,
            "session/threadResumeFallback",
            `Could not resume thread ${resumeThreadId}; started a new thread instead.`,
          );
          await Effect.logWarning("codex app-server thread resume fell back to fresh start", {
            threadId,
            requestedRuntimeMode: input.runtimeMode,
            resumeThreadId,
            recoverable: true,
            cause: error instanceof Error ? error.message : String(error),
          }).pipe(this.runPromise);
          threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
        }
      } else {
        threadOpenMethod = "thread/start";
        threadOpenResponse = await this.sendRequest(context, "thread/start", threadStartParams);
      }

      const threadOpenRecord = this.readObject(threadOpenResponse);
      const threadIdRaw =
        this.readString(this.readObject(threadOpenRecord, "thread"), "id") ??
        this.readString(threadOpenRecord, "threadId");
      if (!threadIdRaw) {
        throw new Error(`${threadOpenMethod} response did not include a thread id.`);
      }
      const providerThreadId = threadIdRaw;

      this.updateSession(context, {
        status: "ready",
        resumeCursor: { threadId: providerThreadId },
      });
      this.emitLifecycleEvent(
        context,
        "session/threadOpenResolved",
        `Codex ${threadOpenMethod} resolved.`,
      );
      await Effect.logInfo("codex app-server thread open resolved", {
        threadId,
        threadOpenMethod,
        requestedResumeThreadId: resumeThreadId ?? null,
        resolvedThreadId: providerThreadId,
        requestedRuntimeMode: input.runtimeMode,
      }).pipe(this.runPromise);
      this.emitLifecycleEvent(context, "session/ready", `Connected to thread ${providerThreadId}`);
      return { ...context.session };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to start Codex session.";
      if (context) {
        this.updateSession(context, {
          status: "error",
          lastError: message,
        });
        this.emitErrorEvent(context, "session/startFailed", message);
        this.stopSession(threadId);
      } else {
        this.emitEvent({
          id: EventId.make(randomUUID()),
          kind: "error",
          provider: "codex",
          threadId,
          createdAt: new Date().toISOString(),
          method: "session/startFailed",
          message,
        });
      }
      throw new Error(message, { cause: error });
    }
  }

  async sendTurn(input: CodexAppServerSendTurnInput): Promise<ProviderTurnStartResult> {
    const context = this.requireSession(input.threadId);
    context.collabReceiverTurns.clear();

    const turnInput: Array<
      { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
    > = [];
    if (input.input) {
      turnInput.push({
        type: "text",
        text: input.input,
        text_elements: [],
      });
    }
    for (const attachment of input.attachments ?? []) {
      if (attachment.type === "image") {
        turnInput.push({
          type: "image",
          url: attachment.url,
        });
      }
    }
    if (turnInput.length === 0) {
      throw new Error("Turn input must include text or attachments.");
    }

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing provider resume thread id.");
    }
    const turnStartParams: {
      threadId: string;
      input: Array<
        { type: "text"; text: string; text_elements: [] } | { type: "image"; url: string }
      >;
      model?: string;
      serviceTier?: string | null;
      effort?: string;
      collaborationMode?: {
        mode: "default" | "plan";
        settings: {
          model: string;
          reasoning_effort: string;
          developer_instructions: string;
        };
      };
    } = {
      threadId: providerThreadId,
      input: turnInput,
    };
    const normalizedModel = resolveCodexModelForAccount(
      normalizeCodexModelSlug(input.model ?? context.session.model),
      context.account,
    );
    if (normalizedModel) {
      turnStartParams.model = normalizedModel;
    }
    if (input.serviceTier !== undefined) {
      turnStartParams.serviceTier = input.serviceTier;
    }
    if (input.effort) {
      turnStartParams.effort = input.effort;
    }
    const collaborationMode = buildCodexCollaborationMode({
      ...(input.interactionMode !== undefined ? { interactionMode: input.interactionMode } : {}),
      ...(normalizedModel !== undefined ? { model: normalizedModel } : {}),
      ...(input.effort !== undefined ? { effort: input.effort } : {}),
      ...(input.providerContext !== undefined ? { providerContext: input.providerContext } : {}),
    });
    if (collaborationMode) {
      if (!turnStartParams.model) {
        turnStartParams.model = collaborationMode.settings.model;
      }
      turnStartParams.collaborationMode = collaborationMode;
    }

    const response = await this.sendRequest(context, "turn/start", turnStartParams);

    const turn = this.readObject(this.readObject(response), "turn");
    const turnIdRaw = this.readString(turn, "id");
    if (!turnIdRaw) {
      throw new Error("turn/start response did not include a turn id.");
    }
    const turnId = TurnId.make(turnIdRaw);

    this.updateSession(context, {
      status: "running",
      activeTurnId: turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    return {
      threadId: context.session.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  }

  async interruptTurn(threadId: ThreadId, turnId?: TurnId): Promise<void> {
    const context = this.requireSession(threadId);
    const effectiveTurnId = turnId ?? context.session.activeTurnId;

    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!effectiveTurnId || !providerThreadId) {
      return;
    }

    await this.sendRequest(context, "turn/interrupt", {
      threadId: providerThreadId,
      turnId: effectiveTurnId,
    });
  }

  async readThread(threadId: ThreadId): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }

    const response = await this.sendRequest(context, "thread/read", {
      threadId: providerThreadId,
      includeTurns: true,
    });
    return this.parseThreadSnapshot("thread/read", response);
  }

  async rollbackThread(threadId: ThreadId, numTurns: number): Promise<CodexThreadSnapshot> {
    const context = this.requireSession(threadId);
    const providerThreadId = readResumeThreadId({
      threadId: context.session.threadId,
      runtimeMode: context.session.runtimeMode,
      resumeCursor: context.session.resumeCursor,
    });
    if (!providerThreadId) {
      throw new Error("Session is missing a provider resume thread id.");
    }
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      throw new Error("numTurns must be an integer >= 1.");
    }

    const response = await this.sendRequest(context, "thread/rollback", {
      threadId: providerThreadId,
      numTurns,
    });
    this.updateSession(context, {
      status: "ready",
      activeTurnId: undefined,
    });
    return this.parseThreadSnapshot("thread/rollback", response);
  }

  async respondToRequest(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingApprovals.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending approval request: ${requestId}`);
    }

    context.pendingApprovals.delete(requestId);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        decision,
      },
    });

    this.emitEvent({
      id: EventId.make(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/requestApproval/decision",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      requestKind: pendingRequest.requestKind,
      payload: {
        requestId: pendingRequest.requestId,
        requestKind: pendingRequest.requestKind,
        decision,
      },
    });
  }

  async respondToUserInput(
    threadId: ThreadId,
    requestId: ApprovalRequestId,
    answers: ProviderUserInputAnswers,
  ): Promise<void> {
    const context = this.requireSession(threadId);
    const pendingRequest = context.pendingUserInputs.get(requestId);
    if (!pendingRequest) {
      throw new Error(`Unknown pending user input request: ${requestId}`);
    }

    context.pendingUserInputs.delete(requestId);
    const codexAnswers = toCodexUserInputAnswers(answers);
    this.writeMessage(context, {
      id: pendingRequest.jsonRpcId,
      result: {
        answers: codexAnswers,
      },
    });

    this.emitEvent({
      id: EventId.make(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: "item/tool/requestUserInput/answered",
      turnId: pendingRequest.turnId,
      itemId: pendingRequest.itemId,
      requestId: pendingRequest.requestId,
      payload: {
        requestId: pendingRequest.requestId,
        answers: codexAnswers,
      },
    });
  }

  stopSession(threadId: ThreadId): void {
    const context = this.sessions.get(threadId);
    if (!context) {
      return;
    }

    this.disposeSession(context, {
      emitLifecycleEvent: true,
    });
  }

  private disposeSession(
    context: CodexSessionContext,
    options?: { readonly emitLifecycleEvent?: boolean },
  ): void {
    if (context.stopping) {
      return;
    }

    context.stopping = true;

    for (const pending of context.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Session stopped before request completed."));
    }
    context.pending.clear();
    context.pendingApprovals.clear();
    context.pendingUserInputs.clear();

    context.output.close();

    if (!context.child.killed) {
      killChildTree(context.child);
    }

    this.updateSession(context, {
      status: "closed",
      activeTurnId: undefined,
    });
    if (options?.emitLifecycleEvent !== false) {
      this.emitLifecycleEvent(context, "session/closed", "Session stopped");
    }
    this.sessions.delete(context.session.threadId);
  }

  listSessions(): ProviderSession[] {
    return Array.from(this.sessions.values(), ({ session }) => ({
      ...session,
    }));
  }

  hasSession(threadId: ThreadId): boolean {
    return this.sessions.has(threadId);
  }

  stopAll(): void {
    for (const threadId of this.sessions.keys()) {
      this.stopSession(threadId);
    }
  }

  private requireSession(threadId: ThreadId): CodexSessionContext {
    const context = this.sessions.get(threadId);
    if (!context) {
      throw new Error(`Unknown session for thread: ${threadId}`);
    }

    if (context.session.status === "closed") {
      throw new Error(`Session is closed for thread: ${threadId}`);
    }

    return context;
  }

  private attachProcessListeners(context: CodexSessionContext): void {
    context.output.on("line", (line) => {
      this.handleStdoutLine(context, line);
    });

    context.child.stderr.on("data", (chunk: Buffer) => {
      const raw = chunk.toString();
      const lines = raw.split(/\r?\n/g);
      for (const rawLine of lines) {
        const classified = classifyCodexStderrLine(rawLine);
        if (!classified) {
          continue;
        }

        this.emitNotificationEvent(context, "process/stderr", classified.message);
      }
    });

    context.child.on("error", (error) => {
      const message = error.message || "codex app-server process errored.";
      this.updateSession(context, {
        status: "error",
        lastError: message,
      });
      this.emitErrorEvent(context, "process/error", message);
    });

    context.child.on("exit", (code, signal) => {
      if (context.stopping) {
        return;
      }

      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"}).`;
      this.updateSession(context, {
        status: "closed",
        activeTurnId: undefined,
        lastError: code === 0 ? context.session.lastError : message,
      });
      this.emitLifecycleEvent(context, "session/exited", message);
      this.sessions.delete(context.session.threadId);
    });
  }

  private handleStdoutLine(context: CodexSessionContext, line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.emitErrorEvent(
        context,
        "protocol/parseError",
        "Received invalid JSON from codex app-server.",
      );
      return;
    }

    if (!parsed || typeof parsed !== "object") {
      this.emitErrorEvent(
        context,
        "protocol/invalidMessage",
        "Received non-object protocol message.",
      );
      return;
    }

    if (this.isServerRequest(parsed)) {
      this.handleServerRequest(context, parsed);
      return;
    }

    if (this.isServerNotification(parsed)) {
      this.handleServerNotification(context, parsed);
      return;
    }

    if (this.isResponse(parsed)) {
      this.handleResponse(context, parsed);
      return;
    }

    this.emitErrorEvent(
      context,
      "protocol/unrecognizedMessage",
      "Received protocol message in an unknown shape.",
    );
  }

  private handleServerNotification(
    context: CodexSessionContext,
    notification: JsonRpcNotification,
  ): void {
    const rawRoute = this.readRouteFields(notification.params);
    this.rememberCollabReceiverTurns(context, notification.params, rawRoute.turnId);
    const childParentTurnId = this.readChildParentTurnId(context, notification.params);
    const isChildConversation = childParentTurnId !== undefined;
    if (
      isChildConversation &&
      this.shouldSuppressChildConversationNotification(notification.method)
    ) {
      return;
    }
    const textDelta =
      notification.method === "item/agentMessage/delta"
        ? this.readString(notification.params, "delta")
        : undefined;

    this.emitEvent({
      id: EventId.make(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: notification.method,
      ...((childParentTurnId ?? rawRoute.turnId)
        ? { turnId: childParentTurnId ?? rawRoute.turnId }
        : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      textDelta,
      payload: notification.params,
    });

    if (notification.method === "thread/started") {
      const providerThreadId = normalizeProviderThreadId(
        this.readString(this.readObject(notification.params)?.thread, "id"),
      );
      if (providerThreadId) {
        this.updateSession(context, { resumeCursor: { threadId: providerThreadId } });
      }
      return;
    }

    if (notification.method === "turn/started") {
      if (isChildConversation) {
        return;
      }
      const turnId = toTurnId(this.readString(this.readObject(notification.params)?.turn, "id"));
      this.updateSession(context, {
        status: "running",
        activeTurnId: turnId,
      });
      return;
    }

    if (notification.method === "turn/completed") {
      if (isChildConversation) {
        return;
      }
      context.collabReceiverTurns.clear();
      const turn = this.readObject(notification.params, "turn");
      const status = this.readString(turn, "status");
      const errorMessage = this.readString(this.readObject(turn, "error"), "message");
      this.updateSession(context, {
        status: status === "failed" ? "error" : "ready",
        activeTurnId: undefined,
        lastError: errorMessage ?? context.session.lastError,
      });
      return;
    }

    if (notification.method === "error") {
      if (isChildConversation) {
        return;
      }
      const message = this.readString(this.readObject(notification.params)?.error, "message");
      const willRetry = this.readBoolean(notification.params, "willRetry");

      this.updateSession(context, {
        status: willRetry ? "running" : "error",
        lastError: message ?? context.session.lastError,
      });
    }
  }

  private handleServerRequest(context: CodexSessionContext, request: JsonRpcRequest): void {
    const rawRoute = this.readRouteFields(request.params);
    const childParentTurnId = this.readChildParentTurnId(context, request.params);
    const effectiveTurnId = childParentTurnId ?? rawRoute.turnId;
    const requestKind = this.requestKindForMethod(request.method);
    let requestId: ApprovalRequestId | undefined;
    if (requestKind) {
      requestId = ApprovalRequestId.make(randomUUID());
      const pendingRequest: PendingApprovalRequest = {
        requestId,
        jsonRpcId: request.id,
        method:
          requestKind === "command"
            ? "item/commandExecution/requestApproval"
            : requestKind === "file-read"
              ? "item/fileRead/requestApproval"
              : "item/fileChange/requestApproval",
        requestKind,
        threadId: context.session.threadId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      };
      context.pendingApprovals.set(requestId, pendingRequest);
    }

    if (request.method === "item/tool/requestUserInput") {
      requestId = ApprovalRequestId.make(randomUUID());
      context.pendingUserInputs.set(requestId, {
        requestId,
        jsonRpcId: request.id,
        threadId: context.session.threadId,
        ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
        ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      });
    }

    this.emitEvent({
      id: EventId.make(randomUUID()),
      kind: "request",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method: request.method,
      ...(effectiveTurnId ? { turnId: effectiveTurnId } : {}),
      ...(rawRoute.itemId ? { itemId: rawRoute.itemId } : {}),
      requestId,
      requestKind,
      payload: request.params,
    });

    if (requestKind) {
      return;
    }

    if (request.method === "item/tool/requestUserInput") {
      return;
    }

    this.writeMessage(context, {
      id: request.id,
      error: {
        code: -32601,
        message: `Unsupported server request: ${request.method}`,
      },
    });
  }

  private handleResponse(context: CodexSessionContext, response: JsonRpcResponse): void {
    const key = String(response.id);
    const pending = context.pending.get(key);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    context.pending.delete(key);

    if (response.error?.message) {
      pending.reject(new Error(`${pending.method} failed: ${String(response.error.message)}`));
      return;
    }

    pending.resolve(response.result);
  }

  private async sendRequest<TResponse>(
    context: CodexSessionContext,
    method: string,
    params: unknown,
    timeoutMs = 20_000,
  ): Promise<TResponse> {
    const id = context.nextRequestId;
    context.nextRequestId += 1;

    const result = await new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        context.pending.delete(String(id));
        reject(new Error(`Timed out waiting for ${method}.`));
      }, timeoutMs);

      context.pending.set(String(id), {
        method,
        timeout,
        resolve,
        reject,
      });
      this.writeMessage(context, {
        method,
        id,
        params,
      });
    });

    return result as TResponse;
  }

  private writeMessage(context: CodexSessionContext, message: unknown): void {
    const encoded = JSON.stringify(message);
    if (!context.child.stdin.writable) {
      throw new Error("Cannot write to codex app-server stdin.");
    }

    context.child.stdin.write(`${encoded}\n`);
  }

  private emitLifecycleEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.make(randomUUID()),
      kind: "session",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitErrorEvent(context: CodexSessionContext, method: string, message: string): void {
    this.emitEvent({
      id: EventId.make(randomUUID()),
      kind: "error",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitNotificationEvent(
    context: CodexSessionContext,
    method: string,
    message: string,
  ): void {
    this.emitEvent({
      id: EventId.make(randomUUID()),
      kind: "notification",
      provider: "codex",
      threadId: context.session.threadId,
      createdAt: new Date().toISOString(),
      method,
      message,
    });
  }

  private emitEvent(event: ProviderEvent): void {
    this.emit("event", event);
  }

  private assertSupportedCodexCliVersion(input: {
    readonly binaryPath: string;
    readonly cwd: string;
    readonly homePath?: string;
  }): void {
    assertSupportedCodexCliVersion(input);
  }

  private updateSession(context: CodexSessionContext, updates: Partial<ProviderSession>): void {
    context.session = {
      ...context.session,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  }

  private requestKindForMethod(method: string): ProviderRequestKind | undefined {
    if (method === "item/commandExecution/requestApproval") {
      return "command";
    }

    if (method === "item/fileRead/requestApproval") {
      return "file-read";
    }

    if (method === "item/fileChange/requestApproval") {
      return "file-change";
    }

    return undefined;
  }

  private parseThreadSnapshot(method: string, response: unknown): CodexThreadSnapshot {
    const responseRecord = this.readObject(response);
    const thread = this.readObject(responseRecord, "thread");
    const threadIdRaw =
      this.readString(thread, "id") ?? this.readString(responseRecord, "threadId");
    if (!threadIdRaw) {
      throw new Error(`${method} response did not include a thread id.`);
    }
    const turnsRaw =
      this.readArray(thread, "turns") ?? this.readArray(responseRecord, "turns") ?? [];
    const turns = turnsRaw.map((turnValue, index) => {
      const turn = this.readObject(turnValue);
      const turnIdRaw = this.readString(turn, "id") ?? `${threadIdRaw}:turn:${index + 1}`;
      const turnId = TurnId.make(turnIdRaw);
      const items = this.readArray(turn, "items") ?? [];
      return {
        id: turnId,
        items,
      };
    });

    return {
      threadId: threadIdRaw,
      turns,
    };
  }

  private isServerRequest(value: unknown): value is JsonRpcRequest {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return (
      typeof candidate.method === "string" &&
      (typeof candidate.id === "string" || typeof candidate.id === "number")
    );
  }

  private isServerNotification(value: unknown): value is JsonRpcNotification {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    return typeof candidate.method === "string" && !("id" in candidate);
  }

  private isResponse(value: unknown): value is JsonRpcResponse {
    if (!value || typeof value !== "object") {
      return false;
    }

    const candidate = value as Record<string, unknown>;
    const hasId = typeof candidate.id === "string" || typeof candidate.id === "number";
    const hasMethod = typeof candidate.method === "string";
    return hasId && !hasMethod;
  }

  private readRouteFields(params: unknown): {
    turnId?: TurnId;
    itemId?: ProviderItemId;
  } {
    const route: {
      turnId?: TurnId;
      itemId?: ProviderItemId;
    } = {};

    const turnId = toTurnId(
      this.readString(params, "turnId") ?? this.readString(this.readObject(params, "turn"), "id"),
    );
    const itemId = toProviderItemId(
      this.readString(params, "itemId") ?? this.readString(this.readObject(params, "item"), "id"),
    );

    if (turnId) {
      route.turnId = turnId;
    }

    if (itemId) {
      route.itemId = itemId;
    }

    return route;
  }

  private readProviderConversationId(params: unknown): string | undefined {
    return (
      this.readString(params, "threadId") ??
      this.readString(this.readObject(params, "thread"), "id") ??
      this.readString(params, "conversationId")
    );
  }

  private readChildParentTurnId(context: CodexSessionContext, params: unknown): TurnId | undefined {
    const providerConversationId = this.readProviderConversationId(params);
    if (!providerConversationId) {
      return undefined;
    }
    return context.collabReceiverTurns.get(providerConversationId);
  }

  private rememberCollabReceiverTurns(
    context: CodexSessionContext,
    params: unknown,
    parentTurnId: TurnId | undefined,
  ): void {
    if (!parentTurnId) {
      return;
    }
    const payload = this.readObject(params);
    const item = this.readObject(payload, "item") ?? payload;
    const itemType = this.readString(item, "type") ?? this.readString(item, "kind");
    if (itemType !== "collabAgentToolCall") {
      return;
    }

    const receiverThreadIds =
      this.readArray(item, "receiverThreadIds")
        ?.map((value) => (typeof value === "string" ? value : null))
        .filter((value): value is string => value !== null) ?? [];
    for (const receiverThreadId of receiverThreadIds) {
      context.collabReceiverTurns.set(receiverThreadId, parentTurnId);
    }
  }

  private shouldSuppressChildConversationNotification(method: string): boolean {
    return (
      method === "thread/started" ||
      method === "thread/status/changed" ||
      method === "thread/archived" ||
      method === "thread/unarchived" ||
      method === "thread/closed" ||
      method === "thread/compacted" ||
      method === "thread/name/updated" ||
      method === "thread/tokenUsage/updated" ||
      method === "turn/started" ||
      method === "turn/completed" ||
      method === "turn/aborted" ||
      method === "turn/plan/updated" ||
      method === "item/plan/delta"
    );
  }

  private readObject(value: unknown, key?: string): Record<string, unknown> | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;

    if (!target || typeof target !== "object") {
      return undefined;
    }

    return target as Record<string, unknown>;
  }

  private readArray(value: unknown, key?: string): unknown[] | undefined {
    const target =
      key === undefined
        ? value
        : value && typeof value === "object"
          ? (value as Record<string, unknown>)[key]
          : undefined;
    return Array.isArray(target) ? target : undefined;
  }

  private readString(value: unknown, key: string): string | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  }

  private readBoolean(value: unknown, key: string): boolean | undefined {
    if (!value || typeof value !== "object") {
      return undefined;
    }

    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  }
}

function brandIfNonEmpty<T extends string>(
  value: string | undefined,
  maker: (value: string) => T,
): T | undefined {
  const normalized = value?.trim();
  return normalized?.length ? maker(normalized) : undefined;
}

function normalizeProviderThreadId(value: string | undefined): string | undefined {
  return brandIfNonEmpty(value, (normalized) => normalized);
}

function assertSupportedCodexCliVersion(input: {
  readonly binaryPath: string;
  readonly cwd: string;
  readonly homePath?: string;
}): void {
  const result = spawnSync(input.binaryPath, ["--version"], {
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.homePath ? { CODEX_HOME: input.homePath } : {}),
    },
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: CODEX_VERSION_CHECK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  if (result.error) {
    const lower = result.error.message.toLowerCase();
    if (
      lower.includes("enoent") ||
      lower.includes("command not found") ||
      lower.includes("not found")
    ) {
      throw new Error(`Codex CLI (${input.binaryPath}) is not installed or not executable.`);
    }
    throw new Error(
      `Failed to execute Codex CLI version check: ${result.error.message || String(result.error)}`,
    );
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  if (result.status !== 0) {
    const detail = stderr.trim() || stdout.trim() || `Command exited with code ${result.status}.`;
    throw new Error(`Codex CLI version check failed. ${detail}`);
  }

  const parsedVersion = parseCodexCliVersion(`${stdout}\n${stderr}`);
  if (parsedVersion && !isCodexCliVersionSupported(parsedVersion)) {
    throw new Error(formatCodexCliUpgradeMessage(parsedVersion));
  }
}

function readResumeCursorThreadId(resumeCursor: unknown): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const rawThreadId = (resumeCursor as Record<string, unknown>).threadId;
  return typeof rawThreadId === "string" ? normalizeProviderThreadId(rawThreadId) : undefined;
}

function readResumeThreadId(input: {
  readonly resumeCursor?: unknown;
  readonly threadId?: ThreadId;
  readonly runtimeMode?: RuntimeMode;
}): string | undefined {
  return readResumeCursorThreadId(input.resumeCursor);
}

function toTurnId(value: string | undefined): TurnId | undefined {
  return brandIfNonEmpty(value, TurnId.make);
}

function toProviderItemId(value: string | undefined): ProviderItemId | undefined {
  return brandIfNonEmpty(value, ProviderItemId.make);
}
