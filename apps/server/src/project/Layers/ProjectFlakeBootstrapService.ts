import { stat } from "node:fs/promises";

import {
  CommandId,
  ProjectBootstrapFlakeError,
  type ProjectBootstrapFlakeInput,
} from "@t3tools/contracts";
import {
  buildFlakeRepoStyleDocument,
  buildMinimalFlakeNixContents,
  deriveFlakeOnboardingSkeletonPaths,
  FLAKE_FILE_RELATIVE_PATH,
  FLAKE_REPO_STYLE_RELATIVE_PATH,
  toFlakeOnboardingQuestionnaire,
} from "@t3tools/shared/flakeWorkflow";
import { Effect, Layer, Option } from "effect";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { WorkspaceFileSystem } from "../../workspace/Services/WorkspaceFileSystem.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import {
  ProjectFlakeBootstrapService,
  type ProjectFlakeBootstrapServiceShape,
} from "../Services/ProjectFlakeBootstrapService.ts";

function toBootstrapError(message: string, cause?: unknown): ProjectBootstrapFlakeError {
  return new ProjectBootstrapFlakeError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const workspacePaths = yield* WorkspacePaths;
  const workspaceFileSystem = yield* WorkspaceFileSystem;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const serverCommandId = (tag: string) => CommandId.make(`server:${tag}:${crypto.randomUUID()}`);

  const bootstrapFlake: ProjectFlakeBootstrapServiceShape["bootstrapFlake"] = Effect.fn(
    "ProjectFlakeBootstrapService.bootstrapFlake",
  )(function* (input: ProjectBootstrapFlakeInput) {
    const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
      Effect.mapError((cause) => toBootstrapError("Failed to load the selected project.", cause)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(toBootstrapError(`Project '${input.projectId}' was not found.`)),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    );

    const flakeTarget = yield* workspacePaths
      .resolveRelativePathWithinRoot({
        workspaceRoot: project.workspaceRoot,
        relativePath: FLAKE_FILE_RELATIVE_PATH,
      })
      .pipe(
        Effect.mapError((cause) =>
          toBootstrapError("Failed to resolve the target flake path.", cause),
        ),
      );

    const flakeAlreadyExists = yield* Effect.tryPromise({
      try: async () => {
        try {
          await stat(flakeTarget.absolutePath);
          return true;
        } catch (cause) {
          if (cause && typeof cause === "object" && "code" in cause && cause.code === "ENOENT") {
            return false;
          }
          throw cause;
        }
      },
      catch: (cause) =>
        toBootstrapError("Failed to check whether flake.nix already exists.", cause),
    });

    if (flakeAlreadyExists) {
      return yield* toBootstrapError("flake.nix already exists for this project.");
    }

    const questionnaire = toFlakeOnboardingQuestionnaire(input);
    const repoStyle = buildFlakeRepoStyleDocument({
      projectTitle: project.title,
      workspaceRoot: project.workspaceRoot,
      generatedAt: new Date().toISOString(),
      questionnaire,
    });

    yield* workspaceFileSystem
      .writeFile({
        cwd: project.workspaceRoot,
        relativePath: FLAKE_FILE_RELATIVE_PATH,
        contents: buildMinimalFlakeNixContents(),
      })
      .pipe(Effect.mapError((cause) => toBootstrapError("Failed to write flake.nix.", cause)));

    const createdSkeletonPaths = [...deriveFlakeOnboardingSkeletonPaths(questionnaire)];
    yield* Effect.forEach(createdSkeletonPaths, (relativePath) =>
      workspaceFileSystem
        .writeFile({
          cwd: project.workspaceRoot,
          relativePath: `${relativePath}/.gitkeep`,
          contents: "",
        })
        .pipe(
          Effect.mapError((cause) =>
            toBootstrapError(`Failed to create scaffold directory '${relativePath}'.`, cause),
          ),
        ),
    );

    yield* workspaceFileSystem
      .writeFile({
        cwd: project.workspaceRoot,
        relativePath: FLAKE_REPO_STYLE_RELATIVE_PATH,
        contents: `${JSON.stringify(repoStyle, null, 2)}\n`,
      })
      .pipe(
        Effect.mapError((cause) =>
          toBootstrapError("Failed to write .hal/repo-style.json.", cause),
        ),
      );

    yield* orchestrationEngine
      .dispatch({
        type: "project.meta.update",
        commandId: serverCommandId("project-bootstrap-flake-meta-update"),
        projectId: input.projectId,
      })
      .pipe(
        Effect.mapError((cause) =>
          toBootstrapError("Failed to refresh project metadata after flake bootstrap.", cause),
        ),
      );

    return {
      projectId: input.projectId,
      layoutPattern: repoStyle.layoutPattern,
      flakePath: FLAKE_FILE_RELATIVE_PATH,
      repoStylePath: FLAKE_REPO_STYLE_RELATIVE_PATH,
      createdSkeletonPaths,
    };
  });

  return {
    bootstrapFlake,
  } satisfies ProjectFlakeBootstrapServiceShape;
});

export const ProjectFlakeBootstrapServiceLive = Layer.effect(ProjectFlakeBootstrapService, make);
