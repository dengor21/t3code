import type {
  ProjectBootstrapFlakeError,
  ProjectBootstrapFlakeInput,
  ProjectBootstrapFlakeResult,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProjectFlakeBootstrapServiceShape {
  readonly bootstrapFlake: (
    input: ProjectBootstrapFlakeInput,
  ) => Effect.Effect<ProjectBootstrapFlakeResult, ProjectBootstrapFlakeError>;
}

export class ProjectFlakeBootstrapService extends Context.Service<
  ProjectFlakeBootstrapService,
  ProjectFlakeBootstrapServiceShape
>()("t3/project/Services/ProjectFlakeBootstrapService") {}
