import type { AgentModule } from "../core/module";
import type {
  FeatureSpecPayload,
  FeatureInstallLevel,
  FeatureCandidatePayload,
} from "../core/event-types";
import { classifyInstallLevel } from "../core/policy";

/**
 * FeatureSpecGenerator Module
 *
 * Subscribes to feature.candidate.scored (where passed=true)
 * Converts approved candidates into internal capability specifications using LLM
 * Publishes feature.spec.generated
 *
 * External feature → Internal capability spec → Plugin prototype → Evaluation → Installation
 */
export const FeatureSpecGeneratorModule: AgentModule = {
  name: "feature-spec-generator",

  start(ctx) {
    // Cache candidates so we can retrieve full details when scored
    const candidateCache = new Map<string, FeatureCandidatePayload>();

    ctx.bus.subscribe("feature.candidate.found", (event) => {
      const candidate = event.payload.candidate;
      candidateCache.set(candidate.id, candidate);
      // Evict after 1 hour
      setTimeout(() => candidateCache.delete(candidate.id), 3_600_000);
    });

    ctx.bus.subscribe("feature.candidate.scored", async (event) => {
      if (!event.payload.passed) {
        console.log(`[feature-spec-generator] Candidate ${event.payload.candidateId} did not pass scoring, skipping`);
        return;
      }

      const candidate = candidateCache.get(event.payload.candidateId);

      let spec: FeatureSpecPayload;
      if (candidate) {
        try {
          spec = await generateSpecWithLLM(ctx.llm, candidate);
        } catch (err) {
          console.error(`[feature-spec-generator] LLM spec generation failed: ${err instanceof Error ? err.message : String(err)}`);
          spec = generateFallbackSpec(candidate);
        }
      } else {
        console.log(`[feature-spec-generator] Candidate ${event.payload.candidateId} not in cache, using fallback`);
        spec = generateFallbackSpecById(event.payload.candidateId);
      }

      await ctx.bus.publish({
        type: "feature.spec.generated",
        source: "feature-spec-generator",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: event.payload.candidateId,
          spec,
        },
      });
    });
  },
};

// ===== LLM-based spec generation =====

const SPEC_SYSTEM_PROMPT = `You are a feature specification generator for a self-evolving AI agent system. Based on the analysis of an external feature candidate, generate a detailed internal capability specification.

IMPORTANT: The candidate has a specified "integrationType" which determines how it integrates:
- "plugin": Generate a spec for a standalone new plugin/module
- "code_patch": Generate a spec for modifying existing code files (include targetFiles array with paths to the files that should be changed)
- "skill_file": Generate a spec for a new knowledge/instruction file (skill markdown file)

The agent system is event-driven with these key files:
- src/modules/agent-runtime.ts — Main chat handler with tools
- src/modules/browser-automation.ts — Browser/search automation
- src/modules/scheduler.ts — Idle-time task scheduling
- src/llm/index.ts — LLM service with model registry
- src/core/event-types.ts — Event type definitions

Event chains:
- Repair: agent.failure.reported → evolution.analysis.requested → evolution.patch.proposed → evolution.patch.applied → evolution.eval.requested → release.created → deploy.succeeded
- Scout: feature.scout.requested → feature.sources.discovered → feature.candidate.found → feature.candidate.scored → feature.spec.generated → feature.prototype.created → feature.eval.* → plugin.installed
- Browser: browser.search.requested / browser.fetch.requested / browser.task.requested → completion events
- File ops: file.read.requested, file.write.requested, file.edit.requested, file.glob.requested, file.grep.requested
- Shell: shell.exec.requested → shell.exec.completed
- Todo: todo.operation.requested → todo.operation.completed
- Proactive: proactive.optimization.triggered → log analysis → evolution.patch.proposed

Generate a specification that matches the integrationType. Respond ONLY with valid JSON:

For integrationType "plugin":
{
  "type": "plugin",
  "description": "...",
  "permissions": {
    "network": { "allow": [] },
    "filesystem": { "read": ["data/..."], "write": ["data/..."] }
  },
  "events": {
    "subscribes": ["event.name.here"],
    "publishes": ["event.name.here"]
  },
  "riskLevel": "low",
  "evals": ["Criterion 1", "Criterion 2", "Criterion 3"],
  "installLevel": 2
}

For integrationType "code_patch":
{
  "type": "tool",
  "description": "What this code change accomplishes",
  "targetFiles": ["src/modules/agent-runtime.ts"],
  "riskLevel": "low",
  "evals": ["The change compiles without errors", "Existing tests still pass", "The new behavior works correctly"],
  "installLevel": 2
}

For integrationType "skill_file":
{
  "type": "skill",
  "description": "What knowledge or instructions this skill provides",
  "riskLevel": "low",
  "evals": ["Skill content is well-structured", "Skill covers the intended domain", "Skill is actionable and useful"],
  "installLevel": 1
}`;

