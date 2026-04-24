import {
  HostImportSummary,
  type HostImportStatus as HostImportStatusType,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { HostImportRepositoryError } from "../Errors.ts";

export const PersistedHostImport = Schema.Struct({
  ...HostImportSummary.fields,
  terminalOwnerId: Schema.String,
  cwd: Schema.String,
});
export type PersistedHostImport = typeof PersistedHostImport.Type;

export const HostImportLookup = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
});
export type HostImportLookup = typeof HostImportLookup.Type;

export interface HostImportRepositoryShape {
  readonly upsert: (row: PersistedHostImport) => Effect.Effect<void, HostImportRepositoryError>;
  readonly getByProjectAndThread: (
    input: HostImportLookup,
  ) => Effect.Effect<Option.Option<PersistedHostImport>, HostImportRepositoryError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<PersistedHostImport>,
    HostImportRepositoryError
  >;
}

export class HostImportRepository extends Context.Service<
  HostImportRepository,
  HostImportRepositoryShape
>()("t3/persistence/Services/HostImports/HostImportRepository") {}

export function isActiveHostImportStatus(status: HostImportStatusType): boolean {
  return status === "starting" || status === "running";
}
