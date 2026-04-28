import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";

import type {
  FlakeHost,
  HostSecretEntry,
  HostSecretInventory,
  ProjectSecretsSummary,
  SecretValidationCheck,
} from "@t3tools/contracts";
import { ProjectSecretsError } from "@t3tools/contracts";
import { Cache, Duration, Effect, Exit, Layer, Option } from "effect";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runProcess } from "../../processRunner.ts";
import { WorkspacePaths } from "../../workspace/Services/WorkspacePaths.ts";
import { FlakeMetadataResolver } from "../Services/FlakeMetadataResolver.ts";
import { decodeNixFlakeSourcePath, loadNixFlakeMetadataJson } from "../nixFlakeMetadata.ts";
import {
  ProjectSecretsService,
  type ProjectSecretsServiceShape,
} from "../Services/ProjectSecretsService.ts";

const DEFAULT_CACHE_CAPACITY = 256;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.seconds(10);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.seconds(5);
const DEFAULT_NIX_EVAL_TIMEOUT_MS = 30_000;
const DEFAULT_PROCESS_BUFFER_BYTES = 256 * 1024;

interface SupportedHostContext {
  readonly host: FlakeHost;
  readonly configAttrPrefix: string | null;
}

interface NixEvalOutcome {
  readonly status: "success" | "missing" | "error";
  readonly value: unknown | null;
  readonly detail: string | null;
}

interface SecretPathResolution {
  readonly evaluatedPath: string;
  readonly workspaceRelativePath: string | null;
  readonly absolutePath: string | null;
}

interface ResolvedHostInventory {
  readonly inventory: HostSecretInventory;
  readonly providerDetectedByEval: boolean;
}

interface CachedProjectSecretsSummary {
  readonly summary: ProjectSecretsSummary;
  readonly provider: ProjectSecretsSummary["provider"];
}

function trimToNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function toProjectSecretsError(message: string, cause?: unknown): ProjectSecretsError {
  return new ProjectSecretsError({
    message,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function normalizeHostType(host: FlakeHost): string | null {
  const explicit = trimToNull(host.type)?.toLowerCase();
  if (explicit) {
    return explicit;
  }
  const system = trimToNull(host.system)?.toLowerCase();
  if (system?.endsWith("-linux")) {
    return "nixos";
  }
  if (system?.endsWith("-darwin")) {
    return "darwin";
  }
  return null;
}

function resolveConfigAttrPrefix(host: FlakeHost): string | null {
  const normalizedType = normalizeHostType(host);
  switch (normalizedType) {
    case "nixos":
      return `.#nixosConfigurations.${host.name}`;
    case "darwin":
    case "nix-darwin":
      return `.#darwinConfigurations.${host.name}`;
    case "home-manager":
    case "home":
      return `.#homeConfigurations.${host.name}`;
    default:
      return null;
  }
}

function summarizeOutput(stdout: string, stderr: string): string | null {
  const parts = [stderr.trim(), stdout.trim()].filter((value) => value.length > 0);
  if (parts.length === 0) {
    return null;
  }
  return parts.join("\n\n");
}

function classifyMissingEval(detail: string): boolean {
  return /does not provide attribute|attribute ['"][^'"]+['"] missing|undefined variable|option [`'"][^`'"]+[`'"] does not exist/i.test(
    detail,
  );
}

function buildCheck(input: {
  code: SecretValidationCheck["code"];
  label: string;
  result: SecretValidationCheck["result"];
  summary: string;
  detail?: string | null;
}): SecretValidationCheck {
  return {
    code: input.code,
    label: input.label,
    result: input.result,
    summary: input.summary.trim(),
    detail: input.detail?.trim() ? input.detail.trim() : null,
  };
}

function uniqueSorted(values: Iterable<string>): ReadonlyArray<string> {
  return [...new Set([...values].map((value) => value.trim()).filter(Boolean))].toSorted((a, b) =>
    a.localeCompare(b),
  );
}

function formatList(values: ReadonlyArray<string>): string {
  return values.join("\n");
}

function pluralize(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function heuristicDetectionSummary(contents: string): string | null {
  if (/(^|\W)sops-nix(\W|$)/i.test(contents) || /config\.sops\.secrets/i.test(contents)) {
    return "This flake appears to reference sops-nix, but no host config.sops.secrets evaluation succeeded.";
  }
  return null;
}

function decodeSecretSourcePath(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return trimToNull(value);
}

function formatOutsideWorkspaceSource(input: {
  readonly secretName: string;
  readonly evaluatedPath: string;
  readonly workspacePath: string | null;
}): string {
  return [
    `${input.secretName}: source path is outside the workspace`,
    `evaluatedPath: ${input.evaluatedPath}`,
    `workspacePath: ${input.workspacePath ?? "unresolved"}`,
  ].join("\n");
}

function decodeSecretEntries<R>(input: {
  readonly secretsValue: unknown;
  readonly defaultSopsFile: string | null;
  readonly resolvePath: (rawPath: string) => Effect.Effect<SecretPathResolution | null, never, R>;
}): Effect.Effect<HostSecretEntry[], never, R> {
  return Effect.gen(function* () {
    if (typeof input.secretsValue !== "object" || input.secretsValue === null) {
      return [] as HostSecretEntry[];
    }

    const entries = yield* Effect.forEach(
      Object.entries(input.secretsValue as Record<string, unknown>).toSorted(([left], [right]) =>
        left.localeCompare(right),
      ),
      ([name, value]) =>
        Effect.gen(function* () {
          const normalizedName = trimToNull(name);
          if (normalizedName === null) {
            return null;
          }

          const secretConfig =
            value && typeof value === "object" ? (value as Record<string, unknown>) : null;
          const rawPath =
            decodeSecretSourcePath(secretConfig?.sopsFile) ?? trimToNull(input.defaultSopsFile);
          const resolved = rawPath === null ? null : yield* input.resolvePath(rawPath);

          return {
            name: normalizedName,
            encryptedSourcePath: rawPath,
            workspaceRelativeEncryptedSourcePath: resolved?.workspaceRelativePath ?? null,
          } satisfies HostSecretEntry;
        }),
      { concurrency: 8 },
    );

    return entries.filter((entry): entry is HostSecretEntry => entry !== null);
  });
}

export const ProjectSecretsServiceLive = Layer.effect(
  ProjectSecretsService,
  Effect.gen(function* () {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const flakeMetadataResolver = yield* FlakeMetadataResolver;
    const workspacePaths = yield* WorkspacePaths;

    const loadSecretsSummary = (
      workspaceRoot: string,
    ): Effect.Effect<CachedProjectSecretsSummary, never, never> =>
      Effect.gen(function* () {
        const flakeMetadata = yield* flakeMetadataResolver.resolve(workspaceRoot);
        const flakeSourceRoot = yield* Effect.promise(async () => {
          try {
            return decodeNixFlakeSourcePath(await loadNixFlakeMetadataJson(workspaceRoot));
          } catch {
            return null;
          }
        });
        const hosts =
          flakeMetadata.hosts.length > 0
            ? flakeMetadata.hosts
            : flakeMetadata.host
              ? [flakeMetadata.host]
              : [];
        const supportedHosts: ReadonlyArray<SupportedHostContext> = hosts.map((host) => ({
          host,
          configAttrPrefix: resolveConfigAttrPrefix(host),
        }));

        const resolveWorkspaceSourcePath: (
          rawPath: string,
        ) => Effect.Effect<SecretPathResolution | null, never, never> = (rawPath) =>
          Effect.gen(function* () {
            const trimmed = trimToNull(rawPath);
            if (trimmed === null) {
              return null;
            }

            const resolved = yield* workspacePaths
              .resolvePathWithinRoot({
                workspaceRoot,
                path: trimmed,
                ...(flakeSourceRoot === null ? {} : { additionalRoots: [flakeSourceRoot] }),
              })
              .pipe(Effect.catch(() => Effect.succeed(null)));

            if (resolved === null) {
              return {
                evaluatedPath: trimmed,
                workspaceRelativePath: null,
                absolutePath: null,
              } satisfies SecretPathResolution;
            }

            return {
              evaluatedPath: trimmed,
              workspaceRelativePath: resolved.relativePath,
              absolutePath: resolved.absolutePath,
            } satisfies SecretPathResolution;
          }).pipe(Effect.orDie);

        const runNixEvalJson: (attrPath: string) => Effect.Effect<NixEvalOutcome, never, never> = (
          attrPath: string,
        ) =>
          Effect.promise(async () => {
            try {
              const result = await runProcess("nix", ["eval", "--json", attrPath], {
                cwd: workspaceRoot,
                allowNonZeroExit: true,
                timeoutMs: DEFAULT_NIX_EVAL_TIMEOUT_MS,
                maxBufferBytes: DEFAULT_PROCESS_BUFFER_BYTES,
                outputMode: "truncate",
              });

              if (result.code !== 0) {
                const detail = summarizeOutput(result.stdout, result.stderr);
                return {
                  status: detail !== null && classifyMissingEval(detail) ? "missing" : "error",
                  value: null,
                  detail,
                } satisfies NixEvalOutcome;
              }

              return {
                status: "success",
                value: JSON.parse(result.stdout),
                detail: null,
              } satisfies NixEvalOutcome;
            } catch (cause) {
              return {
                status: "error",
                value: null,
                detail: cause instanceof Error ? cause.message : "nix eval could not run.",
              } satisfies NixEvalOutcome;
            }
          });

        const resolvedHostInventories = yield* Effect.forEach(
          supportedHosts,
          ({ host, configAttrPrefix }) =>
            Effect.gen(function* () {
              const declarationLabel = "Secret declarations";
              const sourceExistsLabel = "Encrypted source files";
              const sourceReadableLabel = "Encrypted source readability";

              if (configAttrPrefix === null) {
                return {
                  inventory: {
                    hostName: host.name,
                    secretCount: 0,
                    sourceFileCount: 0,
                    secrets: [],
                    validationChecks: [
                      buildCheck({
                        code: "declaration-eval",
                        label: declarationLabel,
                        result: "skipped",
                        summary: `Secret inventory is not resolved for ${host.name} because its host type is not supported in this MVP.`,
                      }),
                      buildCheck({
                        code: "encrypted-source-exists",
                        label: sourceExistsLabel,
                        result: "skipped",
                        summary: `Encrypted source file validation is unavailable for ${host.name}.`,
                      }),
                      buildCheck({
                        code: "encrypted-source-readable",
                        label: sourceReadableLabel,
                        result: "skipped",
                        summary: `Encrypted source readability is unavailable for ${host.name}.`,
                      }),
                    ],
                  } satisfies HostSecretInventory,
                  providerDetectedByEval: false,
                } satisfies ResolvedHostInventory;
              }

              const declarations = yield* runNixEvalJson(`${configAttrPrefix}.config.sops.secrets`);

              if (declarations.status === "missing") {
                return {
                  inventory: {
                    hostName: host.name,
                    secretCount: 0,
                    sourceFileCount: 0,
                    secrets: [],
                    validationChecks: [
                      buildCheck({
                        code: "declaration-eval",
                        label: declarationLabel,
                        result: "skipped",
                        summary: `No sops-nix secret declarations were resolved for ${host.name}.`,
                      }),
                      buildCheck({
                        code: "encrypted-source-exists",
                        label: sourceExistsLabel,
                        result: "skipped",
                        summary: `Encrypted source file validation is skipped because ${host.name} does not expose config.sops.secrets.`,
                      }),
                      buildCheck({
                        code: "encrypted-source-readable",
                        label: sourceReadableLabel,
                        result: "skipped",
                        summary: `Encrypted source readability is skipped because ${host.name} does not expose config.sops.secrets.`,
                      }),
                    ],
                  } satisfies HostSecretInventory,
                  providerDetectedByEval: false,
                } satisfies ResolvedHostInventory;
              }

              if (declarations.status === "error") {
                return {
                  inventory: {
                    hostName: host.name,
                    secretCount: 0,
                    sourceFileCount: 0,
                    secrets: [],
                    validationChecks: [
                      buildCheck({
                        code: "declaration-eval",
                        label: declarationLabel,
                        result: "fail",
                        summary: `Could not evaluate sops-nix declarations for ${host.name}.`,
                        detail: declarations.detail,
                      }),
                      buildCheck({
                        code: "encrypted-source-exists",
                        label: sourceExistsLabel,
                        result: "skipped",
                        summary: `Encrypted source file validation is skipped until ${host.name}'s secret declarations evaluate successfully.`,
                      }),
                      buildCheck({
                        code: "encrypted-source-readable",
                        label: sourceReadableLabel,
                        result: "skipped",
                        summary: `Encrypted source readability is skipped until ${host.name}'s secret declarations evaluate successfully.`,
                      }),
                    ],
                  } satisfies HostSecretInventory,
                  providerDetectedByEval: false,
                } satisfies ResolvedHostInventory;
              }

              const defaultSopsFileOutcome = yield* runNixEvalJson(
                `${configAttrPrefix}.config.sops.defaultSopsFile`,
              );
              const defaultSopsFile =
                defaultSopsFileOutcome.status === "success"
                  ? decodeSecretSourcePath(defaultSopsFileOutcome.value)
                  : null;

              const secrets = yield* decodeSecretEntries({
                secretsValue: declarations.value,
                defaultSopsFile,
                resolvePath: resolveWorkspaceSourcePath,
              });

              const declarationCheck =
                typeof declarations.value === "object" && declarations.value !== null
                  ? buildCheck({
                      code: "declaration-eval",
                      label: declarationLabel,
                      result: "pass",
                      summary: `Resolved ${pluralize(secrets.length, "secret", "secrets")} for ${host.name}.`,
                    })
                  : buildCheck({
                      code: "declaration-eval",
                      label: declarationLabel,
                      result: "fail",
                      summary: `config.sops.secrets for ${host.name} did not decode into a secret attrset.`,
                    });

              const missingSourceDeclarations = uniqueSorted(
                secrets
                  .filter((secret) => secret.encryptedSourcePath === null)
                  .map((secret) => secret.name),
              );
              const outsideWorkspaceSources = uniqueSorted(
                secrets
                  .filter(
                    (secret) =>
                      secret.encryptedSourcePath !== null &&
                      secret.workspaceRelativeEncryptedSourcePath === null,
                  )
                  .map((secret) =>
                    formatOutsideWorkspaceSource({
                      secretName: secret.name,
                      evaluatedPath: secret.encryptedSourcePath ?? "missing source path",
                      workspacePath: secret.workspaceRelativeEncryptedSourcePath,
                    }),
                  ),
              );
              const resolvedSourcePaths = uniqueSorted(
                secrets
                  .map((secret) => secret.workspaceRelativeEncryptedSourcePath)
                  .filter((value): value is string => value !== null),
              );
              const sourceFileCount = resolvedSourcePaths.length;

              const sourcePathStatuses = yield* Effect.forEach(
                resolvedSourcePaths,
                (sourcePath) =>
                  Effect.gen(function* () {
                    const resolved = yield* workspacePaths
                      .resolveRelativePathWithinRoot({
                        workspaceRoot,
                        relativePath: sourcePath,
                      })
                      .pipe(Effect.catch(() => Effect.succeed(null)));
                    if (resolved === null) {
                      return {
                        sourcePath,
                        exists: false,
                        readable: false,
                      };
                    }

                    const exists = yield* Effect.promise(async () => {
                      try {
                        await access(resolved.absolutePath, constants.F_OK);
                        return true;
                      } catch {
                        return false;
                      }
                    });
                    if (!exists) {
                      return {
                        sourcePath,
                        exists: false,
                        readable: false,
                      };
                    }

                    const readable = yield* Effect.promise(async () => {
                      try {
                        await access(resolved.absolutePath, constants.R_OK);
                        return true;
                      } catch {
                        return false;
                      }
                    });

                    return {
                      sourcePath,
                      exists: true,
                      readable,
                    };
                  }),
                { concurrency: 8 },
              );

              const missingSourceFiles = uniqueSorted(
                sourcePathStatuses
                  .filter((entry) => entry.exists === false)
                  .map((entry) => entry.sourcePath),
              );
              const unreadableSourceFiles = uniqueSorted(
                sourcePathStatuses
                  .filter((entry) => entry.exists === true && entry.readable === false)
                  .map((entry) => entry.sourcePath),
              );

              const sourceExistsCheck =
                secrets.length === 0
                  ? buildCheck({
                      code: "encrypted-source-exists",
                      label: sourceExistsLabel,
                      result: "skipped",
                      summary: `No sops-nix secrets are declared for ${host.name}.`,
                    })
                  : missingSourceDeclarations.length === 0 &&
                      outsideWorkspaceSources.length === 0 &&
                      missingSourceFiles.length === 0
                    ? buildCheck({
                        code: "encrypted-source-exists",
                        label: sourceExistsLabel,
                        result: "pass",
                        summary:
                          sourceFileCount > 0
                            ? `All ${pluralize(sourceFileCount, "encrypted source file", "encrypted source files")} exist inside the workspace for ${host.name}.`
                            : `All secrets for ${host.name} resolve their encrypted source files without additional workspace files.`,
                      })
                    : buildCheck({
                        code: "encrypted-source-exists",
                        label: sourceExistsLabel,
                        result: "fail",
                        summary: `Encrypted source files are incomplete for ${host.name}.`,
                        detail: formatList([
                          ...missingSourceDeclarations.map(
                            (name) => `${name}: missing sopsFile/defaultSopsFile declaration`,
                          ),
                          ...outsideWorkspaceSources,
                          ...missingSourceFiles.map(
                            (sourcePath) => `${sourcePath}: file does not exist`,
                          ),
                        ]),
                      });

              const sourceReadableCheck =
                sourceExistsCheck.result !== "pass"
                  ? buildCheck({
                      code: "encrypted-source-readable",
                      label: sourceReadableLabel,
                      result: "skipped",
                      summary: `Encrypted source readability is skipped until ${host.name}'s source file references are valid.`,
                    })
                  : unreadableSourceFiles.length === 0
                    ? buildCheck({
                        code: "encrypted-source-readable",
                        label: sourceReadableLabel,
                        result: "pass",
                        summary:
                          sourceFileCount > 0
                            ? `All ${pluralize(sourceFileCount, "encrypted source file", "encrypted source files")} are readable for ${host.name}.`
                            : `No additional encrypted source files need readability checks for ${host.name}.`,
                      })
                    : buildCheck({
                        code: "encrypted-source-readable",
                        label: sourceReadableLabel,
                        result: "fail",
                        summary: `Some encrypted source files are not readable for ${host.name}.`,
                        detail: formatList(
                          unreadableSourceFiles.map(
                            (sourcePath) => `${sourcePath}: file is not readable`,
                          ),
                        ),
                      });

              return {
                inventory: {
                  hostName: host.name,
                  secretCount: secrets.length,
                  sourceFileCount,
                  secrets,
                  validationChecks: [declarationCheck, sourceExistsCheck, sourceReadableCheck],
                } satisfies HostSecretInventory,
                providerDetectedByEval: true,
              } satisfies ResolvedHostInventory;
            }),
          { concurrency: 4 },
        );
        const hostInventories = resolvedHostInventories.map((entry) => entry.inventory);
        const providerDetected = resolvedHostInventories.some(
          (entry) => entry.providerDetectedByEval,
        );

        const flakeContents = yield* Effect.promise(async () => {
          try {
            return await readFile(`${workspaceRoot}/flake.nix`, "utf8");
          } catch {
            return null;
          }
        });
        const detectionSummary =
          providerDetected || flakeContents === null
            ? null
            : heuristicDetectionSummary(flakeContents);

        const summary = {
          provider: providerDetected ? "sops-nix" : "none",
          detectionSummary,
          hostInventories,
          updatedAt: new Date().toISOString(),
        } satisfies ProjectSecretsSummary;

        return {
          summary,
          provider: summary.provider,
        };
      });

    const summaryCache = yield* Cache.makeWith<string, CachedProjectSecretsSummary>(
      loadSecretsSummary,
      {
        capacity: DEFAULT_CACHE_CAPACITY,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) && exit.value.provider === "sops-nix"
            ? DEFAULT_POSITIVE_CACHE_TTL
            : DEFAULT_NEGATIVE_CACHE_TTL,
      },
    );

    const getSummary: ProjectSecretsServiceShape["getSummary"] = (input) =>
      Effect.gen(function* () {
        const project = yield* projectionSnapshotQuery.getProjectShellById(input.projectId).pipe(
          Effect.mapError((cause) =>
            toProjectSecretsError("Failed to load the selected flake.", cause),
          ),
          Effect.flatMap((result) =>
            Option.match(result, {
              onNone: () =>
                Effect.fail(toProjectSecretsError(`Flake ${input.projectId} was not found.`)),
              onSome: Effect.succeed,
            }),
          ),
        );

        const cached = yield* Cache.get(summaryCache, project.workspaceRoot).pipe(
          Effect.mapError((cause) =>
            toProjectSecretsError("Failed to resolve project secrets.", cause),
          ),
        );

        return cached.summary;
      });

    return {
      getSummary,
    } satisfies ProjectSecretsServiceShape;
  }),
);
