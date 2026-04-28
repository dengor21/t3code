import assert from "node:assert/strict";

import { Effect, Schema } from "effect";
import { describe, it } from "vitest";
import { ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import { buildCodexDeveloperInstructions } from "../CodexDeveloperInstructions.ts";
import {
  buildTurnStartParams,
  handleHalDynamicToolCall,
  isRecoverableThreadResumeError,
  openCodexThread,
} from "./CodexSessionRuntime.ts";

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "dangerFullAccess" },
    thread: {
      cliVersion: "0.0.0-test",
      cwd: "/tmp/project",
      ephemeral: false,
      id: threadId,
      createdAt: 1_713_398_400,
      modelProvider: "openai",
      preview: "",
      source: "cli",
      turns: [],
      status: { type: "idle" },
      updatedAt: 1_713_398_400,
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

function firstResponseText(
  response: ReturnType<typeof handleHalDynamicToolCall>["response"],
): string | undefined {
  const firstItem = response.contentItems[0];
  return firstItem?.type === "inputText" ? firstItem.text : undefined;
}

function dynamicToolNames(payload: unknown): string[] {
  if (!payload || typeof payload !== "object" || !("dynamicTools" in payload)) {
    return [];
  }
  const dynamicTools = (payload as { dynamicTools?: unknown }).dynamicTools;
  if (!Array.isArray(dynamicTools)) {
    return [];
  }
  return dynamicTools.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || !("name" in entry)) {
      return [];
    }
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" ? [name] : [];
  });
}

describe("buildTurnStartParams", () => {
  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions({
            interactionMode: "plan",
          }),
        },
      },
    });
  });

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions({
            interactionMode: "default",
          }),
        },
      },
    });
  });

  it("embeds explicit host-scope developer instructions for host-scoped threads", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        providerContext: {
          projectKind: "generic",
          scopedHostName: "nexus",
        },
      }),
    );

    assert.ok(params.collaborationMode);
    assert.equal(params.collaborationMode?.mode, "default");
    const developerInstructions =
      params.collaborationMode?.settings.developer_instructions ?? undefined;
    assert.ok(developerInstructions);
    assert.ok(
      developerInstructions.includes("Host scope:\n- This thread is scoped to host nexus."),
    );
    assert.ok(
      developerInstructions.includes(
        "The scoped host is the default for investigation, planning, implementation, and answers.",
      ),
    );
    assert.ok(developerInstructions.includes("Remote host access rules:"));
  });

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    assert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    assert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("handleHalDynamicToolCall", () => {
  it("opens a scoped host deploy dialog when hostName is omitted", () => {
    const handled = handleHalDynamicToolCall({
      payload: {
        tool: "hal_open_host_deploy_dialog",
        arguments: {},
        callId: "call-1",
        threadId: "provider-thread-1",
        turnId: "turn-1",
      },
      providerContext: {
        projectKind: "nix-flake",
        remoteHostAccessPolicy: "hal-managed-only",
        scopedHostName: "nexus",
        flake: {
          hostNames: ["nexus", "router"],
        },
      },
    });

    assert.equal(handled.response.success, true);
    assert.deepStrictEqual(handled.uiActionPayload, {
      kind: "open-host-deploy-dialog",
      actionId: handled.uiActionPayload?.actionId,
      hostName: "nexus",
    });
  });

  it("rejects host deploy when project scope does not identify a host", () => {
    const handled = handleHalDynamicToolCall({
      payload: {
        tool: "hal_open_host_deploy_dialog",
        arguments: {},
        callId: "call-1",
        threadId: "provider-thread-1",
        turnId: "turn-1",
      },
      providerContext: {
        projectKind: "nix-flake",
        remoteHostAccessPolicy: "hal-managed-only",
        flake: {
          hostNames: ["nexus", "router"],
        },
      },
    });

    assert.equal(handled.response.success, false);
    assert.equal(handled.uiActionPayload, undefined);
    assert.ok(
      firstResponseText(handled.response)?.includes("single host deploy or a fleet rollout"),
    );
  });

  it("opens fleet rollout for project-scoped flake threads", () => {
    const handled = handleHalDynamicToolCall({
      payload: {
        tool: "hal_open_fleet_rollout",
        arguments: {},
        callId: "call-1",
        threadId: "provider-thread-1",
        turnId: "turn-1",
      },
      providerContext: {
        projectKind: "nix-flake",
        remoteHostAccessPolicy: "hal-managed-only",
        flake: {
          hostNames: ["nexus", "router"],
        },
      },
    });

    assert.equal(handled.response.success, true);
    assert.deepStrictEqual(handled.uiActionPayload, {
      kind: "open-fleet-rollout",
      actionId: handled.uiActionPayload?.actionId,
    });
  });

  it("rejects unknown HAL tool names cleanly", () => {
    const handled = handleHalDynamicToolCall({
      payload: {
        tool: "hal_unknown_tool",
        arguments: {},
        callId: "call-1",
        threadId: "provider-thread-1",
        turnId: "turn-1",
      },
      providerContext: {
        projectKind: "nix-flake",
        remoteHostAccessPolicy: "hal-managed-only",
        flake: {
          hostNames: ["nexus"],
        },
      },
    });

    assert.equal(handled.response.success, false);
    assert.ok(firstResponseText(handled.response)?.includes("Unknown HAL tool"));
  });
});

