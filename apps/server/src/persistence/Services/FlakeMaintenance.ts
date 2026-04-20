import {
  type FlakeMaintenanceStatus as FlakeMaintenanceStatusType,
  FlakeMaintenanceSummary,
  ProjectId,
} from "@t3tools/contracts";
import { Context, Option, Schema } from "effect";
import type { Effect } from "effect";

import type { FlakeMaintenanceRepositoryError } from "../Errors.ts";

export const PersistedFlakeMaintenance = FlakeMaintenanceSummary;
export type PersistedFlakeMaintenance = typeof PersistedFlakeMaintenance.Type;

export const FlakeMaintenanceLookup = Schema.Struct({
  projectId: ProjectId,
});
export type FlakeMaintenanceLookup = typeof FlakeMaintenanceLookup.Type;

export interface FlakeMaintenanceRepositoryShape {
  readonly upsert: (
    row: PersistedFlakeMaintenance,
  ) => Effect.Effect<void, FlakeMaintenanceRepositoryError>;
  readonly getByProjectId: (
    input: FlakeMaintenanceLookup,
  ) => Effect.Effect<Option.Option<PersistedFlakeMaintenance>, FlakeMaintenanceRepositoryError>;
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<PersistedFlakeMaintenance>,
    FlakeMaintenanceRepositoryError
  >;
}

export class FlakeMaintenanceRepository extends Context.Service<
  FlakeMaintenanceRepository,
  FlakeMaintenanceRepositoryShape
>()("t3/persistence/Services/FlakeMaintenance/FlakeMaintenanceRepository") {}

export function isActiveFlakeMaintenanceStatus(status: FlakeMaintenanceStatusType): boolean {
  return status === "starting" || status === "running";
}
