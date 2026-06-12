import type { AgentPlugin } from "../core/plugin";

export default {
  name: "failure-alert-plugin",
  version: "0.1.0",

  permissions: {
    subscribe: ["agent.failure.reported"],
    publish: ["system.event.failed"]
  },

  setup(ctx) {
    ctx.bus.subscribe("agent.failure.reported", async (event) => {
      console.log(`[plugin:${ctx.pluginName}] Failure event detected`, {
        message: event.payload.message,
        correlationId: event.correlationId
      });
    });
  }
} satisfies AgentPlugin;
