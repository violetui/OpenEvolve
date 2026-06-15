import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentModule } from "../core/module";
import type { FeatureSpecPayload } from "../core/event-types";

/**
 * FeaturePrototypeBuilder Module
 *
 * Subscribes to feature.spec.generated
 * Uses LLM to generate a plugin implementation from the internal capability spec
 * Publishes feature.prototype.requested → feature.prototype.created
 */
export const FeaturePrototypeBuilderModule: AgentModule = {
  name: "feature-prototype-builder",

  start(ctx) {
    ctx.bus.subscribe("feature.spec.generated", async (event) => {
      const spec = event.payload.spec;

      console.log(`[feature-prototype-builder] Generating prototype for ${spec.id} (type=${spec.type}, risk=${spec.riskLevel})`);

      await ctx.bus.publish({
        type: "feature.prototype.requested",
        source: "feature-prototype-builder",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: event.payload.candidateId,
          spec,
        },
      });

      const workspace = await mkdtemp(join(tmpdir(), "feature-prototype-"));
      const pluginName = `feature-${event.payload.candidateId.slice(0, 8)}`;
      const files: string[] = [];

      const integrationType = spec.integrationType ?? "plugin";

      if (integrationType === "code_patch") {
        // Generate code changes for existing files
        let changes: Array<{ path: string; content: string }>;
        try {
          changes = await generatePatchWithLLM(ctx.llm, spec);
        } catch (err) {
          console.error(`[feature-prototype-builder] LLM patch generation failed: ${err instanceof Error ? err.message : String(err)}`);
          changes = generateFallbackPatch(spec);
        }

        const changesPath = join(workspace, "changes.json");
        await writeFile(changesPath, JSON.stringify(changes, null, 2), "utf8");
        files.push("changes.json");

      } else if (integrationType === "skill_file") {
        // Generate skill markdown content
        let skillContent: string;
        try {
          skillContent = await generateSkillWithLLM(ctx.llm, spec);
        } catch (err) {
          console.error(`[feature-prototype-builder] LLM skill generation failed: ${err instanceof Error ? err.message : String(err)}`);
          skillContent = generateFallbackSkill(spec);
        }

        const skillPath = join(workspace, "skill.md");
        await writeFile(skillPath, skillContent, "utf8");
        files.push("skill.md");

      } else {
        // Default: generate plugin code
        let pluginCode: string;
        let testCode: string;

        try {
          const generated = await generatePluginWithLLM(ctx.llm, spec, pluginName);
          pluginCode = generated.pluginCode;
          testCode = generated.testCode;
        } catch (err) {
          console.error(`[feature-prototype-builder] LLM plugin generation failed: ${err instanceof Error ? err.message : String(err)}`);
          pluginCode = generateFallbackPluginCode(spec, pluginName);
          testCode = generateFallbackTestCode(spec, pluginName);
        }

        const indexPath = join(workspace, "src", "index.ts");
        await mkdir(join(workspace, "src"), { recursive: true });
        await writeFile(indexPath, pluginCode, "utf8");
        files.push("src/index.ts");

        const packageJsonPath = join(workspace, "package.json");
        const packageJson = JSON.stringify({
          name: pluginName,
          version: "0.1.0",
          type: "module",
          main: "src/index.ts",
        }, null, 2);
        await writeFile(packageJsonPath, packageJson, "utf8");
        files.push("package.json");

        const testPath = join(workspace, "tests", "index.test.ts");
        await mkdir(join(workspace, "tests"), { recursive: true });
        await writeFile(testPath, testCode, "utf8");
        files.push("tests/index.test.ts");
      }

      // Save spec.json for later use by installer
      const specPath = join(workspace, "spec.json");
      await writeFile(specPath, JSON.stringify(spec, null, 2), "utf8");
      files.push("spec.json");

      await ctx.bus.publish({
        type: "feature.prototype.created",
        source: "feature-prototype-builder",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: event.payload.candidateId,
          workspace,
          pluginName,
          files,
        },
      });
    });
  },
};

// ===== LLM-based code generation =====

