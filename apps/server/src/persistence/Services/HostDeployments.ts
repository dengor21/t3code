import {
  type HostDeploymentStatus as HostDeploymentStatusType,
  HostDeploymentSummary,
  ProjectId,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { HostDeploymentRepositoryError } from "../Errors.ts";

export const PersistedHostDeployment = Schema.Struct({
  ...HostDeploymentSummary.fields,
  hostNameNormalized: Schema.String,
});
export type PersistedHostDeployment = typeof PersistedHostDeployment.Type;

export const HostDeploymentLookup = Schema.Struct({
  projectId: ProjectId,
  hostNameNormalized: Schema.String,
});
export type HostDeploymentLookup = typeof HostDeploymentLookup.Type;

export const ListHostDeploymentsByProjectIdInput = Schema.Struct({
  projectId: ProjectId,
});
export type ListHostDeploymentsByProjectIdInput = typeof ListHostDeploymentsByProjectIdInput.Type;

export interface HostDeploymentRepositoryShape {
  readonly upsert: (
    row: PersistedHostDeployment,
  ) => Effect.Effect<void, HostDeploymentRepositoryError>;
  readonly getByProjectAndHost: (
    input: HostDeploymentLookup,
  ) => Effect.Effect<Option.Option<PersistedHostDeployment>, HostDeploymentRepositoryError>;
  readonly listByProjectId: (
    input: ListHostDeploymentsByProjectIdInput,
  ) => Effect.Effect<ReadonlyArray<PersistedHostDeployment>, HostDeploymentRepositoryError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<PersistedHostDeployment>,
    HostDeploymentRepositoryError
  >;
}

export class HostDeploymentRepository extends Context.Service<
  HostDeploymentRepository,
  HostDeploymentRepositoryShape
>()("t3/persistence/Services/HostDeployments/HostDeploymentRepository") {}

export function isActiveHostDeploymentStatus(status: HostDeploymentStatusType): boolean {
  return status === "starting" || status === "running";
}
