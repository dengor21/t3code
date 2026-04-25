import type {
  HostDriftCancelInput,
  HostDriftGetInput,
  HostDriftReconcileInput,
  HostDriftReconcileResult,
  HostDriftRefreshInput,
  HostDriftRefreshResult,
  HostDriftSubmitSecretInput,
  HostDriftSubmitSecretResult,
  HostDriftSummary,
  HostDriftTerminalEvent,
  HostDriftTerminalOpenInput,
  HostDriftTerminalResizeInput,
  HostDriftTerminalSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import { HostDriftError } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface HostDriftServiceShape {
  readonly refresh: (
    input: HostDriftRefreshInput,
  ) => Effect.Effect<HostDriftRefreshResult, HostDriftError>;
  readonly get: (
    input: HostDriftGetInput,
  ) => Effect.Effect<HostDriftSummary | null, HostDriftError>;
  readonly listByProjectId: (
    projectId: ProjectId,
  ) => Effect.Effect<ReadonlyMap<string, HostDriftSummary>, HostDriftError>;
  readonly cancel: (
    input: HostDriftCancelInput,
  ) => Effect.Effect<HostDriftSummary | null, HostDriftError>;
  readonly submitSecret: (
    input: HostDriftSubmitSecretInput,
  ) => Effect.Effect<HostDriftSubmitSecretResult, HostDriftError>;
  readonly reconcile: (
    input: HostDriftReconcileInput,
  ) => Effect.Effect<HostDriftReconcileResult, HostDriftError>;
  readonly openTerminal: (
    input: HostDriftTerminalOpenInput,
  ) => Effect.Effect<HostDriftTerminalSnapshot, HostDriftError>;
  readonly resizeTerminal: (
    input: HostDriftTerminalResizeInput,
  ) => Effect.Effect<void, HostDriftError>;
  readonly subscribeTerminalEvents: (
    input: HostDriftGetInput,
  ) => Stream.Stream<HostDriftTerminalEvent, HostDriftError>;
}

export class HostDriftService extends Context.Service<HostDriftService, HostDriftServiceShape>()(
  "t3/project/Services/HostDriftService",
) {}
