import type {
  FlakeMaintenanceGetInput,
  FlakeMaintenanceStartInput,
  FlakeMaintenanceStartResult,
  FlakeMaintenanceStopInput,
  FlakeMaintenanceSummary,
  FlakeMaintenanceTerminalEvent,
  FlakeMaintenanceTerminalOpenInput,
  FlakeMaintenanceTerminalResizeInput,
  FlakeMaintenanceTerminalSnapshot,
} from "@t3tools/contracts";
import { FlakeMaintenanceError } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface FlakeMaintenanceServiceShape {
  readonly start: (
    input: FlakeMaintenanceStartInput,
  ) => Effect.Effect<FlakeMaintenanceStartResult, FlakeMaintenanceError>;
  readonly get: (
    input: FlakeMaintenanceGetInput,
  ) => Effect.Effect<FlakeMaintenanceSummary | null, FlakeMaintenanceError>;
  readonly stop: (
    input: FlakeMaintenanceStopInput,
  ) => Effect.Effect<FlakeMaintenanceSummary | null, FlakeMaintenanceError>;
  readonly openTerminal: (
    input: FlakeMaintenanceTerminalOpenInput,
  ) => Effect.Effect<FlakeMaintenanceTerminalSnapshot, FlakeMaintenanceError>;
  readonly resizeTerminal: (
    input: FlakeMaintenanceTerminalResizeInput,
  ) => Effect.Effect<void, FlakeMaintenanceError>;
  readonly subscribeTerminalEvents: (
    input: FlakeMaintenanceGetInput,
  ) => Stream.Stream<FlakeMaintenanceTerminalEvent, FlakeMaintenanceError>;
}

export class FlakeMaintenanceService extends Context.Service<
  FlakeMaintenanceService,
  FlakeMaintenanceServiceShape
>()("t3/project/Services/FlakeMaintenanceService") {}
