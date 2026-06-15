import { $ } from "bun";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentModule } from "../core/module";
import type { FeatureIntegrationType } from "../core/event-types";

/**
 * FeatureEvaluator Module
 *
 * Subscribes to feature.prototype.created
 * Routes evaluation based on integration type:
 * - plugin:     structure check + code review + bun test
 * - code_patch: validate changes.json + LLM review of changes
 * - skill_file: validate skill.md + LLM content review
 * Publishes feature.eval.passed or feature.eval.failed
 */
export const FeatureEvaluatorModule: AgentModule = {
  name: "feature-evaluator",

  start(ctx) {
    ctx.bus.subscribe("feature.prototype.created", async (event) => {
      const { candidateId, workspace, pluginName } = event.payload;

      // Determine integration type from spec
      let integrationType: FeatureIntegrationType = "plugin";
      try {
        const specRaw = await readFile(join(workspace, "spec.json"), "utf8");
        const spec = JSON.parse(specRaw);
        integrationType = spec.integrationType ?? "plugin";
      } catch {
        // Default to plugin evaluation
      }

      console.log(`[feature-evaluator] Evaluating candidate ${candidateId} (type=${integrationType})`);

      await ctx.bus.publish({
        type: "feature.eval.requested",
        source: "feature-evaluator",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: { candidateId, workspace },
      });

      const checks: string[] = [];
      const failures: string[] = [];

      try {
        if (integrationType === "code_patch") {
          await evaluateCodePatch(workspace, ctx.llm, pluginName, checks, failures);
        } else if (integrationType === "skill_file") {
          await evaluateSkillFile(workspace, ctx.llm, pluginName, checks, failures);
        } else {
          await evaluatePlugin(workspace, ctx.llm, pluginName, checks, failures);
        }

        if (failures.length === 0) {
          await ctx.bus.publish({
            type: "feature.eval.passed",
            source: "feature-evaluator",
            correlationId: event.correlationId,
            causationId: event.id,
            payload: { candidateId, workspace, checks },
          });
        } else {
          await ctx.bus.publish({
            type: "feature.eval.failed",
            source: "feature-evaluator",
            correlationId: event.correlationId,
            causationId: event.id,
            payload: { candidateId, workspace, reason: failures.join("; ") },
          });
        }
      } catch (error) {
        await ctx.bus.publish({
          type: "feature.eval.failed",
          source: "feature-evaluator",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            candidateId,
            workspace,
            reason: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
  },
};

// ===== Plugin Evaluation =====

async function evaluatePlugin(
  workspace: string,
  llm: { chat: (req: any) => Promise<{ content: string }> },
  pluginName: string,
  checks: string[],
  failures: string[],
) {
  // Step 1: Read generated code
  const indexPath = join(workspace, "src", "index.ts");
  let pluginCode = "";
  try {
    pluginCode = await readFile(indexPath, "utf8");
  } catch {
    failures.push("Missing src/index.ts");
    return;
  }

  // Step 2: Structural quality check
  const structCheck = checkPluginStructure(pluginCode);
  if (structCheck.passed) {
    checks.push(`Structure: ${structCheck.message}`);
  } else {
    failures.push(`Structure: ${structCheck.message}`);
  }

  // Step 3: LLM code review
  try {
    const review = await reviewContentWithLLM(llm, pluginCode, pluginName, "plugin");
    if (review.passed) {
      checks.push(`Code review: ${review.message}`);
    } else {
      failures.push(`Code review: ${review.message}`);
    }
  } catch (err) {
    console.error(`[feature-evaluator] LLM review failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Step 4: Install deps + run tests
  try {
    await $`bun install`.cwd(workspace).quiet();
    checks.push("bun install passed");
  } catch (err) {
    failures.push(`bun install failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  try {
    await $`bun test`.cwd(workspace).quiet();
    checks.push("bun test passed");
  } catch (err) {
    failures.push(`bun test failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ===== Code Patch Evaluation =====

async function evaluateCodePatch(
  workspace: string,
  llm: { chat: (req: any) => Promise<{ content: string }> },
  pluginName: string,
  checks: string[],
  failures: string[],
) {
  let changesContent = "";
  try {
    changesContent = await readFile(join(workspace, "changes.json"), "utf8");
  } catch {
    failures.push("Missing changes.json");
    return;
  }

  let changes: Array<{ path: string; content: string }>;
  try {
    changes = JSON.parse(changesContent);
  } catch {
    failures.push("changes.json is not valid JSON");
    return;
  }

  if (!Array.isArray(changes) || changes.length === 0) {
    failures.push("changes.json contains no changes");
    return;
  }

  // Validate each change has path and content
  for (const c of changes) {
    if (!c.path || !c.content) {
      failures.push(`Change missing path or content: ${JSON.stringify(c).slice(0, 100)}`);
      return;
    }
    if (c.content.length < 50) {
      failures.push(`Change for ${c.path} is too short (< 50 chars) — likely empty`);
      return;
    }
  }

  checks.push(`Patch targets ${changes.length} file(s): ${changes.map((c) => c.path).join(", ")}`);

  // LLM review of the patch
  try {
    const review = await reviewContentWithLLM(
      llm,
      changes.map((c) => `### ${c.path}\n\`\`\`\n${c.content.slice(0, 1500)}\n\`\`\``).join("\n\n"),
      pluginName,
      "code_patch",
    );
    if (review.passed) {
      checks.push(`Patch review: ${review.message}`);
    } else {
      failures.push(`Patch review: ${review.message}`);
    }
  } catch (err) {
    console.error(`[feature-evaluator] LLM review failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ===== Skill File Evaluation =====

async function evaluateSkillFile(
  workspace: string,
  llm: { chat: (req: any) => Promise<{ content: string }> },
  pluginName: string,
  checks: string[],
  failures: string[],
) {
  let skillContent = "";
  try {
    skillContent = await readFile(join(workspace, "skill.md"), "utf8");
  } catch {
    failures.push("Missing skill.md");
    return;
  }

  if (skillContent.length < 100) {
    failures.push(`Skill content too short (${skillContent.length} chars)`);
    return;
  }

  checks.push(`Skill file has ${skillContent.split("\n").length} lines`);

  // LLM review of skill content
  try {
    const review = await reviewContentWithLLM(llm, skillContent, pluginName, "skill_file");
    if (review.passed) {
      checks.push(`Skill review: ${review.message}`);
    } else {
      failures.push(`Skill review: ${review.message}`);
    }
  } catch (err) {
    console.error(`[feature-evaluator] LLM review failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ===== Structure check for plugins =====

function checkPluginStructure(code: string): { passed: boolean; message: string } {
  if (!code || code.length < 100) {
    return { passed: false, message: "Code is too short (< 100 chars) — likely empty shell" };
  }

  const lines = code.split("\n");
  const nonTrivialLines = lines.filter(
    (l) =>
      l.trim() &&
      !l.trim().startsWith("//") &&
      !l.trim().startsWith("/*") &&
      !l.trim().startsWith("*") &&
      !l.trim().startsWith("console.log") &&
      !l.trim().startsWith("import ") &&
      !l.trim().startsWith("export default") &&
      !l.match(/^\s*[\}\]\),]/),
  );

  if (nonTrivialLines.length < 5) {
    return { passed: false, message: `Only ${nonTrivialLines.length} non-trivial lines — no real logic` };
  }

  if (!code.includes("satisfies AgentPlugin") && !code.includes("export default {")) {
    return { passed: false, message: "Missing AgentPlugin interface or export" };
  }

  return { passed: true, message: `${nonTrivialLines.length} lines of logic, valid structure` };
}

// ===== LLM Content Review (unified for all types) =====

const REVIEW_PROMPTS: Record<string, string> = {
  plugin: `You are a code reviewer. Review this plugin code and determine if it is genuinely useful.
FAIL: only console.log, empty handlers, no observable behavior, placeholder/stub.
PASS: meaningful logic, publishes events, does real work.
Respond JSON: {"passed": true/false, "message": "under 100 chars"}`,

  code_patch: `You are a code reviewer. Review these file changes and determine if they are genuinely useful improvements.
FAIL: trivial changes, no real improvement, placeholder content, broken code, removes functionality.
PASS: adds meaningful functionality, fixes real issues, improves code quality.
Respond JSON: {"passed": true/false, "message": "under 100 chars"}`,

  skill_file: `You are a content reviewer. Review this skill/knowledge file and determine if it is genuinely useful.
FAIL: vague, empty, no actionable content, generic filler text, placeholder.
PASS: specific, actionable, well-structured, contains real knowledge or instructions.
Respond JSON: {"passed": true/false, "message": "under 100 chars"}`,
};

async function reviewContentWithLLM(
  llm: { chat: (req: any) => Promise<{ content: string }> },
  content: string,
  name: string,
  contentType: string,
): Promise<{ passed: boolean; message: string }> {
  const snippet = content.length > 3000 ? content.slice(0, 3000) + "\n... (truncated)" : content;
  const prompt = REVIEW_PROMPTS[contentType] ?? REVIEW_PROMPTS["plugin"];

  const response = await llm.chat({
    taskType: "code_review",
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: `Review this ${contentType} "${name}":\n\n\`\`\`\n${snippet}\n\`\`\`` },
    ],
  });

  const raw = response.content.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(raw);

  return {
    passed: parsed.passed === true,
    message: parsed.message ?? (parsed.passed ? "Review passed" : "Review failed"),
  };
}
