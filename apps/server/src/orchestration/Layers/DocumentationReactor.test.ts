import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type FlakeMetadata,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkpointRefForThreadTurn } from "../../checkpointing/Utils.ts";
import { CheckpointStoreLive } from "../../checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { ServerConfig } from "../../config.ts";
import { GitCoreLive } from "../../git/Layers/GitCore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { FlakeMetadataResolver } from "../../project/Services/FlakeMetadataResolver.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { DocumentationReactorLive } from "./DocumentationReactor.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { DocumentationReactor } from "../Services/DocumentationReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceEntriesLive } from "../../workspace/Layers/WorkspaceEntries.ts";
import { WorkspaceFileSystemLive } from "../../workspace/Layers/WorkspaceFileSystem.ts";
import { WorkspacePathsLive } from "../../workspace/Layers/WorkspacePaths.ts";

const asProjectId = (value: string): ProjectId => ProjectId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function createGitRepository() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "t3-documentation-reactor-"));
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "flake.nix"), "{ description = \"test\"; }\n", "utf8");
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
  return cwd;
}

async function waitForThreadActivity(
  engine: OrchestrationEngineShape,
  kind: string,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    const readModel = await Effect.runPromise(engine.getReadModel());
    const thread = readModel.threads.find((entry) => entry.id === ThreadId.make("thread-1"));
    if (thread?.activities.some((activity) => activity.kind === kind)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for thread activity '${kind}'.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return poll();
  };
  return poll();
}

