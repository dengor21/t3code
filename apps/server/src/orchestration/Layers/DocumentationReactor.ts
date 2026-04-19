import { Cause, Effect, FileSystem, Layer, Stream } from "effect";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  CommandId,
  EventId,
  type FlakeHost,
  type ModelSelection,
  type OrchestrationCheckpointFile,
  type OrchestrationEvent,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { FlakeMetadataResolver } from "../../project/Services/FlakeMetadataResolver.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import {
  GENERAL_CHANGELOG_PATH,
  inferHostsFromPaths,
  renderInlineCodeList,
  resolveProjectHosts,
} from "../DocumentationUtils.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  DocumentationReactor,
  type DocumentationReactorShape,
} from "../Services/DocumentationReactor.ts";

const serverCommandId = (tag: string): CommandId =>
  CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

function isDocumentationOnlyChange(files: ReadonlyArray<OrchestrationCheckpointFile>): boolean {
  return (
    files.length > 0 &&
    files.every((file) => file.path === ".t3code" || file.path.startsWith(".t3code/"))
  );
}

function summarizeChangedFiles(files: ReadonlyArray<OrchestrationCheckpointFile>): string {
  return files
    .map(
      (file) =>
        `${file.kind} ${file.path} (+${file.additions.toString()}, -${file.deletions.toString()})`,
    )
    .join("\n");
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractEntries(existing: string): string {
  const splitToken = "\n## Entries\n";
  const splitIndex = existing.indexOf(splitToken);
  if (splitIndex >= 0) {
    return existing.slice(splitIndex + splitToken.length).trim();
  }
  return existing.trim();
}

function upsertEntryBlock(existingEntries: string, entryKey: string, block: string): string {
  const startMarker = `<!-- t3code:turn:${entryKey}:start -->`;
  const endMarker = `<!-- t3code:turn:${entryKey}:end -->`;
  const withoutExisting = existingEntries.replace(
    new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n*`, "g"),
    "",
  );
  const trimmedExisting = withoutExisting.trim();
  return trimmedExisting.length > 0 ? `${block}\n\n${trimmedExisting}\n` : `${block}\n`;
}

function renderGeneralDoc(entries: string): string {
  return [
    "# T3code Change Log",
    "",
    "This file is maintained automatically by T3code.",
    "",
    "## Entries",
    entries.trim(),
    "",
  ].join("\n");
}

function renderDocumentationBlock(input: {
  entryKey: string;
  completedAt: string;
  referenceLabel: string;
  filesLabel: string;
  generated: {
    headline: string;
    summary: string;
    changes: ReadonlyArray<string>;
    hostImpact: string;
  };
  hosts: ReadonlyArray<string>;
  ambiguous: boolean;
}): string {
  const startMarker = `<!-- t3code:turn:${input.entryKey}:start -->`;
  const endMarker = `<!-- t3code:turn:${input.entryKey}:end -->`;
  const metadataComment = `<!-- t3code:meta ${JSON.stringify({
    kind: "change",
    completedAt: input.completedAt,
    hosts: input.hosts,
    ambiguous: input.ambiguous,
  })} -->`;
  const changeLines = input.generated.changes
    .slice(0, 6)
    .map((entry) => `- ${entry}`)
    .join("\n");

  return [
    startMarker,
    metadataComment,
    `### ${input.completedAt} - ${input.generated.headline}`,
    "",
    input.generated.summary,
    "",
    ...(changeLines.length > 0 ? [changeLines, ""] : []),
    ...(input.generated.hostImpact.length > 0
      ? [`Host impact: ${input.generated.hostImpact}`, ""]
      : []),
    input.referenceLabel,
    `Files: ${input.filesLabel}`,
    endMarker,
  ].join("\n");
}

function resolveImpactedHosts(input: {
  hosts: ReadonlyArray<FlakeHost>;
  changedFiles: ReadonlyArray<OrchestrationCheckpointFile>;
  scopedHostName: string | null;
}): {
  hosts: ReadonlyArray<string>;
  ambiguous: boolean;
} {
  if (input.scopedHostName?.trim()) {
    return {
      hosts: [input.scopedHostName.trim()],
      ambiguous: false,
    };
  }
  const inferredHosts = inferHostsFromPaths({
    hosts: input.hosts,
    paths: input.changedFiles.map((file) => file.path),
  });
  if (inferredHosts.length > 0) {
    return {
      hosts: inferredHosts,
      ambiguous: false,
    };
  }
  return {
    hosts: [],
    ambiguous: input.hosts.length > 0,
  };
}

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const checkpointStore = yield* CheckpointStore;
  const textGeneration = yield* TextGeneration;
  const flakeMetadataResolver = yield* FlakeMetadataResolver;
  const workspaceFileSystem = yield* WorkspaceFileSystem;
  const workspacePaths = yield* WorkspacePaths;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverSettings = yield* ServerSettingsService;

  const readWorkspaceFile = Effect.fn("readWorkspaceFile")(function* (input: {
    cwd: string;
    relativePath: string;
  }) {
    const resolved = yield* workspacePaths.resolveRelativePathWithinRoot({
      workspaceRoot: input.cwd,
      relativePath: input.relativePath,
    });
    return yield* fileSystem
      .readFileString(resolved.absolutePath)
      .pipe(Effect.orElseSucceed(() => ""));
  });

  const appendChangelogActivity = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    kind: "flake.changelog.updated" | "flake.changelog.failed";
    tone: "info" | "error";
    summary: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("flake-changelog-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(crypto.randomUUID()),
        tone: input.tone,
        kind: input.kind,
        summary: input.summary,
        payload: input.payload,
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });

  const resolveModelSelection = Effect.fn("resolveChangeLogModelSelection")(function* (input: {
    projectDefaultModelSelection: ModelSelection | null;
  }) {
    if (input.projectDefaultModelSelection) {
      return input.projectDefaultModelSelection;
    }
    const settings = yield* serverSettings.getSettings;
    return settings.textGenerationModelSelection;
  });

  const processDocumentationEvent = Effect.fn("processDocumentationEvent")(function* (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) {
    if (event.payload.status !== "ready" || event.payload.files.length === 0) {
      return;
    }
    if (isDocumentationOnlyChange(event.payload.files)) {
      return;
    }

    const readModel = yield* orchestrationEngine.getReadModel();
    const thread = readModel.threads.find((entry) => entry.id === event.payload.threadId);
    if (!thread) {
      return;
    }
    const project = readModel.projects.find((entry) => entry.id === thread.projectId);
    if (!project) {
      return;
    }

    const diffCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: readModel.projects,
    });
    if (!diffCwd) {
      return;
    }

    const previousCheckpointRef = checkpointRefForThreadTurn(
      event.payload.threadId,
      Math.max(0, event.payload.checkpointTurnCount - 1),
    );
    const diffPatch = yield* checkpointStore
      .diffCheckpoints({
        cwd: diffCwd,
        fromCheckpointRef: previousCheckpointRef,
        toCheckpointRef: event.payload.checkpointRef,
        fallbackFromToHead: false,
      })
      .pipe(Effect.catch(() => Effect.succeed("")));

    const assistantResponse =
      (event.payload.assistantMessageId
        ? thread.messages.find((message) => message.id === event.payload.assistantMessageId)?.text
        : undefined) ??
      thread.messages
        .toReversed()
        .find((message) => message.role === "assistant" && message.turnId === event.payload.turnId)
        ?.text ??
      "";

    const flakeMetadata = yield* flakeMetadataResolver.resolve(project.workspaceRoot);
    const hosts = resolveProjectHosts(flakeMetadata);
    const impactedHosts = resolveImpactedHosts({
      hosts,
      changedFiles: event.payload.files,
      scopedHostName: thread.scopedHostName ?? null,
    });
    const modelSelection = yield* resolveModelSelection({
      projectDefaultModelSelection: project.defaultModelSelection,
    });
    const generated = yield* textGeneration.generateChangeDocumentation({
      cwd: diffCwd,
      projectTitle: project.title,
      threadTitle: thread.title,
      assistantResponse,
      changedFilesSummary: summarizeChangedFiles(event.payload.files),
      diffPatch,
      hosts,
      modelSelection,
    });

    const existingDoc = yield* readWorkspaceFile({
      cwd: project.workspaceRoot,
      relativePath: GENERAL_CHANGELOG_PATH,
    });
    const block = renderDocumentationBlock({
      entryKey: event.payload.turnId,
      completedAt: event.payload.completedAt,
      referenceLabel: `Thread: ${thread.title}`,
      filesLabel: renderInlineCodeList(event.payload.files.map((file) => file.path)),
      generated,
      hosts: impactedHosts.hosts,
      ambiguous: impactedHosts.ambiguous,
    });
    const nextEntries = upsertEntryBlock(extractEntries(existingDoc), event.payload.turnId, block);
    yield* workspaceFileSystem.writeFile({
      cwd: project.workspaceRoot,
      relativePath: GENERAL_CHANGELOG_PATH,
      contents: renderGeneralDoc(nextEntries),
    });
    yield* orchestrationEngine.dispatch({
      type: "project.meta.update",
      commandId: serverCommandId("flake-changelog-project-refresh"),
      projectId: project.id,
    });

    yield* appendChangelogActivity({
      threadId: thread.id,
      turnId: event.payload.turnId,
      kind: "flake.changelog.updated",
      tone: "info",
      summary: "Change log updated",
      payload: {
        updatedPaths: [GENERAL_CHANGELOG_PATH],
        hosts: impactedHosts.hosts,
        ambiguous: impactedHosts.ambiguous,
      },
      createdAt: event.payload.completedAt,
    });
  });

  const processEventSafely = (
    event: Extract<OrchestrationEvent, { type: "thread.turn-diff-completed" }>,
  ) =>
    processDocumentationEvent(event).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        const detail = Cause.pretty(cause);
        return appendChangelogActivity({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          kind: "flake.changelog.failed",
          tone: "error",
          summary: "Change log update failed",
          payload: {
            detail,
          },
          createdAt: new Date().toISOString(),
        }).pipe(
          Effect.catch(() => Effect.void),
          Effect.flatMap(() =>
            Effect.logWarning("documentation reactor failed to process input", {
              eventType: event.type,
              threadId: event.payload.threadId,
              turnId: event.payload.turnId,
              cause: detail,
            }),
          ),
        );
      }),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const start: DocumentationReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (event.type !== "thread.turn-diff-completed") {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies DocumentationReactorShape;
});

export const DocumentationReactorLive = Layer.effect(DocumentationReactor, make);
