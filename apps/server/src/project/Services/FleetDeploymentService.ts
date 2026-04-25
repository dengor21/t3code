import type {
  FleetDeploymentGetInput,
  FleetDeploymentStartInput,
  FleetDeploymentStartResult,
  FleetDeploymentStopInput,
  FleetDeploymentSummary,
} from "@t3tools/contracts";
import { FleetDeploymentError } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface FleetDeploymentServiceShape {
  readonly start: (
    input: FleetDeploymentStartInput,
  ) => Effect.Effect<FleetDeploymentStartResult, FleetDeploymentError>;
  readonly get: (
    input: FleetDeploymentGetInput,
  ) => Effect.Effect<FleetDeploymentSummary | null, FleetDeploymentError>;
  readonly stop: (
    input: FleetDeploymentStopInput,
  ) => Effect.Effect<FleetDeploymentSummary | null, FleetDeploymentError>;
}

export class FleetDeploymentService extends Context.Service<
  FleetDeploymentService,
  FleetDeploymentServiceShape
>()("t3/project/Services/FleetDeploymentService") {}