describe("openCodexThread", () => {
  it("falls back to thread/start when resume fails recoverably", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const started = makeThreadOpenResponse("fresh-thread");
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
      requestRaw: <M extends "thread/start" | "thread/resume">(method: M, payload: unknown) => {
        calls.push({ method, payload });
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "thread not found",
            }),
          );
        }
        return Effect.succeed(started);
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }),
    );

    assert.equal(opened.thread.id, "fresh-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/start"],
    );
    assert.deepStrictEqual(dynamicToolNames(calls[0]?.payload), [
      "hal_open_host_deploy_dialog",
      "hal_open_fleet_rollout",
    ]);
    assert.deepStrictEqual(dynamicToolNames(calls[1]?.payload), [
      "hal_open_host_deploy_dialog",
      "hal_open_fleet_rollout",
    ]);
  });

  it("retries thread resume without dynamic tools when the server rejects the field", async () => {
    const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
    const resumed = makeThreadOpenResponse("resumed-thread");
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        calls.push({ method, payload });
        return Effect.succeed(resumed as CodexRpc.ClientRequestResponsesByMethod[M]);
      },
      requestRaw: <M extends "thread/start" | "thread/resume">(method: M, payload: unknown) => {
        calls.push({ method, payload });
        if (method === "thread/resume" && calls.length === 1) {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32602,
              errorMessage: "unknown field `dynamicTools`",
            }),
          );
        }
        return Effect.succeed(resumed);
      },
    };

    const opened = await Effect.runPromise(
      openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "resume-thread",
      }),
    );

    assert.equal(opened.thread.id, "resumed-thread");
    assert.deepStrictEqual(
      calls.map((call) => call.method),
      ["thread/resume", "thread/resume"],
    );
    assert.deepStrictEqual(dynamicToolNames(calls[0]?.payload), [
      "hal_open_host_deploy_dialog",
      "hal_open_fleet_rollout",
    ]);
    assert.deepStrictEqual(dynamicToolNames(calls[1]?.payload), []);
  });

  it("propagates non-recoverable resume failures", async () => {
    const client = {
      request: <M extends "thread/start" | "thread/resume">(
        method: M,
        _payload: CodexRpc.ClientRequestParamsByMethod[M],
      ) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(
          makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
        );
      },
      requestRaw: <M extends "thread/start" | "thread/resume">(method: M, _payload: unknown) => {
        if (method === "thread/resume") {
          return Effect.fail(
            new CodexErrors.CodexAppServerRequestError({
              code: -32603,
              errorMessage: "timed out waiting for server",
            }),
          );
        }
        return Effect.succeed(makeThreadOpenResponse("fresh-thread"));
      },
    };

    await assert.rejects(
      Effect.runPromise(
        openCodexThread({
          client,
          threadId: ThreadId.make("thread-1"),
          runtimeMode: "full-access",
          cwd: "/tmp/project",
          requestedModel: "gpt-5.3-codex",
          serviceTier: undefined,
          resumeThreadId: "stale-thread",
        }),
      ),
      (error: unknown) =>
        Schema.is(CodexErrors.CodexAppServerRequestError)(error) &&
        error.errorMessage === "timed out waiting for server",
    );
  });
});
