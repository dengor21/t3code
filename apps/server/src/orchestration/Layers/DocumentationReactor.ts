import { Effect, FileSystem, Layer, Stream, Cause } from "effect";
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

import { checkpointRefForThreadTurn, resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { CheckpointStore } from "../../checkpointing/Services/CheckpointStore.ts";
import { TextGeneration } from "../../git/Services/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import {
  DocumentationReactor,
  type DocumentationReactorShape,
} from "../Services/DocumentationReactor.ts";
import { FlakeMetadataResolver } from "../../project/Services/FlakeMetadataResolver.ts";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const GENERAL_DOC_PATH = ".t3code/changes.md";
const HOST_DOCS_DIR = ".t3code/hosts";

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

function renderChangedFileList(files: ReadonlyArray<OrchestrationCheckpointFile>): string {
  const visible = files.slice(0, 8).map((file) => `\`${file.path}\``);
  const remainder = files.length - visible.length;
  return remainder > 0 ? `${visible.join(", ")}, +${remainder.toString()} more` : visible.join(", ");
}

function normalizeHosts(hosts: ReadonlyArray<FlakeHost>): ReadonlyArray<FlakeHost> {
  const seen = new Set<string>();
  return hosts.filter((host) => {
    const key = host.name.trim().toLowerCase();
    if (key.length === 0 || seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function resolveProjectHosts(
  metadata: { host?: FlakeHost | null; hosts?: ReadonlyArray<FlakeHost> } | null | undefined,
): ReadonlyArray<FlakeHost> {
  const normalizedMetadata = metadata ?? null;
  if (!normalizedMetadata) {
    return [];
  }
  const hosts = normalizedMetadata.hosts ?? [];
  if (hosts.length > 0) {
    return normalizeHosts(hosts);
  }
  return normalizedMetadata.host ? normalizeHosts([normalizedMetadata.host]) : [];
}

function slugHostName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "host";
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function upsertTurnBlock(existingEntries: string, turnId: TurnId, block: string): string {
  const startMarker = `<!-- t3code:turn:${turnId}:start -->`;
  const endMarker = `<!-- t3code:turn:${turnId}:end -->`;
  const withoutExisting = existingEntries.replace(
    new RegExp(`${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}\\n*`, "g"),
    "",
  );
  const trimmedExisting = withoutExisting.trim();
  return trimmedExisting.length > 0 ? `${block}\n\n${trimmedExisting}\n` : `${block}\n`;
}

function extractEntries(existing: string): string {
  const splitToken = "\n## Entries\n";
  const splitIndex = existing.indexOf(splitToken);
  if (splitIndex >= 0) {
    return existing.slice(splitIndex + splitToken.length).trim();
  }
  return existing.trim();
}

function renderGeneralDoc(input: { entries: string }): string {
  return [
    "# T3code Change Log",
    "",
    "This file is maintained automatically by T3code.",
    "",
    "## Entries",
    input.entries.trim(),
    "",
  ].join("\n");
}

function renderHostDoc(input: { host: FlakeHost; entries: string }): string {
  return [
    `# Host: ${input.host.name}`,
    "",
    "This file is maintained automatically by T3code.",
    "",
    `- Target: \`${input.host.target}\``,
    ...(input.host.system ? [`- System: \`${input.host.system}\``] : []),
    ...(input.host.type ? [`- Type: \`${input.host.type}\``] : []),
    "",
    "## Entries",
    input.entries.trim(),
    "",
  ].join("\n");
}

function renderDocumentationBlock(input: {
  turnId: TurnId;
  completedAt: string;
  threadTitle: string;
  changedFiles: ReadonlyArray<OrchestrationCheckpointFile>;
  generated: {
    headline: string;
    summary: string;
    changes: ReadonlyArray<string>;
    hostImpact: string;
  };
  host?: FlakeHost | undefined;
}): string {
  const startMarker = `<!-- t3code:turn:${input.turnId}:start -->`;
  const endMarker = `<!-- t3code:turn:${input.turnId}:end -->`;
  const changeLines = input.generated.changes
    .slice(0, 6)
    .map((entry) => `- ${entry}`)
    .join("\n");

  return [
    startMarker,
    `### ${input.completedAt} - ${input.generated.headline}`,
    "",
    input.generated.summary,
    "",
    ...(changeLines.length > 0 ? [changeLines, ""] : []),
    ...(input.generated.hostImpact.length > 0 ? [`Host impact: ${input.generated.hostImpact}`, ""] : []),
    ...(input.host
      ? [`Host: \`${input.host.name}\` (\`${input.host.target}\`)`, ""]
      : []),
    `Thread: ${input.threadTitle}`,
    `Files: ${renderChangedFileList(input.changedFiles)}`,
    endMarker,
  ].join("\n");
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
    return yield* fileSystem.readFileString(resolved.absolutePath).pipe(Effect.orElseSucceed(() => ""));
  });

  const appendDocumentationActivity = (input: {
    threadId: ThreadId;
    turnId: TurnId;
    kind: "flake.documentation.updated" | "flake.documentation.failed";
    tone: "info" | "error";
    summary: string;
    payload: Record<string, unknown>;
    createdAt: string;
  }) =>
    orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: serverCommandId("flake-documentation-activity"),
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

  const resolveModelSelection = Effect.fn("resolveModelSelection")(function* (input: {
    projectDefaultModelSelection: ModelSelection | null;
  }) {
    if (input.projectDefaultModelSelection) {
      return input.projectDefaultModelSelection;
    }
    const settings = yield* serverSettings.getSettings;
    return settings.textGenerationModelSelection;
  });

  const updateDocumentationFiles = Effect.fn("updateDocumentationFiles")(function* (input: {
    docsRoot: string;
    turnId: TurnId;
    completedAt: string;
    threadTitle: string;
    changedFiles: ReadonlyArray<OrchestrationCheckpointFile>;
    generated: {
      headline: string;
      summary: string;
      changes: ReadonlyArray<string>;
      hostImpact: string;
    };
    hosts: ReadonlyArray<FlakeHost>;
  }) {
    const updatedPaths: string[] = [];

    const generalExisting = yield* readWorkspaceFile({
      cwd: input.docsRoot,
      relativePath: GENERAL_DOC_PATH,
    });
    const generalBlock = renderDocumentationBlock({
      turnId: input.turnId,
      completedAt: input.completedAt,
      threadTitle: input.threadTitle,
      changedFiles: input.changedFiles,
      generated: input.generated,
    });
    const generalEntries = upsertTurnBlock(extractEntries(generalExisting), input.turnId, generalBlock);
    yield* workspaceFileSystem.writeFile({
      cwd: input.docsRoot,
      relativePath: GENERAL_DOC_PATH,
      contents: renderGeneralDoc({ entries: generalEntries }),
    });
    updatedPaths.push(GENERAL_DOC_PATH);

    for (const host of input.hosts) {
      const relativePath = `${HOST_DOCS_DIR}/${slugHostName(host.name)}.md`;
      const existing = yield* readWorkspaceFile({
        cwd: input.docsRoot,
        relativePath,
      });
      const block = renderDocumentationBlock({
        turnId: input.turnId,
        completedAt: input.completedAt,
        threadTitle: input.threadTitle,
        changedFiles: input.changedFiles,
        generated: input.generated,
        host,
      });
      const entries = upsertTurnBlock(extractEntries(existing), input.turnId, block);
      yield* workspaceFileSystem.writeFile({
        cwd: input.docsRoot,
        relativePath,
        contents: renderHostDoc({ host, entries }),
      });
      updatedPaths.push(relativePath);
    }

    return updatedPaths as ReadonlyArray<string>;
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
    const updatedPaths = yield* updateDocumentationFiles({
      docsRoot: project.workspaceRoot,
      turnId: event.payload.turnId,
      completedAt: event.payload.completedAt,
      threadTitle: thread.title,
      changedFiles: event.payload.files,
      generated,
      hosts,
    });

    yield* appendDocumentationActivity({
      threadId: thread.id,
      turnId: event.payload.turnId,
      kind: "flake.documentation.updated",
      tone: "info",
      summary: "Living documentation updated",
      payload: {
        updatedPaths,
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
        return appendDocumentationActivity({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          kind: "flake.documentation.failed",
          tone: "error",
          summary: "Living documentation update failed",
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
