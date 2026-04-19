import type { FlakeMetadata, ProjectDocumentationState } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface DocumentationStatusResolverShape {
  readonly resolve: (input: {
    workspaceRoot: string;
    flakeMetadata: FlakeMetadata | null;
  }) => Effect.Effect<ProjectDocumentationState, never>;
}

export class DocumentationStatusResolver extends Context.Service<
  DocumentationStatusResolver,
  DocumentationStatusResolverShape
>()("t3/orchestration/Services/DocumentationStatusResolver") {}
