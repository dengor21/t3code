import type {
  HostImportCancelInput,
  HostImportGetInput,
  HostImportStartInput,
  HostImportStartResult,
  HostImportSubmitSecretInput,
  HostImportSubmitSecretResult,
  HostImportSummary,
  HostImportTerminalEvent,
  HostImportTerminalOpenInput,
  HostImportTerminalResizeInput,
  HostImportTerminalSnapshot,
} from "@t3tools/contracts";
import { HostImportError } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect, Stream } from "effect";

export interface HostImportServiceShape {
  readonly start: (
    input: HostImportStartInput,
  ) => Effect.Effect<HostImportStartResult, HostImportError>;
  readonly get: (
    input: HostImportGetInput,
  ) => Effect.Effect<HostImportSummary | null, HostImportError>;
  readonly cancel: (
    input: HostImportCancelInput,
  ) => Effect.Effect<HostImportSummary | null, HostImportError>;
  readonly submitSecret: (
    input: HostImportSubmitSecretInput,
  ) => Effect.Effect<HostImportSubmitSecretResult, HostImportError>;
  readonly openTerminal: (
    input: HostImportTerminalOpenInput,
  ) => Effect.Effect<HostImportTerminalSnapshot, HostImportError>;
  readonly resizeTerminal: (
    input: HostImportTerminalResizeInput,
  ) => Effect.Effect<void, HostImportError>;
  readonly subscribeTerminalEvents: (
    input: HostImportGetInput,
  ) => Stream.Stream<HostImportTerminalEvent, HostImportError>;
}

export class HostImportService extends Context.Service<HostImportService, HostImportServiceShape>()(
  "t3/project/Services/HostImportService",
) {}
