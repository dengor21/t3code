import type { FlakeHost, ProjectDashboardHostDeployment } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface DeployRsResolverShape {
  readonly resolveHostDeployments: (input: {
    workspaceRoot: string;
    hosts: ReadonlyArray<FlakeHost>;
  }) => Effect.Effect<ReadonlyMap<string, ProjectDashboardHostDeployment>>;
}

export class DeployRsResolver extends Context.Service<DeployRsResolver, DeployRsResolverShape>()(
  "t3/project/Services/DeployRsResolver",
) {}
