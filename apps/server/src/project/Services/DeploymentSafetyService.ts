import type {
  DeploymentActivationStrategy,
  DeploymentPostflightReport,
  DeploymentSafetyError,
  HostDeploymentPreviewInput,
  HostDeploymentPreviewResult,
  ProjectId,
} from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface HostDeploymentPostflightInput {
  readonly projectId: ProjectId;
  readonly hostName: string;
  readonly activationStrategy: DeploymentActivationStrategy;
}

export interface DeploymentSafetyServiceShape {
  readonly preview: (
    input: HostDeploymentPreviewInput,
  ) => Effect.Effect<HostDeploymentPreviewResult, DeploymentSafetyError>;
  readonly buildPostflightReport: (
    input: HostDeploymentPostflightInput,
  ) => Effect.Effect<DeploymentPostflightReport, DeploymentSafetyError>;
}

export class DeploymentSafetyService extends Context.Service<
  DeploymentSafetyService,
  DeploymentSafetyServiceShape
>()("t3/project/Services/DeploymentSafetyService") {}
