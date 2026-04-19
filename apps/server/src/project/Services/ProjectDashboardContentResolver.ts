import type {
  ProjectDashboardContentResult,
  ProjectGetDashboardContentError,
  ProjectId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProjectDashboardContentResolverShape {
  readonly resolveDashboardContent: (input: {
    projectId: ProjectId;
    hostName?: string;
  }) => Effect.Effect<ProjectDashboardContentResult, ProjectGetDashboardContentError>;
}

export class ProjectDashboardContentResolver extends Context.Service<
  ProjectDashboardContentResolver,
  ProjectDashboardContentResolverShape
>()("t3/project/Services/ProjectDashboardContentResolver") {}
