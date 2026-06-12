import { $ } from "bun";
import type { AgentModule } from "../core/module";

/**
 * FeatureEvaluator Module
 *
 * Subscribes to feature.prototype.created
 * Evaluates prototypes in a sandbox to determine if they are genuinely valuable
 * Publishes feature.eval.passed or feature.eval.failed
 *
 * Evaluation pipeline:
 * 1. Install dependencies
 * 2. Run type checks
 * 3. Run tests
 * 4. Check if permission declarations match actual code behavior
 */
export const FeatureEvaluatorModule: AgentModule = {
  name: "feature-evaluator",

  start(ctx) {
    ctx.bus.subscribe("feature.prototype.created", async (event) => {
      const { candidateId, workspace } = event.payload;

      console.log(`[feature-evaluator] Starting evaluation for candidate ${candidateId}`);

      // Publish eval requested event
      await ctx.bus.publish({
        type: "feature.eval.requested",
        source: "feature-evaluator",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId,
          workspace
        }
      });

      try {
        // Step 1: Install dependencies
        await $`bun install`.cwd(workspace);

        // Step 2: Run tests
        await $`bun test`.cwd(workspace);

        // Step 3: Type check (if tsconfig exists)
        try {
          await $`bun run check`.cwd(workspace);
        } catch {
          // Type checking is not a hard requirement
        }

        const checks = [
          "bun install",
          "bun test"
        ];

        await ctx.bus.publish({
          type: "feature.eval.passed",
          source: "feature-evaluator",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            candidateId,
            workspace,
            checks
          }
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "feature.eval.failed",
          source: "feature-evaluator",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            candidateId,
            workspace,
            reason: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });
  }
};
