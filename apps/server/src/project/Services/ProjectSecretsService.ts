import type {
  ProjectSecretsError,
  ProjectSecretsGetInput,
  ProjectSecretsSummary,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface ProjectSecretsServiceShape {
  readonly getSummary: (
    input: ProjectSecretsGetInput,
  ) => Effect.Effect<ProjectSecretsSummary, ProjectSecretsError>;
}

export class ProjectSecretsService extends Context.Service<
  ProjectSecretsService,
  ProjectSecretsServiceShape
>()("t3/project/Services/ProjectSecretsService") {}
