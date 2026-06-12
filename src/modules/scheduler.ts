import type { AgentModule } from "../core/module";

/**
 * Scheduler Module
 *
 * Periodically triggers feature.scout.requested events
 * MVP version uses setInterval to simulate scheduled dispatch
 * Can be replaced with cron / external scheduler in the future
 */
export const SchedulerModule: AgentModule = {
  name: "scheduler",

  start(ctx) {
    const intervalMs = Number(ctx.env.SCOUT_INTERVAL_MS ?? 24 * 60 * 60 * 1000); // Default: once per day

    const scout = async () => {
      await ctx.bus.publish({
        type: "feature.scout.requested",
        source: "scheduler",
        payload: {
          topics: [
            "AI agent plugin",
            "MCP server",
            "coding agent feature",
            "self healing agent",
            "agent security",
            "agent evaluation"
          ],
          triggeredBy: "scheduler"
        }
      });
    };

    // Delay first trigger by 10s (give other modules time to start)
    setTimeout(scout, 10_000);

    // Then trigger at regular intervals
    setInterval(scout, intervalMs);

    console.log(`[scheduler] Scout scheduler started, interval ${intervalMs / 1000}s`);
  }
};
