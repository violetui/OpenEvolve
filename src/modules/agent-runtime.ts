import type { AgentModule } from "../core/module";
import type { LLMTaskType } from "../llm/types";

export const AgentRuntimeModule: AgentModule = {
  name: "agent-runtime",

  start(ctx) {
    Bun.serve({
      port: Number(process.env.PORT ?? 3000),

      async fetch(req) {
        const url = new URL(req.url);

        // Health check
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

        // Chat endpoint — now powered by LLM
        if (url.pathname === "/chat" && req.method === "POST") {
          const body = (await req.json()) as Record<string, unknown>;
          const message = String(body.message ?? "");

          const received = await ctx.bus.publish({
            type: "agent.message.received",
            source: "agent-runtime",
            payload: {
              message
            }
          });

          try {
            if (!message.trim()) {
              throw new Error("empty_user_message");
            }

            // Call LLM service
            const response = await ctx.llm.chat({
              taskType: "chat",
              messages: [
                {
                  role: "system",
                  content: "You are OpenEvolve, an event-driven self-evolving agent. You help users with software development, system monitoring, and automated repair tasks. Be concise and helpful."
                },
                {
                  role: "user",
                  content: message
                }
              ]
            });

            // Publish LLM events
            await ctx.bus.publish({
              type: "llm.chat.requested",
              source: "agent-runtime",
              correlationId: received.correlationId,
              causationId: received.id,
              payload: {
                taskType: "chat",
                modelId: response.modelId,
                messageCount: 2
              }
            });

            await ctx.bus.publish({
              type: "llm.chat.completed",
              source: "agent-runtime",
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
                fallbackUsed: response.fallbackUsed
              }
            });

            // Publish agent completion event
            await ctx.bus.publish({
              type: "agent.message.completed",
              source: "agent-runtime",
              correlationId: received.correlationId,
              causationId: received.id,
              payload: {
                message,
                result: response.content
              }
            });

            return Response.json({
              ok: true,
              result: response.content,
              meta: {
                model: response.modelName,
                provider: response.provider,
                tokens: response.usage?.totalTokens,
                durationMs: response.durationMs,
                fallbackUsed: response.fallbackUsed
              }
            });
          } catch (error) {
            await ctx.bus.publish({
              type: "agent.failure.reported",
              source: "agent-runtime",
              correlationId: received.correlationId,
              causationId: received.id,
              payload: {
                errorType: "runtime_error",
                message: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                userMessage: message
              }
            });

            // Publish LLM failure event
            await ctx.bus.publish({
              type: "llm.chat.failed",
              source: "agent-runtime",
              correlationId: received.correlationId,
              causationId: received.id,
              payload: {
                taskType: "chat",
                modelId: "unknown",
                error: error instanceof Error ? error.message : String(error)
              }
            });

            return Response.json(
              {
                ok: false,
                error: "agent_runtime_error"
              },
              { status: 500 }
            );
          }
        }

        // ===== LLM Management Endpoints =====

        // Get model status
        if (url.pathname === "/models" && req.method === "GET") {
          const status = ctx.llm.getStatus();
          return Response.json({ ok: true, ...status });
        }

        // Switch default model
        if (url.pathname === "/models/default" && req.method === "PUT") {
          const body = (await req.json()) as Record<string, unknown>;
          const modelId = String(body.modelId ?? "");

          const previousModelId = ctx.llm.getRegistry().getDefaultModelId();
          const result = ctx.llm.switchModel(modelId);

          if (result.success) {
            await ctx.bus.publish({
              type: "llm.model.switched",
              source: "agent-runtime",
              payload: {
                previousModelId,
                newModelId: modelId,
                switchedBy: "api"
              }
            });
          }

          return Response.json(result);
        }

        // Set route for a task type
        if (url.pathname === "/models/route" && req.method === "PUT") {
          const body = (await req.json()) as Record<string, unknown>;
          const taskType = String(body.taskType ?? "") as LLMTaskType;
          const modelId = String(body.modelId ?? "");

          const previousRoute = ctx.llm.getRouter().getRoute(taskType);
          const result = ctx.llm.setRoute(taskType, modelId);

          if (result.success) {
            await ctx.bus.publish({
              type: "llm.route.updated",
              source: "agent-runtime",
              payload: {
                taskType,
                previousModelId: previousRoute?.modelId ?? "none",
                newModelId: modelId
              }
            });
          }

          return Response.json(result);
        }

        // Check model availability
        if (url.pathname === "/models/check" && req.method === "POST") {
          const availability = await ctx.llm.checkAvailability();
          const result: Record<string, string> = {};
          for (const [id, status] of availability) {
            result[id] = status;
          }
          return Response.json({ ok: true, availability: result });
        }

        return new Response("Not found", { status: 404 });
      }
    });
  }
};
