import * as OS from "node:os";
import { Effect, FileSystem, Layer, Path } from "effect";

import {
  WorkspacePaths,
  WorkspacePathOutsideRootError,
  WorkspaceRootCreateFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
  type WorkspacePathsShape,
} from "../Services/WorkspacePaths.ts";

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function expandHomePath(input: string, path: Path.Path): string {
  if (input === "~") {
    return OS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(OS.homedir(), input.slice(2));
  }
  return input;
}

export const makeWorkspacePaths = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const toWorkspaceRelativePath = (workspaceRoot: string, absolutePath: string): string | null => {
    const relativeToRoot = toPosixRelativePath(path.relative(workspaceRoot, absolutePath));
    if (
      relativeToRoot.length === 0 ||
      relativeToRoot === "." ||
      relativeToRoot.startsWith("../") ||
      relativeToRoot === ".." ||
      path.isAbsolute(relativeToRoot)
    ) {
      return null;
    }
    return relativeToRoot;
  };

  const normalizeWorkspaceRoot: WorkspacePathsShape["normalizeWorkspaceRoot"] = Effect.fn(
    "WorkspacePaths.normalizeWorkspaceRoot",
  )(function* (workspaceRoot, options) {
    const normalizedWorkspaceRoot = path.resolve(expandHomePath(workspaceRoot.trim(), path));
    let workspaceStat = yield* fileSystem
      .stat(normalizedWorkspaceRoot)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!workspaceStat && options?.createIfMissing) {
      yield* fileSystem.makeDirectory(normalizedWorkspaceRoot, { recursive: true }).pipe(
        Effect.mapError(
          () =>
            new WorkspaceRootCreateFailedError({
              workspaceRoot,
              normalizedWorkspaceRoot,
            }),
        ),
      );
      workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
    }
    if (!workspaceStat) {
      return yield* new WorkspaceRootNotExistsError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    if (workspaceStat.type !== "Directory") {
      return yield* new WorkspaceRootNotDirectoryError({
        workspaceRoot,
        normalizedWorkspaceRoot,
      });
    }
    return normalizedWorkspaceRoot;
  });

  const resolveRelativePathWithinRoot: WorkspacePathsShape["resolveRelativePathWithinRoot"] =
    Effect.fn("WorkspacePaths.resolveRelativePathWithinRoot")(function* (input) {
      const normalizedInputPath = input.relativePath.trim();
      if (path.isAbsolute(normalizedInputPath)) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      const absolutePath = path.resolve(input.workspaceRoot, normalizedInputPath);
      const relativeToRoot = toWorkspaceRelativePath(input.workspaceRoot, absolutePath);
      if (relativeToRoot === null) {
        return yield* new WorkspacePathOutsideRootError({
          workspaceRoot: input.workspaceRoot,
          relativePath: input.relativePath,
        });
      }

      return {
        absolutePath,
        relativePath: relativeToRoot,
      };
    });

  const resolvePathWithinRoot: WorkspacePathsShape["resolvePathWithinRoot"] = Effect.fn(
    "WorkspacePaths.resolvePathWithinRoot",
  )(function* (input) {
    const normalizedInputPath = input.path.trim();
    if (!path.isAbsolute(normalizedInputPath)) {
      return yield* resolveRelativePathWithinRoot({
        workspaceRoot: input.workspaceRoot,
        relativePath: normalizedInputPath,
      });
    }

    const candidateRoots = [
      input.workspaceRoot,
      ...(input.additionalRoots ?? []).map((root) => root.trim()).filter((root) => root.length > 0),
    ];
    for (const candidateRoot of candidateRoots) {
      const relativeToCandidate = toWorkspaceRelativePath(candidateRoot, normalizedInputPath);
      if (relativeToCandidate === null) {
        continue;
      }

      return yield* resolveRelativePathWithinRoot({
        workspaceRoot: input.workspaceRoot,
        relativePath: relativeToCandidate,
      });
    }

    return yield* new WorkspacePathOutsideRootError({
      workspaceRoot: input.workspaceRoot,
      relativePath: input.path,
    });
  });

  return {
    normalizeWorkspaceRoot,
    resolveRelativePathWithinRoot,
    resolvePathWithinRoot,
  } satisfies WorkspacePathsShape;
});

export const WorkspacePathsLive = Layer.effect(WorkspacePaths, makeWorkspacePaths);
