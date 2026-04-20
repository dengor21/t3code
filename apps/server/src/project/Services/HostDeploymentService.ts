import type {
  HostDeploymentGetInput,
  HostDeploymentStartInput,
  HostDeploymentStartResult,
  HostDeploymentStopInput,
  HostDeploymentSummary,
  HostDeploymentTerminalEvent,
  HostDeploymentTerminalOpenInput,
  HostDeploymentTerminalResizeInput,
  HostDeploymentTerminalSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { HostDeploymentError } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface HostDeploymentServiceShape {
  readonly start: (
    input: HostDeploymentStartInput,
  ) => Effect.Effect<HostDeploymentStartResult, HostDeploymentError>;
  readonly get: (
    input: HostDeploymentGetInput,
  ) => Effect.Effect<HostDeploymentSummary | null, HostDeploymentError>;
  readonly listByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyMap<string, HostDeploymentSummary>, HostDeploymentError>;
  readonly stop: (
    input: HostDeploymentStopInput,
  ) => Effect.Effect<HostDeploymentSummary | null, HostDeploymentError>;
  readonly openTerminal: (
    input: HostDeploymentTerminalOpenInput,
  ) => Effect.Effect<HostDeploymentTerminalSnapshot, HostDeploymentError>;
  readonly resizeTerminal: (
    input: HostDeploymentTerminalResizeInput,
  ) => Effect.Effect<void, HostDeploymentError>;
  readonly subscribeTerminalEvents: (
    input: HostDeploymentGetInput,
  ) => Stream.Stream<HostDeploymentTerminalEvent, HostDeploymentError>;
}

export class HostDeploymentService extends Context.Service<
  HostDeploymentService,
  HostDeploymentServiceShape
>()("t3/project/Services/HostDeploymentService") {}
