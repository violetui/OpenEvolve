import type { AgentModule } from "../core/module";
import type {
  FeatureSpecPayload,
  FeatureInstallLevel
} from "../core/event-types";
import { classifyInstallLevel } from "../core/policy";

/**
 * FeatureSpecGenerator Module
 *
 * Subscribes to feature.candidate.scored (where passed=true)
 * Converts approved candidates into internal capability specifications
 * Publishes feature.spec.generated
 *
 * Core principle: external features cannot be integrated directly — they must first be converted to an internal spec
 * External feature → Internal capability spec → Plugin prototype → Evaluation → Installation
 */
export const FeatureSpecGeneratorModule: AgentModule = {
  name: "feature-spec-generator",

  start(ctx) {
    ctx.bus.subscribe("feature.candidate.scored", async (event) => {
      if (!event.payload.passed) {
        console.log(`[feature-spec-generator] Candidate ${event.payload.candidateId} did not pass scoring, skipping`);
        return;
      }

      // Need to retrieve candidate details from previous candidate.found event
      // MVP version: generate spec based on candidateId
      const spec = generateSpec(event.payload.candidateId);

      await ctx.bus.publish({
        type: "feature.spec.generated",
        source: "feature-spec-generator",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: event.payload.candidateId,
          spec
        }
      });
    });
  }
};

/**
 * Generate an internal capability spec from a candidate ID
 *
 * MVP version uses preset mappings
 * Real version should call LLM to analyze candidate features and generate detailed specs
 */
function generateSpec(candidateId: string): FeatureSpecPayload {
  const spec: FeatureSpecPayload = {
    id: `spec-${candidateId.slice(0, 8)}`,
    type: "plugin",
    description: "Auto-generated feature specification",
    permissions: {
      network: {
        allow: []
      },
      filesystem: {
        read: ["data/feature_candidates"],
        write: ["data/feature_candidates"]
      }
    },
    events: {
      subscribes: ["feature.scout.requested"],
      publishes: ["feature.candidate.found"]
    },
    riskLevel: "medium",
    evals: [
      "Can correctly parse plugin metadata",
      "Can identify high-risk tools",
      "Must not auto-enable high-permission tools"
    ],
    installLevel: classifyInstallLevel({
      filesystem: {
        read: ["data/feature_candidates"],
        write: ["data/feature_candidates"]
      }
    }) as FeatureInstallLevel
  };

  return spec;
}
