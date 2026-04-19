import type {
  ProjectGenerateHostDocumentationError,
  ProjectGenerateHostDocumentationResult,
  ProjectId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface HostDocumentationServiceShape {
  readonly generateHostDocumentation: (input: {
    projectId: ProjectId;
    hostName: string;
  }) => Effect.Effect<
    ProjectGenerateHostDocumentationResult,
    ProjectGenerateHostDocumentationError
  >;
}

export class HostDocumentationService extends Context.Service<
  HostDocumentationService,
  HostDocumentationServiceShape
>()("t3/orchestration/Services/HostDocumentationService") {}
