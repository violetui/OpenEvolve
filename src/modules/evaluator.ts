import { $ } from "bun";
import type { AgentModule } from "../core/module";

export const EvaluatorModule: AgentModule = {
  name: "evaluator",

  start(ctx) {
    ctx.bus.subscribe("evolution.patch.applied", async (event) => {
      const workspace = event.payload.workspace;

      try {
        await $`bun install --frozen-lockfile`.cwd(workspace);
        await $`bun test`.cwd(workspace);
        await $`bun run check`.cwd(workspace);
        await $`bun run smoke`.cwd(workspace);
        await $`bun run compile`.cwd(workspace);

        await ctx.bus.publish({
          type: "evolution.eval.passed",
          source: "evaluator",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            workspace,
            checks: [
              "bun install --frozen-lockfile",
              "bun test",
              "tsc --noEmit",
              "smoke",
              "compile"
            ]
          }
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "evolution.eval.failed",
          source: "evaluator",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            workspace,
            reason: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });
  }
};
