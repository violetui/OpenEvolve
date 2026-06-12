import { mkdtemp, cp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize } from "node:path";
import type { AgentModule } from "../core/module";
import { isPathAllowed } from "../core/policy";

export const PatchApplierModule: AgentModule = {
  name: "patch-applier",

  start(ctx) {
    ctx.bus.subscribe("evolution.patch.proposed", async (event) => {
      const workspace = await mkdtemp(join(tmpdir(), "agent-evolve-"));

      await cp(".", workspace, {
        recursive: true,
        filter: (src) => {
          return !src.includes("node_modules") &&
                 !src.includes("releases") &&
                 !src.includes(".git");
        }
      });

      const changedFiles: string[] = [];

      for (const change of event.payload.changes) {
        const path = normalize(change.path);

        if (!isPathAllowed(path)) {
          throw new Error(`path not allowed: ${path}`);
        }

        const target = join(workspace, path);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, change.content, "utf8");

        changedFiles.push(path);
      }

      await ctx.bus.publish({
        type: "evolution.patch.applied",
        source: "patch-applier",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          workspace,
          changedFiles
        }
      });
    });
  }
};
