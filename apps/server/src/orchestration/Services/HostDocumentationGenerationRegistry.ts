import { Context } from "effect";
import type { Effect } from "effect";

export interface HostDocumentationGenerationJob {
  readonly hostName: string;
  readonly queuedAt: string;
  readonly workspaceRoot: string;
}

export interface HostDocumentationGenerationRegistryShape {
  readonly getJob: (input: {
    hostName: string;
    workspaceRoot: string;
  }) => Effect.Effect<HostDocumentationGenerationJob | null, never>;
  readonly ensureJob: (input: { hostName: string; workspaceRoot: string }) => Effect.Effect<
    {
      readonly created: boolean;
      readonly job: HostDocumentationGenerationJob;
    },
    never
  >;
  readonly removeJob: (input: {
    hostName: string;
    workspaceRoot: string;
  }) => Effect.Effect<void, never>;
}

export class HostDocumentationGenerationRegistry extends Context.Service<
  HostDocumentationGenerationRegistry,
  HostDocumentationGenerationRegistryShape
>()("t3/orchestration/Services/HostDocumentationGenerationRegistry") {}
