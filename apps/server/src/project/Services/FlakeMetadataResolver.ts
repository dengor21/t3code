import type { FlakeMetadata } from "@t3tools/contracts";
import { Context } from "effect";
import type { Effect } from "effect";

export interface FlakeMetadataResolverShape {
  readonly resolve: (cwd: string) => Effect.Effect<FlakeMetadata>;
}

export class FlakeMetadataResolver extends Context.Service<
  FlakeMetadataResolver,
  FlakeMetadataResolverShape
>()("t3/project/Services/FlakeMetadataResolver") {}
