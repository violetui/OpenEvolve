import type { AgentModule } from "../core/module";

export const FailureMinerModule: AgentModule = {
  name: "failure-miner",

  start(ctx) {
    ctx.bus.subscribe("agent.failure.reported", async (event) => {
      await ctx.bus.publish({
        type: "evolution.analysis.requested",
        source: "failure-miner",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          failureEventId: event.id
        }
      });
    });
  }
};