const PLUGIN_GEN_PROMPT = `You are a plugin code generator for a self-evolving AI agent system. Based on a capability specification, generate a complete TypeScript plugin implementation.

The agent system uses an event-driven architecture with EventBus. Plugins implement the AgentPlugin interface:

\`\`\`typescript
import type { AgentPlugin } from "../core/plugin";

export default {
  name: "plugin-name",
  version: "0.1.0",
  permissions: {
    subscribe: ["event.to.listen.to"],
    publish: ["event.to.emit"],
  },
  setup(ctx) {
    ctx.bus.subscribe("event.name", async (event) => {
      await ctx.bus.publish({
        type: "response.event",
        source: "plugin-name",
        payload: { ... }
      });
    });
  }
} satisfies AgentPlugin;
\`\`\`

CRITICAL: Do NOT generate plugins that only console.log. Implement real logic. Generate BOTH "pluginCode" and "testCode" in JSON.`;

const PATCH_GEN_PROMPT = `You are a code patch generator for a self-evolving AI agent system. Based on a capability specification, generate concrete changes to existing source files.

The system's key files:
- src/modules/agent-runtime.ts — Main chat handler with tool definitions and execution loop
- src/modules/browser-automation.ts — Playwright-based browser automation
- src/modules/scheduler.ts — Idle-time task scheduling
- src/modules/failure-miner.ts — Failure detection
- src/modules/patch-generator.ts — LLM-based patch generation
- src/modules/patch-applier.ts — Sandboxed patch application
- src/modules/evaluator.ts — Test/type/smoke evaluation
- src/modules/feature-analyzer.ts — External feature analysis
- src/modules/feature-spec-generator.ts — Capability spec generation
- src/modules/feature-prototype-builder.ts — Plugin code generation
- src/modules/feature-evaluator.ts — Plugin evaluation
- src/modules/plugin-installer.ts — Plugin installation

Respond with a JSON object containing an array of changes:
{
  "changes": [
    {
      "path": "src/modules/agent-runtime.ts",
      "content": "Complete new file content with the improvements applied"
    }
  ]
}

Each change must have the FULL file content (not diffs), since the system replaces entire files.
Only include files that actually need changes. Be precise and minimal.`;

const SKILL_GEN_PROMPT = `You are a skill/knowledge file generator for a self-evolving AI agent system. Based on a capability specification, generate a well-structured markdown skill file.

The skill file should contain knowledge, instructions, or prompt engineering guidance that improves the agent's capabilities. Format as markdown with clear sections.

Respond with a JSON object: { "skillContent": "# Skill Title\\n\\n..." }`;

async function generatePluginWithLLM(
  llm: { chat: (req: any) => Promise<{ content: string }> },
  spec: FeatureSpecPayload,
  pluginName: string,
): Promise<{ pluginCode: string; testCode: string }> {
  const response = await llm.chat({
    taskType: "prototype_build",
    messages: [
      { role: "system", content: PLUGIN_GEN_PROMPT },
      {
        role: "user",
        content: `Generate a plugin implementation for:

Plugin Name: ${pluginName}
Type: ${spec.type}
Description: ${spec.description}
Risk Level: ${spec.riskLevel}
Permissions: network=${JSON.stringify(spec.permissions.network?.allow ?? [])}, fs_read=${JSON.stringify(spec.permissions.filesystem?.read ?? [])}, fs_write=${JSON.stringify(spec.permissions.filesystem?.write ?? [])}
Events subscribe: ${JSON.stringify(spec.events.subscribes)}
Events publish: ${JSON.stringify(spec.events.publishes)}
Evauation criteria: ${spec.evals.join(", ")}`,
      },
    ],
  });

  return parsePluginResponse(response.content);
}

function parsePluginResponse(content: string): { pluginCode: string; testCode: string } {
  const raw = content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(raw);
  let pluginCode = stripCodeFences(parsed.pluginCode ?? "", "typescript");
  let testCode = stripCodeFences(parsed.testCode ?? "", "typescript");
  if (!pluginCode.includes("export default") || pluginCode.length < 100) {
    throw new Error("Generated plugin code is too short or missing export");
  }
  return { pluginCode, testCode };
}

async function generatePatchWithLLM(
  llm: { chat: (req: any) => Promise<{ content: string }> },
  spec: FeatureSpecPayload,
): Promise<Array<{ path: string; content: string }>> {
  const response = await llm.chat({
    taskType: "prototype_build",
    messages: [
      { role: "system", content: PATCH_GEN_PROMPT },
      {
        role: "user",
        content: `Generate code changes for:
Description: ${spec.description}
Target files: ${JSON.stringify(spec.targetFiles ?? [])}
Risk: ${spec.riskLevel}
Evals: ${spec.evals.join(", ")}

Return JSON with "changes" array containing {path, content} for each file to modify.`,
      },
    ],
  });

  const raw = response.content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(raw);
  const changes = parsed.changes ?? [];
  console.log(`[feature-prototype-builder] LLM generated patch for ${changes.length} file(s)`);
  return changes;
}

