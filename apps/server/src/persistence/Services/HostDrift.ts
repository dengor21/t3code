import {
  type HostDriftStatus as HostDriftStatusType,
  HostDriftCategoryResult,
  HostDriftSummary,
  ProjectId,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { HostDriftRepositoryError } from "../Errors.ts";

export const PersistedHostDrift = Schema.Struct({
  ...HostDriftSummary.fields,
  hostNameNormalized: Schema.String,
});
export type PersistedHostDrift = typeof PersistedHostDrift.Type;

export const HostDriftLookup = Schema.Struct({
  projectId: ProjectId,
  hostNameNormalized: Schema.String,
});
export type HostDriftLookup = typeof HostDriftLookup.Type;

export const ListHostDriftByProjectIdInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListHostDriftByProjectIdInput = typeof ListHostDriftByProjectIdInput.Type;

export const ReplaceHostDriftCategoryResultsInput = Schema.Struct({
  projectId: ProjectId,
  hostNameNormalized: Schema.String,
  categoryResults: Schema.Array(HostDriftCategoryResult),
});
export type ReplaceHostDriftCategoryResultsInput = typeof ReplaceHostDriftCategoryResultsInput.Type;

export interface HostDriftRepositoryShape {
  readonly upsert: (row: PersistedHostDrift) => Effect.Effect<void, HostDriftRepositoryError>;
  readonly replaceCategoryResults: (
    input: ReplaceHostDriftCategoryResultsInput,
  ) => Effect.Effect<void, HostDriftRepositoryError>;
  readonly getByProjectAndHost: (
    input: HostDriftLookup,
  ) => Effect.Effect<Option.Option<PersistedHostDrift>, HostDriftRepositoryError>;
  readonly listByProjectId: (
    input: ListHostDriftByProjectIdInput,
  ) => Effect.Effect<ReadonlyArray<PersistedHostDrift>, HostDriftRepositoryError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<PersistedHostDrift>,
    HostDriftRepositoryError
  >;
}

export class HostDriftRepository extends Context.Service<
  HostDriftRepository,
  HostDriftRepositoryShape
>()("t3/persistence/Services/HostDrift/HostDriftRepository") {}

export function isActiveHostDriftStatus(status: HostDriftStatusType): boolean {
  return status === "starting" || status === "running";
}