describe("DocumentationReactor", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    OrchestrationEngineService | DocumentationReactor | CheckpointStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  afterEach(async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    scope = null;
    if (runtime) {
      await runtime.dispose();
    }
    runtime = null;
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  async function createHarness(options?: {
    flakeMetadata?: FlakeMetadata | null;
    textGenerationResult?: {
      headline: string;
      summary: string;
      changes: ReadonlyArray<string>;
      hostImpact: string;
    };
  }) {
    const cwd = createGitRepository();
    tempDirs.push(cwd);

    const generateChangeDocumentation = vi.fn(() =>
      Effect.succeed(
        options?.textGenerationResult ?? {
          headline: "Materialize flake host updates",
          summary: "Documented the latest flake changes.",
          changes: ["Updated host configuration", "Captured the new deployment intent"],
          hostImpact: "Applies to the flake host inventory.",
        },
      ),
    );

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolverLive),
      Layer.provide(SqlitePersistenceMemory),
    );
    const workspaceEntriesLayer = WorkspaceEntriesLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provideMerge(GitCoreLive),
    );
    const workspaceFileSystemLayer = WorkspaceFileSystemLive.pipe(
      Layer.provide(WorkspacePathsLive),
      Layer.provide(workspaceEntriesLayer),
    );
    const layer = DocumentationReactorLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(CheckpointStoreLive),
      Layer.provideMerge(
        Layer.succeed(FlakeMetadataResolver, {
          resolve: () =>
            Effect.succeed(
              options?.flakeMetadata ??
                ({
                  source: "parsed-flake",
                  flakePath: path.join(cwd, "flake.nix"),
                  host: null,
                  hosts: [
                    {
                      name: "nexus",
                      target: "10.0.0.115",
                      system: "aarch64-linux",
                      type: "nixos",
                    },
                  ],
                  diagnostics: [],
                } satisfies FlakeMetadata),
            ),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(TextGeneration, {
          generateCommitMessage: () => Effect.die("unused in test"),
          generatePrContent: () => Effect.die("unused in test"),
          generateBranchName: () => Effect.die("unused in test"),
          generateThreadTitle: () => Effect.die("unused in test"),
          generateChangeDocumentation,
        }),
      ),
      Layer.provideMerge(workspaceFileSystemLayer),
      Layer.provideMerge(workspaceEntriesLayer),
      Layer.provideMerge(WorkspacePathsLive),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(GitCoreLive),
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-doc-reactor-test-" })),
      Layer.provide(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const reactor = await runtime.runPromise(Effect.service(DocumentationReactor));
    const checkpointStore = await runtime.runPromise(Effect.service(CheckpointStore));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(reactor.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(reactor.drain);

    const createdAt = new Date().toISOString();
    await Effect.runPromise(
      engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("cmd-project-create"),
        projectId: asProjectId("project-1"),
        title: "nix",
        workspaceRoot: cwd,
        defaultModelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        createdAt,
      }),
    );
    await Effect.runPromise(
      engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-1"),
        title: "Update system deployment",
        modelSelection: {
          provider: "codex",
          model: "gpt-5.4",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: cwd,
        createdAt,
      }),
    );

    return {
      cwd,
      engine,
      reactor,
      checkpointStore,
      drain,
      generateChangeDocumentation,
    };
  }

  it("writes general and per-host docs for a completed turn", async () => {
    const harness = await createHarness();
    const turnId = asTurnId("turn-1");
    const messageId = MessageId.make("assistant-turn-1");
    const completedAt = new Date().toISOString();

    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-delta"),
        threadId: ThreadId.make("thread-1"),
        messageId,
        delta: "Implemented host deployment updates.",
        turnId,
        createdAt: completedAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("cmd-assistant-complete"),
        threadId: ThreadId.make("thread-1"),
        messageId,
        turnId,
        createdAt: completedAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        completedAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [
          {
            path: "README.md",
            kind: "modified",
            additions: 1,
            deletions: 1,
          },
        ],
        assistantMessageId: messageId,
        checkpointTurnCount: 1,
        createdAt: completedAt,
      }),
    );

    await waitForThreadActivity(harness.engine, "flake.documentation.updated");
    await harness.drain();

    const changeLog = fs.readFileSync(path.join(harness.cwd, ".t3code", "changes.md"), "utf8");
    const hostDoc = fs.readFileSync(path.join(harness.cwd, ".t3code", "hosts", "nexus.md"), "utf8");

    expect(changeLog).toContain("# T3code Change Log");
    expect(changeLog).toContain("Materialize flake host updates");
    expect(changeLog).toContain("README.md");
    expect(changeLog).toContain("<!-- t3code:turn:turn-1:start -->");
    expect(hostDoc).toContain("# Host: nexus");
    expect(hostDoc).toContain("10.0.0.115");
    expect(hostDoc).toContain("Host: `nexus` (`10.0.0.115`)");
    expect(harness.generateChangeDocumentation).toHaveBeenCalledTimes(1);
  });

  it("replaces an existing turn entry instead of duplicating it", async () => {
    const harness = await createHarness({
      textGenerationResult: {
        headline: "Refresh host docs",
        summary: "Rebuilt the documentation entry.",
        changes: ["Captured the replacement entry"],
        hostImpact: "",
      },
    });
    const turnId = asTurnId("turn-1");
    const messageId = MessageId.make("assistant-turn-1");
    const completedAt = new Date().toISOString();

    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
      }),
    );
    fs.writeFileSync(path.join(harness.cwd, "README.md"), "v2\n", "utf8");
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-delta-1"),
        threadId: ThreadId.make("thread-1"),
        messageId,
        delta: "First doc entry.",
        turnId,
        createdAt: completedAt,
      }),
    );
    for (const commandId of ["cmd-turn-diff-1", "cmd-turn-diff-2"]) {
      await Effect.runPromise(
        harness.engine.dispatch({
          type: "thread.turn.diff.complete",
          commandId: CommandId.make(commandId),
          threadId: ThreadId.make("thread-1"),
          turnId,
          completedAt,
          checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
          status: "ready",
          files: [
            {
              path: "README.md",
              kind: "modified",
              additions: 1,
              deletions: 1,
            },
          ],
          assistantMessageId: messageId,
          checkpointTurnCount: 1,
          createdAt: completedAt,
        }),
      );
    }

    await waitForThreadActivity(harness.engine, "flake.documentation.updated");
    await harness.drain();

    const changeLog = fs.readFileSync(path.join(harness.cwd, ".t3code", "changes.md"), "utf8");
    expect(changeLog.match(/<!-- t3code:turn:turn-1:start -->/g) ?? []).toHaveLength(1);
    expect(harness.generateChangeDocumentation).toHaveBeenCalledTimes(2);
  });

  it("skips documentation updates when only .t3code files changed", async () => {
    const harness = await createHarness();
    const completedAt = new Date().toISOString();

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-docs-only"),
        threadId: ThreadId.make("thread-1"),
        turnId: asTurnId("turn-2"),
        completedAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [
          {
            path: ".t3code/changes.md",
            kind: "modified",
            additions: 4,
            deletions: 1,
          },
        ],
        checkpointTurnCount: 2,
        createdAt: completedAt,
      }),
    );

    await harness.drain();

    expect(fs.existsSync(path.join(harness.cwd, ".t3code", "changes.md"))).toBe(false);
    expect(harness.generateChangeDocumentation).not.toHaveBeenCalled();
  });

  it("writes per-host docs only for hosts implicated by changed file paths", async () => {
    const harness = await createHarness({
      flakeMetadata: {
        source: "parsed-flake",
        flakePath: "flake.nix",
        host: null,
        hosts: [
          {
            name: "bc250",
            target: "bc250",
            system: "x86_64-linux",
            type: "nixos",
          },
          {
            name: "nexus",
            target: "10.0.0.115",
            system: "x86_64-linux",
            type: "nixos",
          },
        ],
        diagnostics: [],
      },
      textGenerationResult: {
        headline: "Add mpv video player on bc250",
        summary: "bc250 now installs mpv for local video playback.",
        changes: ["Added mpv to the bc250 host package set"],
        hostImpact: "Only bc250 is affected.",
      },
    });
    const turnId = asTurnId("turn-bc250");
    const messageId = MessageId.make("assistant-turn-bc250");
    const completedAt = new Date().toISOString();

    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 0),
      }),
    );
    fs.mkdirSync(path.join(harness.cwd, "hosts", "bc250"), { recursive: true });
    fs.writeFileSync(path.join(harness.cwd, "hosts", "bc250", "default.nix"), "{ }\n", "utf8");
    await runtime!.runPromise(
      harness.checkpointStore.captureCheckpoint({
        cwd: harness.cwd,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
      }),
    );

    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("cmd-assistant-delta-bc250"),
        threadId: ThreadId.make("thread-1"),
        messageId,
        delta: "Scoped the package change to bc250.",
        turnId,
        createdAt: completedAt,
      }),
    );
    await Effect.runPromise(
      harness.engine.dispatch({
        type: "thread.turn.diff.complete",
        commandId: CommandId.make("cmd-turn-diff-bc250"),
        threadId: ThreadId.make("thread-1"),
        turnId,
        completedAt,
        checkpointRef: checkpointRefForThreadTurn(ThreadId.make("thread-1"), 1),
        status: "ready",
        files: [
          {
            path: "hosts/bc250/default.nix",
            kind: "modified",
            additions: 1,
            deletions: 0,
          },
        ],
        assistantMessageId: messageId,
        checkpointTurnCount: 1,
        createdAt: completedAt,
      }),
    );

    await waitForThreadActivity(harness.engine, "flake.documentation.updated");
    await harness.drain();

    expect(fs.existsSync(path.join(harness.cwd, ".t3code", "hosts", "bc250.md"))).toBe(true);
    expect(fs.existsSync(path.join(harness.cwd, ".t3code", "hosts", "nexus.md"))).toBe(false);

    const bc250Doc = fs.readFileSync(path.join(harness.cwd, ".t3code", "hosts", "bc250.md"), "utf8");
    expect(bc250Doc).toContain("Add mpv video player on bc250");
    expect(bc250Doc).toContain("Host: `bc250` (`bc250`)");
  });
});
