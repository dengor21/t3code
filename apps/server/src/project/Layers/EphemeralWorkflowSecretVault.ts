import { Effect, Layer, SynchronizedRef } from "effect";

import {
  EphemeralWorkflowSecretVault,
  type EphemeralWorkflowSecretVaultShape,
} from "../Services/EphemeralWorkflowSecretVault.ts";

const DEFAULT_SECRET_TTL_MS = 5 * 60 * 1000;

interface StoredSecret {
  readonly secret: string;
  readonly expiresAt: number;
}

function storageKey(threadId: string, phase: string): string {
  return `${threadId}\u0000${phase}`;
}

export const EphemeralWorkflowSecretVaultLive = Layer.effect(
  EphemeralWorkflowSecretVault,
  Effect.gen(function* () {
    const stateRef = yield* SynchronizedRef.make(new Map<string, StoredSecret>());

    const cleanupExpired = (now: number, current: Map<string, StoredSecret>) => {
      let next: Map<string, StoredSecret> | null = null;
      for (const [key, value] of current) {
        if (value.expiresAt > now) {
          continue;
        }
        if (next === null) {
          next = new Map(current);
        }
        next.delete(key);
      }
      return next ?? current;
    };

    return {
      set: (input) =>
        SynchronizedRef.update(stateRef, (current) => {
          const now = Date.now();
          const next = new Map(cleanupExpired(now, current));
          next.set(storageKey(input.threadId, input.phase), {
            secret: input.secret,
            expiresAt: now + (input.ttlMs ?? DEFAULT_SECRET_TTL_MS),
          });
          return next;
        }),
      take: (input) =>
        SynchronizedRef.modify(stateRef, (current) => {
          const now = Date.now();
          const next = new Map(cleanupExpired(now, current));
          const key = storageKey(input.threadId, input.phase);
          const value = next.get(key) ?? null;
          if (value) {
            next.delete(key);
          }
          return [value?.secret ?? null, next] as const;
        }),
      clearThread: (threadId) =>
        SynchronizedRef.update(stateRef, (current) => {
          let next: Map<string, StoredSecret> | null = null;
          for (const key of current.keys()) {
            if (!key.startsWith(`${threadId}\u0000`)) {
              continue;
            }
            if (next === null) {
              next = new Map(current);
            }
            next.delete(key);
          }
          return next ?? current;
        }),
    } satisfies EphemeralWorkflowSecretVaultShape;
  }),
);
