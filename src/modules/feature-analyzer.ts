import { randomUUID } from "node:crypto";
import type { AgentModule } from "../core/module";
import type {
  FeatureCandidatePayload,
  FeatureCapabilityType,
  FeatureSourceType,
  FeatureScorePayload,
  FeatureIntegrationType,
} from "../core/event-types";
import {
  calculateFeatureScore,
  FEATURE_SCORE_THRESHOLD
} from "../core/policy";

/**
 * FeatureAnalyzer Module
 *
 * Subscribes to feature.sources.discovered
 * Analyzes discovered external feature sources using LLM
 * Publishes feature.candidate.found and feature.candidate.scored
 */
export const FeatureAnalyzerModule: AgentModule = {
  name: "feature-analyzer",

  start(ctx) {
    ctx.bus.subscribe("feature.sources.discovered", async (event) => {
      const sources = event.payload.sources;

      console.log(`[feature-analyzer] Found ${sources.length} external sources, starting analysis`);

      for (const source of sources) {
        try {
          // Use LLM to analyze the feature and generate scores
          const response = await ctx.llm.chat({
            taskType: "feature_analyze",
            messages: [
              {
                role: "system",
                content: `You are a feature analyst for a self-evolving AI agent system.
Analyze external features and score them on these dimensions (0.0 to 1.0):
- usefulness: How useful is this feature for the agent system?
- frequency: How often would this feature be used?
- integration: How easy is it to integrate?
- security: How secure/safe is this feature? (higher = safer)
- maintenance: How easy is it to maintain?
- novelty: How novel/innovative is this feature?
- overlap: How much does it overlap with existing capabilities?

Classify the capability type: plugin, skill, tool, workflow, security, memory, evaluation, or deployment.

Also determine the best integration method:
- "plugin": A standalone new module/plugin (new capability, independent code)
- "code_patch": Changes to existing code files (improve existing modules, fix patterns, add features to current code)
- "skill_file": New knowledge/instructions in a skill file (prompt engineering, domain knowledge, workflow instructions)

CRITICAL: Default to "code_patch" or "skill_file" for most discoveries. Only use "plugin" for genuinely standalone new capabilities. Most external discoveries are better integrated by improving existing code or adding knowledge.

Respond ONLY with valid JSON in this format:
{
  "title": "Feature Title",
  "capabilityType": "plugin|skill|tool|workflow|security|memory|evaluation|deployment",
  "integrationType": "plugin|code_patch|skill_file",
  "proposedUse": "How this feature would be used",
  "scores": {
    "usefulness": 0.7,
    "frequency": 0.6,
    "integration": 0.5,
    "security": 0.8,
    "maintenance": 0.6,
    "novelty": 0.5,
    "overlap": 0.3
  }
}`
              },
              {
                role: "user",
                content: `Analyze this external feature source:
Name: ${source.name}
Type: ${source.type}
URL: ${source.url}
Description: ${source.description}

Provide a feature analysis with scores.`
              }
            ]
          });

          // Parse LLM response
          let analysis;
          try {
            const content = response.content
              .replace(/```json\n?/g, "")
              .replace(/```\n?/g, "")
              .trim();
            analysis = JSON.parse(content);
          } catch {
            // Fallback to preset analysis
            analysis = generateFallbackAnalysis(source);
          }

          // Build candidate from LLM analysis
          const candidate: FeatureCandidatePayload = {
            id: randomUUID(),
            title: analysis.title ?? `Feature from ${source.name}`,
            source: source.type,
            url: source.url,
            summary: source.description,
            capabilityType: (analysis.capabilityType ?? "tool") as FeatureCapabilityType,
            integrationType: (analysis.integrationType ?? "code_patch") as FeatureIntegrationType,
            proposedUse: analysis.proposedUse ?? source.description,
            scores: {
              usefulness: clamp(analysis.scores?.usefulness ?? 0.5),
              frequency: clamp(analysis.scores?.frequency ?? 0.5),
              integration: clamp(analysis.scores?.integration ?? 0.5),
              security: clamp(analysis.scores?.security ?? 0.5),
              maintenance: clamp(analysis.scores?.maintenance ?? 0.5),
              novelty: clamp(analysis.scores?.novelty ?? 0.5),
              overlap: clamp(analysis.scores?.overlap ?? 0.3),
            },
            status: "discovered"
          };

          // Publish candidate found event
          await ctx.bus.publish({
            type: "feature.candidate.found",
            source: "feature-analyzer",
            correlationId: event.correlationId,
            causationId: event.id,
            payload: {
              candidate
            }
          });

          // Score the candidate
          const scores: FeatureScorePayload = {
            usefulness: candidate.scores.usefulness,
            frequency: candidate.scores.frequency,
            integration: candidate.scores.integration,
            security: candidate.scores.security,
            maintenance: candidate.scores.maintenance,
            novelty: candidate.scores.novelty,
            overlap: candidate.scores.overlap,
          };
          const finalScore = calculateFeatureScore(scores);
          const passed = finalScore >= FEATURE_SCORE_THRESHOLD;

          // Publish scored event
          await ctx.bus.publish({
            type: "feature.candidate.scored",
            source: "feature-analyzer",
            correlationId: event.correlationId,
            causationId: event.id,
            payload: {
              candidateId: candidate.id,
              scores,
              finalScore,
              passed
            }
          });

          // Publish LLM completion
          await ctx.bus.publish({
            type: "llm.chat.completed",
            source: "feature-analyzer",
            correlationId: event.correlationId,
            causationId: event.id,
            payload: {
              taskType: "feature_analyze",
              modelId: response.modelId,
              modelName: response.modelName,
              provider: response.provider,
              content: response.content.substring(0, 200),
              durationMs: response.durationMs,
              tokensUsed: response.usage?.totalTokens,
              fallbackUsed: response.fallbackUsed
            }
          });
        } catch (error) {
          console.error(`[feature-analyzer] LLM analysis failed for ${source.name}, using fallback`);

          // Fallback: use preset candidate
          const candidate = generateFallbackCandidate(source);
          const scores = scoreFallbackCandidate(candidate);
          const finalScore = calculateFeatureScore(scores);
          const passed = finalScore >= FEATURE_SCORE_THRESHOLD;

          await ctx.bus.publish({
            type: "feature.candidate.found",
            source: "feature-analyzer",
            correlationId: event.correlationId,
            causationId: event.id,
            payload: { candidate }
          });

          await ctx.bus.publish({
            type: "feature.candidate.scored",
            source: "feature-analyzer",
            correlationId: event.correlationId,
            causationId: event.id,
            payload: {
              candidateId: candidate.id,
              scores,
              finalScore,
              passed
            }
          });
        }
      }
    });
  }
};

