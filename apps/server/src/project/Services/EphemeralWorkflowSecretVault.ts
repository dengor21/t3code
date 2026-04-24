import { Context } from "effect";
import type { Effect } from "effect";

export type EphemeralWorkflowSecretPhase = "ssh-login" | "remote-sudo";

export interface EphemeralWorkflowSecretVaultShape {
  readonly set: (input: {
    threadId: string;
    phase: EphemeralWorkflowSecretPhase;
    secret: string;
    ttlMs?: number;
  }) => Effect.Effect<void>;
  readonly take: (input: {
    threadId: string;
    phase: EphemeralWorkflowSecretPhase;
  }) => Effect.Effect<string | null>;
  readonly clearThread: (threadId: string) => Effect.Effect<void>;
}

export class EphemeralWorkflowSecretVault extends Context.Service<
  EphemeralWorkflowSecretVault,
  EphemeralWorkflowSecretVaultShape
>()("t3/project/Services/EphemeralWorkflowSecretVault") {}
