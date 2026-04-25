import type {
  McpServerDescriptor,
  NixDesignerScope,
  ProjectDashboardNixDesigner,
  ProjectId,
} from "@t3tools/contracts";
import { Context, Schema } from "effect";
import type { Effect } from "effect";

export class NixDesignerServiceError extends Schema.TaggedErrorClass<NixDesignerServiceError>()(
  "NixDesignerServiceError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface NixDesignerServiceShape {
  readonly getStatus: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<ProjectDashboardNixDesigner, NixDesignerServiceError>;
  readonly ensureIndex: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<ProjectDashboardNixDesigner, NixDesignerServiceError>;
  readonly rebuildIndex: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
  }) => Effect.Effect<ProjectDashboardNixDesigner, NixDesignerServiceError>;
  readonly createDescriptor: (input: {
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly scope: NixDesignerScope;
  }) => Effect.Effect<McpServerDescriptor, NixDesignerServiceError>;
}

export class NixDesignerService extends Context.Service<
  NixDesignerService,
  NixDesignerServiceShape
>()("t3/project/Services/NixDesignerService") {}
