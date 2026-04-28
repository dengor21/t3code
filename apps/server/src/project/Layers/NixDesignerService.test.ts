import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Effect, FileSystem, Layer } from "effect";
import { ProjectId } from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { NixDesignerService } from "../Services/NixDesignerService.ts";
import { NixDesignerServiceLive } from "./NixDesignerService.ts";

it.layer(NodeServices.layer)("NixDesignerServiceLive", (it) => {
  it.effect("returns an error status when flake metadata resolution fails", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspaceRoot = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-nix-designer-status-",
      });
      const service = yield* NixDesignerService;
      const status = yield* service.getStatus({
        projectId: ProjectId.make("project-nix-designer"),
        workspaceRoot,
      });

      expect(status.status).toBe("error");
      expect(status.lastError).not.toBeNull();
      expect(status.revision).toBeNull();
      expect(status.optionCount).toBe(0);
      expect(status.packageCount).toBe(0);
    }).pipe(
      Effect.provide(
        NixDesignerServiceLive.pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-config-" })),
        ),
      ),
    ),
  );
});
