import { Context } from "effect";
import type { Effect, Scope } from "effect";

/**
 * DocumentationReactorShape - Service API for living documentation updates.
 */
export interface DocumentationReactorShape {
  /**
   * Start reacting to completed turn diff events and maintain repo docs.
   */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /**
   * Resolves when queued documentation work is drained.
   * Intended for tests.
   */
  readonly drain: Effect.Effect<void>;
}

/**
 * DocumentationReactor - Service tag for documentation update workers.
 */
export class DocumentationReactor extends Context.Service<
  DocumentationReactor,
  DocumentationReactorShape
>()("t3/orchestration/Services/DocumentationReactor") {}
