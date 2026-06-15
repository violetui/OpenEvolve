import type { AgentModule } from "../core/module";
import type { EventBus } from "../core/event-bus";
import type { LLMService } from "../llm";
import type { LLMTaskType, LLMChatMessage } from "../llm/types";
import { AGENT_TOOLS, executeTool } from "./tools";

const SYSTEM_PROMPT = `You are OpenEvolve, an event-driven self-evolving agent. You help users with software development, system monitoring, and automated repair tasks. Be concise and helpful.

You have access to the following tools:
- file_read, file_write, file_edit: Read, write, and edit files
- bash: Execute shell commands (sandboxed, time-limited)
- glob, grep: Find files and search content within them
- browser_search, browser_fetch, browser_screenshot: Web browsing and information retrieval`;

// ===== Chat Handler with Tool Loop =====

async function handleChat(input: {
  bus: EventBus;
  llm: LLMService;
  message: string;
  source: string;
}) {
  const { bus, llm, message } = input;

  const received = await bus.publish({
    type: "agent.message.received",
    source: input.source,
    payload: { message },
  });

  if (!message.trim()) {
    throw new Error("empty_user_message");
  }

  // Build conversation history
  const messages: LLMChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: message },
  ];

  // Tool calling loop
  let finalContent = "";
  let lastResponse: Awaited<ReturnType<typeof llm.chat>> | null = null;

  for (let iteration = 0; iteration < 5; iteration++) {
    const response = await llm.chat({
      taskType: "chat",
      messages,
      tools: AGENT_TOOLS,
      tool_choice: "auto",
    });

    lastResponse = response;

    // Publish LLM events
    await bus.publish({
      type: "llm.chat.requested",
      source: input.source,
      correlationId: received.correlationId,
      causationId: received.id,
      payload: { taskType: "chat", modelId: response.modelId, messageCount: messages.length },
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
          toolResult = await executeTool(bus, tc.function.name, args);
        } catch (err) {
          toolResult = `Error: ${err instanceof Error ? err.message : String(err)}`;
        }

        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolResult,
        });
      }
    } else {
      // Final response
      finalContent = response.content;

      await bus.publish({
        type: "llm.chat.completed",
        source: input.source,
        correlationId: received.correlationId,
        causationId: received.id,
        payload: {
          taskType: "chat",
          modelId: response.modelId,
          modelName: response.modelName,
          provider: response.provider,
          content: response.content,
          durationMs: response.durationMs,
          tokensUsed: response.usage?.totalTokens,
          fallbackUsed: response.fallbackUsed,
        },
      });

      await bus.publish({
        type: "agent.message.completed",
        source: input.source,
        correlationId: received.correlationId,
        causationId: received.id,
        payload: { message, result: finalContent },
      });

      return response;
    }
  }

  // Max iterations exceeded — return last response
  finalContent = lastResponse?.content ?? "Tool execution limit reached.";

  await bus.publish({
    type: "llm.chat.completed",
    source: input.source,
    correlationId: received.correlationId,
    payload: {
      taskType: "chat",
      modelId: lastResponse?.modelId ?? "unknown",
      modelName: lastResponse?.modelName ?? "unknown",
      provider: lastResponse?.provider ?? "openai",
      content: finalContent,
      durationMs: lastResponse?.durationMs ?? 0,
      tokensUsed: lastResponse?.usage?.totalTokens,
      fallbackUsed: lastResponse?.fallbackUsed ?? false,
    },
  });

  await bus.publish({
    type: "agent.message.completed",
    source: input.source,
    correlationId: received.correlationId,
    causationId: received.id,
    payload: { message, result: finalContent },
  });

  return lastResponse!;
}

// ===== Module =====

export const AgentRuntimeModule: AgentModule = {
  name: "agent-runtime",

  start(ctx) {
    ctx.bus.subscribe("agent.message.received", async (event) => {
      if (event.source === "agent-runtime") return;

      try {
        await handleChat({
          bus: ctx.bus,
          llm: ctx.llm,
          message: event.payload.message,
          source: "agent-runtime",
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "agent.failure.reported",
          source: "agent-runtime",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            errorType: "runtime_error",
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            userMessage: event.payload.message,
          },
        });
        await ctx.bus.publish({
          type: "llm.chat.failed",
          source: "agent-runtime",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: { taskType: "chat", modelId: "unknown", error: error instanceof Error ? error.message : String(error) },
        });
      }
    });

    Bun.serve({
      port: Number(process.env.PORT ?? 3000),

      async fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/health") {
          return Response.json({
            ok: true,
            version: process.env.AGENT_VERSION ?? "dev",
            llm: {
              defaultModel: ctx.llm.getRegistry().getDefaultModelId(),
              availableModels: ctx.llm.getRegistry().getAvailableModels().map((m) => m.id),
            },
          });
        }

        if (url.pathname === "/chat" && req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const message = String(body.message ?? "");

          try {
            const response = await handleChat({
              bus: ctx.bus, llm: ctx.llm, message, source: "agent-runtime",
            });
            return Response.json({
              ok: true,
              result: response.content,
              meta: { model: response.modelName, provider: response.provider, tokens: response.usage?.totalTokens, durationMs: response.durationMs, fallbackUsed: response.fallbackUsed },
            });
          } catch (error) {
            return Response.json({ ok: false, error: "agent_runtime_error" }, { status: 500 });
          }
        }

        if (url.pathname === "/models" && req.method === "GET") {
          const status = ctx.llm.getStatus();
          return Response.json({ ok: true, ...status });
        }

        if (url.pathname === "/models/default" && req.method === "PUT") {
          const body = (await req.json()) as Record<string, unknown>;
          const modelId = String(body.modelId ?? "");
          const previousModelId = ctx.llm.getRegistry().getDefaultModelId();
          const result = ctx.llm.switchModel(modelId);
          if (result.success) {
            await ctx.bus.publish({ type: "llm.model.switched", source: "agent-runtime", payload: { previousModelId, newModelId: modelId, switchedBy: "api" } });
          }
          return Response.json(result);
        }

        if (url.pathname === "/models/route" && req.method === "PUT") {
          const body = (await req.json()) as Record<string, unknown>;
          const taskType = String(body.taskType ?? "") as LLMTaskType;
          const modelId = String(body.modelId ?? "");
          const previousRoute = ctx.llm.getRouter().getRoute(taskType);
          const result = ctx.llm.setRoute(taskType, modelId);
          if (result.success) {
            await ctx.bus.publish({ type: "llm.route.updated", source: "agent-runtime", payload: { taskType, previousModelId: previousRoute?.modelId ?? "none", newModelId: modelId } });
          }
          return Response.json(result);
        }

        if (url.pathname === "/models/check" && req.method === "POST") {
          const availability = await ctx.llm.checkAvailability();
          const result: Record<string, string> = {};
          for (const [id, status] of availability) { result[id] = status; }
          return Response.json({ ok: true, availability: result });
        }

        return new Response("Not found", { status: 404 });
      },
    });
  },
};