async function generateSpecWithLLM(
  llm: { chat: (req: any) => Promise<{ content: string }> },
  candidate: FeatureCandidatePayload,
): Promise<FeatureSpecPayload> {
  const response = await llm.chat({
    taskType: "spec_generate",
    messages: [
      { role: "system", content: SPEC_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Generate a specification for this candidate feature:

Title: ${candidate.title}
Source: ${candidate.source} (${candidate.url})
Capability Type: ${candidate.capabilityType}
Integration Type: ${candidate.integrationType}
Summary: ${candidate.summary}
Proposed Use: ${candidate.proposedUse}
Scores: usefulness=${candidate.scores.usefulness}, frequency=${candidate.scores.frequency}, integration=${candidate.scores.integration}, security=${candidate.scores.security}, novelty=${candidate.scores.novelty}, overlap=${candidate.scores.overlap}

The integration type is "${candidate.integrationType}" — generate the spec in the corresponding format.
${candidate.integrationType === "code_patch" ? "Identify which existing files should be modified and what changes are needed." : ""}
${candidate.integrationType === "skill_file" ? "Describe the skill/knowledge content that should be created." : ""}`,
      },
    ],
  });

  const raw = response.content
    .replace(/```json\s*/g, "")
    .replace(/```\s*/g, "")
    .trim();

  const parsed = JSON.parse(raw);

  // Validate and coerce the response
  const spec: FeatureSpecPayload = {
    id: `spec-${candidate.id.slice(0, 8)}`,
    type: parsed.type ?? candidate.capabilityType,
    integrationType: candidate.integrationType,
    description: parsed.description ?? candidate.proposedUse,
    targetFiles: Array.isArray(parsed.targetFiles) ? parsed.targetFiles : undefined,
    permissions: {
      network: { allow: parsed.permissions?.network?.allow ?? [] },
      filesystem: {
        read: parsed.permissions?.filesystem?.read ?? ["data/*"],
        write: parsed.permissions?.filesystem?.write ?? ["data/*"],
      },
    },
    events: {
      subscribes: parsed.events?.subscribes ?? [],
      publishes: parsed.events?.publishes ?? [],
    },
    riskLevel: ["low", "medium", "high", "critical"].includes(parsed.riskLevel)
      ? parsed.riskLevel
      : "medium",
    evals: Array.isArray(parsed.evals) && parsed.evals.length > 0
      ? parsed.evals.slice(0, 5)
      : [
          "Plugin loads without errors",
          "Plugin responds to subscribed events",
          "Plugin produces expected output",
        ],
    installLevel: ([1, 2, 3, 4] as number[]).includes(parsed.installLevel)
      ? (parsed.installLevel as FeatureInstallLevel)
      : (classifyInstallLevel({
          filesystem: specPermissions(parsed),
        }) as FeatureInstallLevel),
  };

  console.log(`[feature-spec-generator] LLM generated spec: ${spec.id} (type=${spec.type}, risk=${spec.riskLevel}, level=${spec.installLevel})`);
  return spec;
}

function specPermissions(parsed: any): { read: string[]; write: string[] } {
  return {
    read: parsed.permissions?.filesystem?.read ?? ["data/*"],
    write: parsed.permissions?.filesystem?.write ?? ["data/*"],
  };
}

// ===== Fallback spec generation =====

function generateFallbackSpec(candidate: FeatureCandidatePayload): FeatureSpecPayload {
  console.log(`[feature-spec-generator] Using fallback spec for candidate ${candidate.id} (integration=${candidate.integrationType})`);
  return {
    id: `spec-${candidate.id.slice(0, 8)}`,
    type: candidate.capabilityType,
    integrationType: candidate.integrationType,
    description: candidate.proposedUse || candidate.summary,
    targetFiles: candidate.integrationType === "code_patch" ? ["src/modules/agent-runtime.ts"] : undefined,
    permissions: {
      network: { allow: [] },
      filesystem: {
        read: ["data/feature_candidates"],
        write: ["data/feature_candidates"],
      },
    },
    events: {
      subscribes: ["feature.scout.requested"],
      publishes: ["feature.candidate.found"],
    },
    riskLevel: "medium",
    evals: [
      "Plugin loads without errors",
      "Plugin responds to subscribed events",
      "Plugin produces expected output",
    ],
    installLevel: classifyInstallLevel({
      filesystem: {
        read: ["data/feature_candidates"],
        write: ["data/feature_candidates"],
      },
    }) as FeatureInstallLevel,
  };
}

function generateFallbackSpecById(candidateId: string): FeatureSpecPayload {
  return generateFallbackSpec({
    id: candidateId,
    title: `Feature ${candidateId.slice(0, 8)}`,
    source: "github",
    url: "",
    summary: "Unknown feature candidate",
    capabilityType: "tool",
    integrationType: "code_patch",
    proposedUse: "Unknown",
    scores: {
      usefulness: 0.5,
      frequency: 0.5,
      integration: 0.5,
      security: 0.5,
      maintenance: 0.5,
      novelty: 0.5,
      overlap: 0.3,
    },
    status: "discovered",
  });
}
