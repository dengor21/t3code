import { Effect, Layer, Option, Ref, Schema } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CursorModelSelection } from "@t3tools/contracts";
import { sanitizeBranchFragment, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { TextGenerationError } from "@t3tools/contracts";
import {
  type ChangeDocumentationGenerationResult,
  type HostDocumentationGenerationResult,
  type ThreadTitleGenerationResult,
  type TextGenerationShape,
  TextGeneration,
} from "../Services/TextGeneration.ts";
import {
  buildBranchNamePrompt,
  buildChangeDocumentationPrompt,
  buildCommitMessagePrompt,
  buildHostDocumentationPrompt,
  buildInitialDocumentationPrompt,
  buildPrContentPrompt,
  buildThreadTitlePrompt,
} from "../Prompts.ts";
import {
  extractJsonObject,
  sanitizeCommitSubject,
  sanitizePrTitle,
  sanitizeThreadTitle,
} from "../Utils.ts";
import {
  applyCursorAcpModelSelection,
  makeCursorAcpRuntime,
} from "../../provider/acp/CursorAcpSupport.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

const CURSOR_TIMEOUT_MS = 180_000;

function mapCursorAcpError(
  operation:
    | "generateCommitMessage"
    | "generatePrContent"
    | "generateBranchName"
    | "generateThreadTitle"
    | "generateChangeDocumentation"
    | "generateInitialDocumentation"
    | "generateHostDocumentation",
  detail: string,
  cause: unknown,
): TextGenerationError {
  return new TextGenerationError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function isTextGenerationError(error: unknown): error is TextGenerationError {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "TextGenerationError"
  );
}

const makeCursorTextGeneration = Effect.gen(function* () {
  const commandSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverSettingsService = yield* Effect.service(ServerSettingsService);

  const runCursorJson = <S extends Schema.Top>({
    operation,
    cwd,
    prompt,
    outputSchemaJson,
    modelSelection,
  }: {
    operation:
      | "generateCommitMessage"
      | "generatePrContent"
      | "generateBranchName"
      | "generateThreadTitle"
      | "generateChangeDocumentation"
      | "generateInitialDocumentation"
      | "generateHostDocumentation";
    cwd: string;
    prompt: string;
    outputSchemaJson: S;
    modelSelection: CursorModelSelection;
  }): Effect.Effect<S["Type"], TextGenerationError, S["DecodingServices"]> =>
    Effect.gen(function* () {
      const cursorSettings = yield* Effect.map(
        serverSettingsService.getSettings,
        (settings) => settings.providers.cursor,
      ).pipe(Effect.catch(() => Effect.undefined));

      const outputRef = yield* Ref.make("");
      const runtime = yield* makeCursorAcpRuntime({
        cursorSettings,
        childProcessSpawner: commandSpawner,
        cwd,
        clientInfo: { name: "t3-code-git-text", version: "0.0.0" },
      });

      yield* runtime.handleSessionUpdate((notification) => {
        const update = notification.update;
        if (update.sessionUpdate !== "agent_message_chunk") {
          return Effect.void;
        }
        const content = update.content;
        if (content.type !== "text") {
          return Effect.void;
        }
        return Ref.update(outputRef, (current) => current + content.text);
      });

      const promptResult = yield* Effect.gen(function* () {
        yield* runtime.start();
        yield* Effect.ignore(runtime.setMode("ask"));
        yield* applyCursorAcpModelSelection({
          runtime,
          model: modelSelection.model,
          modelOptions: modelSelection.options,
          mapError: ({ cause, configId, step }) =>
            mapCursorAcpError(
              operation,
              step === "set-config-option"
                ? `Failed to set Cursor ACP config option "${configId}" for text generation.`
                : "Failed to set Cursor ACP base model for text generation.",
              cause,
            ),
        });

        return yield* runtime.prompt({
          prompt: [{ type: "text", text: prompt }],
        });
      }).pipe(
        Effect.timeoutOption(CURSOR_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new TextGenerationError({
                  operation,
                  detail: "Cursor Agent request timed out.",
                }),
              ),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : mapCursorAcpError(operation, "Cursor ACP request failed.", cause),
        ),
      );

      const rawResult = (yield* Ref.get(outputRef)).trim();
      if (!rawResult) {
        return yield* new TextGenerationError({
          operation,
          detail:
            promptResult.stopReason === "cancelled"
              ? "Cursor ACP request was cancelled."
              : "Cursor Agent returned empty output.",
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(outputSchemaJson))(
        extractJsonObject(rawResult),
      ).pipe(
        Effect.catchTag("SchemaError", (cause) =>
          Effect.fail(
            new TextGenerationError({
              operation,
              detail: "Cursor Agent returned invalid structured output.",
              cause,
            }),
          ),
        ),
      );
    }).pipe(
      Effect.mapError((cause) =>
        isTextGenerationError(cause)
          ? cause
          : mapCursorAcpError(operation, "Cursor ACP text generation failed.", cause),
      ),
      Effect.scoped,
    );

  const generateCommitMessage: TextGenerationShape["generateCommitMessage"] = Effect.fn(
    "CursorTextGeneration.generateCommitMessage",
  )(function* (input) {
    const { prompt, outputSchema } = buildCommitMessagePrompt({
      branch: input.branch,
      stagedSummary: input.stagedSummary,
      stagedPatch: input.stagedPatch,
      includeBranch: input.includeBranch === true,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateCommitMessage",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      subject: sanitizeCommitSubject(generated.subject),
      body: generated.body.trim(),
      ...("branch" in generated && typeof generated.branch === "string"
        ? { branch: sanitizeFeatureBranchName(generated.branch) }
        : {}),
    };
  });

  const generatePrContent: TextGenerationShape["generatePrContent"] = Effect.fn(
    "CursorTextGeneration.generatePrContent",
  )(function* (input) {
    const { prompt, outputSchema } = buildPrContentPrompt({
      baseBranch: input.baseBranch,
      headBranch: input.headBranch,
      commitSummary: input.commitSummary,
      diffSummary: input.diffSummary,
      diffPatch: input.diffPatch,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generatePrContent",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generatePrContent",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizePrTitle(generated.title),
      body: generated.body.trim(),
    };
  });

  const generateBranchName: TextGenerationShape["generateBranchName"] = Effect.fn(
    "CursorTextGeneration.generateBranchName",
  )(function* (input) {
    const { prompt, outputSchema } = buildBranchNamePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateBranchName",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateBranchName",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      branch: sanitizeBranchFragment(generated.branch),
    };
  });

  const generateThreadTitle: TextGenerationShape["generateThreadTitle"] = Effect.fn(
    "CursorTextGeneration.generateThreadTitle",
  )(function* (input) {
    const { prompt, outputSchema } = buildThreadTitlePrompt({
      message: input.message,
      attachments: input.attachments,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateThreadTitle",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      title: sanitizeThreadTitle(generated.title),
    } satisfies ThreadTitleGenerationResult;
  });

  const generateChangeDocumentation: TextGenerationShape["generateChangeDocumentation"] = Effect.fn(
    "CursorTextGeneration.generateChangeDocumentation",
  )(function* (input) {
    const { prompt, outputSchema } = buildChangeDocumentationPrompt({
      projectTitle: input.projectTitle,
      threadTitle: input.threadTitle,
      assistantResponse: input.assistantResponse,
      changedFilesSummary: input.changedFilesSummary,
      diffPatch: input.diffPatch,
      hosts: input.hosts,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateChangeDocumentation",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateChangeDocumentation",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    return {
      headline: generated.headline.trim(),
      summary: generated.summary.trim(),
      changes: generated.changes.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
      hostImpact: generated.hostImpact.trim(),
    } satisfies ChangeDocumentationGenerationResult;
  });

  const generateInitialDocumentation: TextGenerationShape["generateInitialDocumentation"] =
    Effect.fn("CursorTextGeneration.generateInitialDocumentation")(function* (input) {
      const { prompt, outputSchema } = buildInitialDocumentationPrompt({
        projectTitle: input.projectTitle,
        summaryLabel: input.summaryLabel,
        currentFilesSummary: input.currentFilesSummary,
        currentStateSnapshot: input.currentStateSnapshot,
        hosts: input.hosts,
      });

      if (input.modelSelection.provider !== "cursor") {
        return yield* new TextGenerationError({
          operation: "generateInitialDocumentation",
          detail: "Invalid model selection.",
        });
      }

      const generated = yield* runCursorJson({
        operation: "generateInitialDocumentation",
        cwd: input.cwd,
        prompt,
        outputSchemaJson: outputSchema,
        modelSelection: input.modelSelection,
      });

      return {
        headline: generated.headline.trim(),
        summary: generated.summary.trim(),
        changes: generated.changes.map((entry) => entry.trim()).filter((entry) => entry.length > 0),
        hostImpact: generated.hostImpact.trim(),
      } satisfies ChangeDocumentationGenerationResult;
    });

  const generateHostDocumentation: TextGenerationShape["generateHostDocumentation"] = Effect.fn(
    "CursorTextGeneration.generateHostDocumentation",
  )(function* (input) {
    const { prompt, outputSchema } = buildHostDocumentationPrompt({
      projectTitle: input.projectTitle,
      host: input.host,
      contextFiles: input.contextFiles,
    });

    if (input.modelSelection.provider !== "cursor") {
      return yield* new TextGenerationError({
        operation: "generateHostDocumentation",
        detail: "Invalid model selection.",
      });
    }

    const generated = yield* runCursorJson({
      operation: "generateHostDocumentation",
      cwd: input.cwd,
      prompt,
      outputSchemaJson: outputSchema,
      modelSelection: input.modelSelection,
    });

    const normalizeList = (value: ReadonlyArray<string>) =>
      value.map((entry) => entry.trim()).filter((entry) => entry.length > 0);

    return {
      overview: generated.overview.trim(),
      rolesAndPurpose: normalizeList(generated.rolesAndPurpose),
      appsAndUserEnvironment: normalizeList(generated.appsAndUserEnvironment),
      servicesAndSystemBehavior: normalizeList(generated.servicesAndSystemBehavior),
      networkingAndAccess: normalizeList(generated.networkingAndAccess),
      storageAndHardware: normalizeList(generated.storageAndHardware),
      deploymentAndOperations: normalizeList(generated.deploymentAndOperations),
      knownGaps: normalizeList(generated.knownGaps),
    } satisfies HostDocumentationGenerationResult;
  });

  return {
    generateCommitMessage,
    generatePrContent,
    generateBranchName,
    generateThreadTitle,
    generateChangeDocumentation,
    generateInitialDocumentation,
    generateHostDocumentation,
  } satisfies TextGenerationShape;
});

export const CursorTextGenerationLive = Layer.effect(TextGeneration, makeCursorTextGeneration);
