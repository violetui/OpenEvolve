import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/core/event-bus";
import {
  calculateFeatureScore,
  FEATURE_SCORE_THRESHOLD,
  canAutoInstall,
  needsEvalApproval,
  needsHumanApproval,
  isInstallBlocked,
  classifyInstallLevel
} from "../src/core/policy";

describe("Feature Scout pipeline", () => {
  it("should complete full feature discovery chain", async () => {
    const bus = new EventBus();
    const eventLog: string[] = [];

    bus.subscribeAll(async (event) => {
      eventLog.push(event.type);
    });

    // FeatureScout: feature.scout.requested → feature.sources.discovered
    bus.subscribe("feature.scout.requested", async (event) => {
      await bus.publish({
        type: "feature.sources.discovered",
        source: "feature-scout",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          sources: [
            {
              type: "mcp_registry",
              url: "https://registry.modelcontextprotocol.io",
              name: "MCP Registry",
              description: "MCP Server directory"
            }
          ]
        }
      });
    });

    // FeatureAnalyzer: feature.sources.discovered → feature.candidate.found + feature.candidate.scored
    bus.subscribe("feature.sources.discovered", async (event) => {
      const candidate = {
        id: "test-candidate-1",
        title: "MCP Tool Adapter",
        source: "mcp_registry" as const,
        url: "https://example.com",
        summary: "MCP Tool Adapter",
        capabilityType: "plugin" as const,
        proposedUse: "Connect external tools via MCP protocol",
        scores: {
          usefulness: 0.7,
          frequency: 0.6,
          integration: 0.5,
          security: 0.6,
          maintenance: 0.5,
          novelty: 0.6,
          overlap: 0.3
        },
        status: "discovered" as const
      };

      await bus.publish({
        type: "feature.candidate.found",
        source: "feature-analyzer",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: { candidate }
      });

      const scores = candidate.scores;
      const finalScore = calculateFeatureScore(scores);

      await bus.publish({
        type: "feature.candidate.scored",
        source: "feature-analyzer",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: candidate.id,
          scores,
          finalScore,
          passed: finalScore >= FEATURE_SCORE_THRESHOLD
        }
      });
    });

    // FeatureSpecGenerator: feature.candidate.scored → feature.spec.generated
    bus.subscribe("feature.candidate.scored", async (event) => {
      if (!event.payload.passed) return;

      await bus.publish({
        type: "feature.spec.generated",
        source: "feature-spec-generator",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: event.payload.candidateId,
          spec: {
            id: "spec-test",
            type: "plugin",
            description: "Test specification",
            permissions: {},
            events: {
              subscribes: ["feature.scout.requested"],
              publishes: ["feature.candidate.found"]
            },
            riskLevel: "medium",
            evals: ["Test eval 1"],
            installLevel: 2 as const
          }
        }
      });
    });

    // Trigger pipeline
    await bus.publish({
      type: "feature.scout.requested",
      source: "test",
      payload: {
        topics: ["AI agent plugin"],
        triggeredBy: "manual"
      }
    });

    // Verify event chain
    expect(eventLog).toContain("feature.scout.requested");
    expect(eventLog).toContain("feature.sources.discovered");
    expect(eventLog).toContain("feature.candidate.found");
    expect(eventLog).toContain("feature.candidate.scored");
    expect(eventLog).toContain("feature.spec.generated");
  });

  it("should share correlationId across feature chain", async () => {
    const bus = new EventBus();
    const correlationIds: string[] = [];

    bus.subscribeAll(async (event) => {
      correlationIds.push(event.correlationId);
    });

    // Simple chain: scout → sources → candidate
    bus.subscribe("feature.scout.requested", async (event) => {
      await bus.publish({
        type: "feature.sources.discovered",
        source: "test",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: { sources: [] }
      });
    });

    bus.subscribe("feature.sources.discovered", async (event) => {
      await bus.publish({
        type: "feature.candidate.found",
        source: "test",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidate: {
            id: "c1",
            title: "test",
            source: "github" as const,
            url: "https://example.com",
            summary: "test",
            capabilityType: "plugin" as const,
            proposedUse: "test",
            scores: { usefulness: 0, frequency: 0, integration: 0, security: 0, maintenance: 0, novelty: 0, overlap: 0 },
            status: "discovered" as const
          }
        }
      });
    });

    await bus.publish({
      type: "feature.scout.requested",
      source: "test",
      payload: { triggeredBy: "manual" }
    });

    const uniqueIds = new Set(correlationIds);
    expect(uniqueIds.size).toBe(1);
  });

  it("should reject candidates below score threshold", async () => {
    const bus = new EventBus();
    const specGenerated: string[] = [];

    bus.subscribe("feature.candidate.scored", async (event) => {
      if (!event.payload.passed) return;

      await bus.publish({
        type: "feature.spec.generated",
        source: "test",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: event.payload.candidateId,
          spec: {
            id: "spec-test",
            type: "plugin",
            description: "test",
            permissions: {},
            events: { subscribes: [], publishes: [] },
            riskLevel: "low",
            evals: [],
            installLevel: 1 as const
          }
        }
      });
    });

    bus.subscribe("feature.spec.generated", async (event) => {
      specGenerated.push(event.payload.candidateId);
    });

    // Publish low-score candidate
    const lowScores = {
      usefulness: 0.1,
      frequency: 0.1,
      integration: 0.1,
      security: 0.1,
      maintenance: 0.1,
      novelty: 0.1,
      overlap: 0.1
    };
    const lowFinal = calculateFeatureScore(lowScores);

    await bus.publish({
      type: "feature.candidate.scored",
      source: "test",
      payload: {
        candidateId: "low-score-candidate",
        scores: lowScores,
        finalScore: lowFinal,
        passed: lowFinal >= FEATURE_SCORE_THRESHOLD
      }
    });

    // Low-score candidate should not trigger spec generation
    expect(specGenerated.length).toBe(0);
  });
});