async function generateSkillWithLLM(
  llm: { chat: (req: any) => Promise<{ content: string }> },
  spec: FeatureSpecPayload,
): Promise<string> {
  const response = await llm.chat({
    taskType: "prototype_build",
    messages: [
      { role: "system", content: SKILL_GEN_PROMPT },
      {
        role: "user",
        content: `Generate a skill file for:
Description: ${spec.description}
Type: ${spec.type}
Evals: ${spec.evals.join(", ")}`,
      },
    ],
  });

  const raw = response.content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(raw);
  const content = parsed.skillContent ?? "";
  console.log(`[feature-prototype-builder] LLM generated skill (${content.split("\n").length} lines)`);
  return content;
}

function stripCodeFences(code: string, lang: string): string {
  let result = code.trim();
  const prefix = "```" + lang;
  if (result.startsWith(prefix)) {
    result = result.slice(prefix.length);
  } else if (result.startsWith("```ts")) {
    result = result.slice(5);
  } else if (result.startsWith("```")) {
    result = result.slice(3);
  }
  if (result.endsWith("```")) {
    result = result.slice(0, -3).trimEnd();
  }
  return result.trim();
}

// ===== Fallback code generation =====

function generateFallbackPluginCode(
  spec: FeatureSpecPayload,
  pluginName: string,
): string {
  console.log(`[feature-prototype-builder] Using fallback plugin code for ${pluginName}`);

  const subscribeList = spec.events.subscribes
    .map((e) => `    "${e}"`)
    .join(",\n");

  const publishList = spec.events.publishes
    .map((e) => `    "${e}"`)
    .join(",\n");

  const handlers = spec.events.subscribes
    .map(
      (eventName) =>
        `    ctx.bus.subscribe("${eventName}", async (event) => {\n` +
        `      if (event.source === "${pluginName}") return;\n` +
        `      console.log("[${pluginName}] Processing: ${eventName}");\n` +
        `      // TODO: Implement actual logic for ${spec.description}\n` +
        `    });`,
    )
    .join("\n\n");

  return `/**
 * ${spec.description}
 *
 * Type: ${spec.type}
 * Risk Level: ${spec.riskLevel}
 * Install Level: ${spec.installLevel}
 *
 * Auto-generated plugin prototype (fallback — LLM generation failed).
 * This is a skeleton that should be enhanced by the repair chain.
 */

import type { AgentPlugin } from "../core/plugin";

export default {
  name: "${pluginName}",
  version: "0.1.0",

  permissions: {
    subscribe: [
${subscribeList}
    ],
    publish: [
${publishList}
    ],
  },

  setup(ctx) {
${handlers}
  },
} satisfies AgentPlugin;
`;
}

function generateFallbackPatch(
  spec: FeatureSpecPayload,
): Array<{ path: string; content: string }> {
  const targetFiles = spec.targetFiles ?? ["src/modules/agent-runtime.ts"];
  console.log(`[feature-prototype-builder] Using fallback patch for target(s): ${targetFiles.join(", ")}`);
  return targetFiles.map((path) => ({
    path,
    content: `// [Proactive Patch] ${spec.description}\n// Target: ${path}\n// TODO: Apply specific changes for this improvement\n`,
  }));
}

function generateFallbackSkill(spec: FeatureSpecPayload): string {
  console.log(`[feature-prototype-builder] Using fallback skill for ${spec.id}`);
  return `# ${spec.type}: ${spec.description}\n\n## Overview\n${spec.description}\n\n## Evaluation Criteria\n${spec.evals.map((e, i) => `${i + 1}. ${e}`).join("\n")}\n\n## Instructions\nTODO: Add detailed skill instructions and knowledge.\n`;
}

function generateFallbackTestCode(
  spec: FeatureSpecPayload,
  pluginName: string,
): string {
  const evalTests = spec.evals
    .map(
      (evalItem, i) =>
        `  it("eval ${i + 1}: ${evalItem}", async () => {\n` +
        `    // TODO: Implement real test: ${evalItem}\n` +
        `    // This is a placeholder — the repair chain should enhance it\n` +
        `  });`,
    )
    .join("\n\n");

  return `import { describe, it } from "bun:test";

describe("${pluginName}", () => {
${evalTests}
});
`;
}
