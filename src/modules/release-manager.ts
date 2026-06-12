import { cp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentModule } from "../core/module";

export const ReleaseManagerModule: AgentModule = {
  name: "release-manager",

  start(ctx) {
    ctx.bus.subscribe("evolution.eval.passed", async (event) => {
      const version = `v${Date.now()}`;
      const releasePath = join(process.cwd(), "releases", version);
      const workspace = event.payload.workspace;

      await mkdir(releasePath, { recursive: true });

      await cp(join(workspace, "src"), join(releasePath, "src"), {
        recursive: true
      });

      await cp(join(workspace, "skills"), join(releasePath, "skills"), {
        recursive: true
      });

      await cp(join(workspace, "dist"), join(releasePath, "dist"), {
        recursive: true
      });

      await writeFile(
        join(releasePath, "release.json"),
        JSON.stringify(
          {
            version,
            createdAt: new Date().toISOString(),
            correlationId: event.correlationId,
            checks: event.payload.checks
          },
          null,
          2
        )
      );

      const created = await ctx.bus.publish({
        type: "release.created",
        source: "release-manager",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          releasePath,
          version
        }
      });

      await ctx.bus.publish({
        type: "deploy.requested",
        source: "release-manager",
        correlationId: event.correlationId,
        causationId: created.id,
        payload: {
          releasePath,
          version
        }
      });
    });
  }
};
