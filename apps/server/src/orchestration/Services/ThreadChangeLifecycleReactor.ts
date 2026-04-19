import { Context } from "effect";
import type { Effect, Scope } from "effect";

export interface ThreadChangeLifecycleReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class ThreadChangeLifecycleReactor extends Context.Service<
  ThreadChangeLifecycleReactor,
  ThreadChangeLifecycleReactorShape
>()("t3/orchestration/Services/ThreadChangeLifecycleReactor") {}
