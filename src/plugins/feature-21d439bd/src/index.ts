/**
 * Auto-generated feature specification
 *
 * Auto-generated plugin prototype
 * riskLevel: medium
 */

import type { AgentPlugin } from "../core/plugin";

export default {
  name: "feature-spec-21d439bd",
  version: "0.1.0",

  permissions: {
    subscribe: [
    "feature.scout.requested"
    ],
    publish: [
    "feature.candidate.found"
    ]
  },

  setup(ctx) {
    ctx.bus.subscribe("feature.scout.requested", async (event) => {
      console.log("[feature-spec-21d439bd] Received event: feature.scout.requested");
    });
  }
} satisfies AgentPlugin;
