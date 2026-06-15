/**
 * LLM Bridge Module — Bridges EventBus with the LLM Service
 *
 * Subscribes to LLM-related events and publishes results back.
 * Also provides HTTP endpoints for model management.
 */

import type { AgentModule } from "../core/module";

export const LLMBridgeModule: AgentModule = {
  name: "llm-bridge",

  start(ctx) {
    // Listen for model switch events
    ctx.bus.subscribe("llm.model.switched", async (event) => {
      console.log(
        `[llm-bridge] Model switched: ${event.payload.previousModelId} -> ${event.payload.newModelId} (by ${event.payload.switchedBy})`
      );
    });

    // Listen for LLM failures
    ctx.bus.subscribe("llm.chat.failed", async (event) => {
      console.error(
        `[llm-bridge] LLM failed: ${event.payload.modelId} for task ${event.payload.taskType}: ${event.payload.error}`
      );
    });

    // Listen for model status changes
    ctx.bus.subscribe("llm.model.status_changed", async (event) => {
      console.log(
        `[llm-bridge] Model status changed: ${event.payload.modelId} ${event.payload.previousStatus} -> ${event.payload.newStatus}`
      );
    });

    console.log("[llm-bridge] Started, bridging EventBus <-> LLM Service");
  },
};
