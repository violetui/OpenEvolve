import type { AgentModule } from "../core/module";
import type { EventBus } from "../core/event-bus";
import type { LLMChatMessage } from "../llm/types";
import { AGENT_TOOLS, executeTool } from "./tools";

/**
 * SelfOptimizer — Unified Self-Improvement Agent
 *
 * Replaces the separate reactive (FailureMiner + PatchGenerator) and
 * proactive (ProactiveOptimizer) chains with a single LLM-powered agent
 * that has full tool access.
 *
 * Triggers:
 *   agent.failure.reported       → Reactive: fix a reported error
 *   proactive.optimization.triggered → Proactive: improve during idle
 *
 * Process (5 steps):
 *   1. READ    — Gather context: error details, log events, relevant files
 *   2. ANALYZE — Use tools (grep, glob, file_read, browser_search) to
 *                understand root cause and identify improvement opportunities
 *   3. EDIT    — Implement changes using file_write / file_edit
 *   4. VERIFY  — Check correctness with grep, bash (type check, tests)
 *   5. FINALIZE — Publish evolution.patch.proposed to trigger safe
 *                 apply → eval → release → deploy → restart
 */

const SYSTEM_PROMPT = `You are OpenEvolve's Self-Optimization Agent. Your job is to analyze problems and improve the system by editing code.

You have access to tools: file_read, file_write, file_edit, grep, glob, bash, browser_search, browser_fetch.

Follow this process strictly:

## Step 1: READ
Gather all context. Read relevant files. Search for related code patterns with grep/glob.
If you're responding to a failure, read the files mentioned in the error.
If this is proactive optimization, read key modules to find improvement opportunities.

## Step 2: ANALYZE
Based on what you've read, identify the root cause or optimization opportunity.
Use grep to find all affected code paths. Use browser_search if you need external
information (API docs, best practices, known issues).
Formulate a clear, specific plan for what to change.

## Step 3: EDIT
Make the changes. Use file_edit for targeted modifications (preferred) or file_write
for complete rewrites. Make MINIMAL changes — don't refactor unrelated code.
Write each change clearly so it can be reviewed.

## Step 4: VERIFY
Check your work:
- Use grep to confirm the changes are in place
- Use bash to run type checks (bun run tsc --noEmit) or tests (bun test)
- Verify the fix addresses the original issue

## Step 5: FINALIZE
State clearly what was changed and why. If the optimization is complete and correct,
say "OPTIMIZATION COMPLETE" on the final line. If you determine no changes are needed,
say "NO CHANGES NEEDED" on the final line.

CRITICAL RULES:
- ALWAYS read a file before editing it
- Make minimal, focused changes
- Verify changes actually address the issue
- If unsure, be honest and say so
- NEVER modify src/core/event-bus.ts or src/core/policy.ts (protected files)`;

export const SelfOptimizerModule: AgentModule = {
  name: "self-optimizer",

  start(ctx) {
    // Reactive: triggered by failures
    ctx.bus.subscribe("agent.failure.reported", (event) => {
      runOptimization(ctx.bus, ctx.llm, {
        trigger: "failure",
        failureInfo: {
          errorType: event.payload.errorType,
          message: event.payload.message,
          stack: event.payload.stack,
          userMessage: event.payload.userMessage,
        },
        correlationId: event.correlationId,
        causationId: event.id,
      });
    });

    // Proactive: triggered by scheduler during idle
    ctx.bus.subscribe("proactive.optimization.triggered", (event) => {
      runOptimization(ctx.bus, ctx.llm, {
        trigger: "proactive",
        correlationId: event.correlationId,
        causationId: event.id,
      });
    });
  },
};

// ===== Optimization Runner =====

interface OptimizationContext {
  trigger: "failure" | "proactive";
  failureInfo?: {
    errorType: string;
    message: string;
    stack?: string;
    userMessage?: string;
  };
  correlationId: string;
  causationId: string;
}