// ===== Helper Functions =====

function clamp(value: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function generateFallbackAnalysis(source: {
  type: FeatureSourceType;
  name: string;
  description: string;
}): Record<string, any> {
  const candidateMap: Record<string, Partial<FeatureCandidatePayload>> = {
    "MCP Registry": {
      title: "MCP Tool Adapter",
      capabilityType: "plugin",
      proposedUse: "Standardize connections to external tools and data sources via MCP protocol",
    },
    "GitHub Trending": {
      title: "Agent Open-Source Tool Scanner",
      capabilityType: "tool",
      proposedUse: "Periodically scan GitHub for new agent-related projects",
    },
    "GitHub Agent Repos": {
      title: "Agent Plugin Framework Integration",
      capabilityType: "plugin",
      proposedUse: "Integrate community agent plugin frameworks to extend system capabilities",
    },
    "npm Agent Packages": {
      title: "npm Agent Toolkit",
      capabilityType: "tool",
      proposedUse: "Leverage agent-related packages in the npm ecosystem to extend functionality",
    },
    "GitHub Copilot Changelog": {
      title: "Self-Review Capability",
      capabilityType: "workflow",
      proposedUse: "Adapt Copilot's self-review feature to add a code self-audit workflow",
    },
    "Cursor Changelog": {
      title: "Scheduled Automation Tasks",
      capabilityType: "workflow",
      proposedUse: "Adapt Cursor Automations to support scheduled/conditional agent auto-tasks",
    },
    "Hacker News": {
      title: "Community Trend Awareness",
      capabilityType: "skill",
      proposedUse: "Track community hot topics and identify valuable new AI agent patterns",
    },
    "Papers with Code": {
      title: "Academic Frontier Tracking",
      capabilityType: "skill",
      proposedUse: "Track latest agent-related papers and evaluate whether they are worth adopting",
    },
  };

  const preset = candidateMap[source.name] ?? {
    title: `Feature discovered by ${source.name}`,
    capabilityType: "tool" as FeatureCapabilityType,
    proposedUse: source.description,
  };

  return {
    title: preset.title,
    capabilityType: preset.capabilityType ?? "tool",
    integrationType: (source.type === "github" || source.type === "npm")
      ? "code_patch" as const
      : "skill_file" as const,
    proposedUse: preset.proposedUse,
    scores: {
      usefulness: 0.7,
      frequency: 0.6,
      integration: 0.5,
      security: 0.7,
      maintenance: 0.6,
      novelty: 0.5,
      overlap: 0.3,
    },
  };
}

function generateFallbackCandidate(source: {
  type: FeatureSourceType;
  url: string;
  name: string;
  description: string;
}): FeatureCandidatePayload {
  const analysis = generateFallbackAnalysis(source);
  return {
    id: randomUUID(),
    title: analysis.title,
    source: source.type,
    url: source.url,
    summary: source.description,
    capabilityType: analysis.capabilityType as FeatureCapabilityType,
    integrationType: (analysis.integrationType ?? "code_patch") as FeatureIntegrationType,
    proposedUse: analysis.proposedUse,
    scores: analysis.scores,
    status: "discovered",
  };
}

function scoreFallbackCandidate(candidate: FeatureCandidatePayload): FeatureScorePayload {
  return {
    usefulness: candidate.scores.usefulness,
    frequency: candidate.scores.frequency,
    integration: candidate.scores.integration,
    security: candidate.scores.security,
    maintenance: candidate.scores.maintenance,
    novelty: candidate.scores.novelty,
    overlap: candidate.scores.overlap,
  };
}