describe("Feature scoring policy", () => {
  it("should calculate feature score correctly", () => {
    const scores = {
      usefulness: 0.8,
      frequency: 0.7,
      integration: 0.6,
      security: 0.9,
      maintenance: 0.5,
      novelty: 0.4,
      overlap: 0.3
    };

    const result = calculateFeatureScore(scores);

    // usefulness * 0.3 + frequency * 0.2 + integration * 0.15 + security * 0.2 + maintenance * 0.1 + novelty * 0.05
    const expected =
      0.8 * 0.3 +
      0.7 * 0.2 +
      0.6 * 0.15 +
      0.9 * 0.2 +
      0.5 * 0.1 +
      0.4 * 0.05;

    expect(Math.abs(result - expected)).toBeLessThan(0.001);
  });

  it("should classify install levels correctly", () => {
    // Level 1: No special permissions
    expect(classifyInstallLevel({})).toBe(1);

    // Level 2: Filesystem read only
    expect(classifyInstallLevel({
      filesystem: { read: ["data/"] }
    })).toBe(2);

    // Level 3: Network access
    expect(classifyInstallLevel({
      network: ["https://api.example.com"]
    })).toBe(3);

    // Level 4: Filesystem write
    expect(classifyInstallLevel({
      filesystem: { read: ["data/"], write: ["data/"] }
    })).toBe(4);

    // Level 4: Exec permissions
    expect(classifyInstallLevel({
      exec: ["bash"]
    })).toBe(4);
  });

  it("should enforce install level restrictions", () => {
    expect(canAutoInstall(1)).toBe(true);
    expect(canAutoInstall(2)).toBe(false);
    expect(canAutoInstall(3)).toBe(false);
    expect(canAutoInstall(4)).toBe(false);

    expect(needsEvalApproval(1)).toBe(false);
    expect(needsEvalApproval(2)).toBe(true);
    expect(needsEvalApproval(3)).toBe(false);
    expect(needsEvalApproval(4)).toBe(false);

    expect(needsHumanApproval(1)).toBe(false);
    expect(needsHumanApproval(2)).toBe(false);
    expect(needsHumanApproval(3)).toBe(true);
    expect(needsHumanApproval(4)).toBe(true);

    expect(isInstallBlocked(1)).toBe(false);
    expect(isInstallBlocked(2)).toBe(false);
    expect(isInstallBlocked(3)).toBe(false);
    expect(isInstallBlocked(4)).toBe(true);
  });
});