async function runOptimization(
  bus: EventBus,
  llm: { chat: (req: any) => Promise<{ content: string; toolCalls?: any[]; modelId: string; modelName: string; provider: string; durationMs: number; usage?: { totalTokens: number }; fallbackUsed: boolean }> },
  ctx: OptimizationContext,
) {
  const label = ctx.trigger === "failure" ? "Reactive (failure)" : "Proactive (idle)";
  console.log(`[self-optimizer] Starting: ${label}`);

  // Publish analysis event (for logging)
  await bus.publish({
    type: "evolution.analysis.requested",
    source: "self-optimizer",
    correlationId: ctx.correlationId,
    causationId: ctx.causationId,
    payload: { failureEventId: ctx.causationId },
  });

  // Build initial user message
  let userMessage: string;
  if (ctx.trigger === "failure" && ctx.failureInfo) {
    const fi = ctx.failureInfo;
    userMessage = `A failure was detected in the agent system:

Error Type: ${fi.errorType}
Error Message: ${fi.message}
${fi.userMessage ? `User Message: ${fi.userMessage}` : ""}
${fi.stack ? `Stack Trace:\n${fi.stack.slice(0, 1000)}` : ""}

Follow the 5-step process:
1. READ: Read the relevant source files to understand the code
2. ANALYZE: Use grep/glob to find related code, browser_search for solutions
3. EDIT: Make targeted file changes to fix the issue
4. VERIFY: Run type checks and tests to confirm the fix works
5. FINALIZE: Conclude with "OPTIMIZATION COMPLETE" if fixed, or "NO CHANGES NEEDED"`;
  } else {
    userMessage = `The system is idle. Perform a proactive optimization scan:

1. READ: Review key modules (src/modules/*.ts, src/llm/*.ts) for improvement opportunities
2. ANALYZE: Look for code quality issues, performance bottlenecks, missing error handling, or patterns that could be simplified. Use grep to find duplicated code. Use browser_search to check for better patterns or libraries.
3. EDIT: Make targeted improvements to the code
4. VERIFY: Run type checks and tests
5. FINALIZE: Conclude with "OPTIMIZATION COMPLETE" if improvements were made, or "NO CHANGES NEEDED" if the code is already in good shape`;
  }

  const messages: LLMChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: userMessage },
  ];

  // Tool calling loop — max 10 iterations for deeper analysis
  let finalContent = "";
  const filesEdited = new Set<string>();

  for (let iteration = 0; iteration < 10; iteration++) {
    let response;
    try {
      response = await llm.chat({
        taskType: "patch_generate",
        messages,
        tools: AGENT_TOOLS,
        tool_choice: "auto",
      });
    } catch (err) {
      console.error(`[self-optimizer] LLM call failed:`, err instanceof Error ? err.message : String(err));
      break;
    }

    await bus.publish({
      type: "llm.chat.requested",
      source: "self-optimizer",
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      payload: { taskType: "patch_generate", modelId: response.modelId, messageCount: messages.length },
    });

    if (response.toolCalls && response.toolCalls.length > 0) {
      // Append assistant message with tool calls
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: response.toolCalls,
      });

      // Execute each tool call
      for (const tc of response.toolCalls) {
        let toolResult: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          toolResult = await executeTool(bus, tc.function.name, args, "self-optimizer");
        } catch (err) {
          toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Track file edits/writes for later verification
        if (tc.function.name === "file_edit" || tc.function.name === "file_write") {
          try {
            const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
            const path = String(args.file_path ?? "");
            if (path) filesEdited.add(path);
          } catch { /* ignore parse errors */ }
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    } else {
      // Final response — no more tool calls
      finalContent = response.content;

      await bus.publish({
        type: "llm.chat.completed",
        source: "self-optimizer",
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        payload: {
          taskType: "patch_generate",
          modelId: response.modelId,
          modelName: response.modelName,
          provider: response.provider,
          content: finalContent.slice(0, 200),
          durationMs: response.durationMs,
          tokensUsed: response.usage?.totalTokens,
          fallbackUsed: response.fallbackUsed,
        },
      });

      break;
    }
  }

  // Check result
  const isComplete = finalContent.includes("OPTIMIZATION COMPLETE");
  const noChanges = finalContent.includes("NO CHANGES NEEDED");

  if (isComplete && filesEdited.size > 0) {
    console.log(`[self-optimizer] Optimization complete, ${filesEdited.size} file(s) edited: ${[...filesEdited].join(", ")}`);

    // Read the current content of each edited file and prepare a patch
    const changes: Array<{ path: string; operation: "replace_file"; content: string }> = [];
    for (const path of filesEdited) {
      try {
        const result = await executeTool(bus, "file_read", { file_path: path }, "self-optimizer");
        const parsed = JSON.parse(result);
        if (parsed.content) {
          changes.push({ path, operation: "replace_file", content: parsed.content });
        }
      } catch {
        console.error(`[self-optimizer] Could not read back ${path} for patch`);
      }
    }

    if (changes.length > 0) {
      await bus.publish({
        type: "evolution.patch.proposed",
        source: "self-optimizer",
        correlationId: ctx.correlationId,
        causationId: ctx.causationId,
        payload: {
          reason: `[SelfOptimizer] ${ctx.trigger === "failure" ? "Fix: " + (ctx.failureInfo?.message ?? "error").slice(0, 100) : "Proactive optimization"}`,
          risk: "low",
          changes,
        },
      });

      console.log(`[self-optimizer] Published patch with ${changes.length} file(s), flowing to PatchApplier → Evaluator → Release → Deploy`);
    }
  } else if (noChanges) {
    console.log(`[self-optimizer] Analysis complete — no changes needed`);
  } else {
    console.log(`[self-optimizer] Optimization ended without clear completion. Files edited: ${filesEdited.size}. Final response: ${finalContent.slice(0, 200)}`);
  }
}
