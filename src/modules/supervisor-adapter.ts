import type { AgentModule } from "../core/module";

export const SupervisorAdapterModule: AgentModule = {
  name: "supervisor-adapter",

  start(ctx) {
    ctx.bus.subscribe("deploy.requested", async (event) => {
      try {
        const res = await fetch("http://127.0.0.1:4000/deploy", {
          method: "POST",
          headers: {
            "content-type": "application/json"
          },
          body: JSON.stringify({
            releasePath: event.payload.releasePath,
            version: event.payload.version
          })
        });

        if (!res.ok) {
          throw new Error(`supervisor deploy failed: ${res.status}`);
        }

        await ctx.bus.publish({
          type: "deploy.succeeded",
          source: "supervisor-adapter",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            version: event.payload.version
          }
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "deploy.rollbacked",
          source: "supervisor-adapter",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            failedVersion: event.payload.version,
            rollbackVersion: "previous",
            reason: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });
  }
};
