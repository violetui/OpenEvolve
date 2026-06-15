/**
 * OpenAI Provider — LLM provider backed by the openai SDK
 *
 * Supports OpenAI-compatible APIs (OpenAI, DeepSeek, Anthropic via proxy, etc.)
 * by configuring baseURL and apiKey per model. Supports function calling (tools).
 */

import OpenAI from "openai";
import type { LLMProvider, LLMChatMessage, LLMToolCall, LLMTool } from "../types";

export class OpenAIProvider implements LLMProvider {
  readonly type = "openai" as const;

  async isAvailable(): Promise<boolean> {
    if (!process.env.OPENAI_API_KEY) return false;
    try {
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        baseURL: process.env.OPENAI_BASE_URL,
        timeout: 5000,
        maxRetries: 0,
      });
      const models = await client.models.list();
      return models.data.length > 0;
    } catch {
      return false;
    }
  }

  async chat(request: {
    model: string;
    messages: LLMChatMessage[];
    maxTokens?: number;
    temperature?: number;
    topP?: number;
    apiKey?: string;
    baseUrl?: string;
    tools?: LLMTool[];
    tool_choice?: "auto" | "none" | { type: "function"; function: { name: string } };
  }): Promise<{
    content: string;
    toolCalls?: LLMToolCall[];
    usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  }> {
    const apiKey = request.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY is not set (set via config.model[].apiKey or OPENAI_API_KEY env var)");
    }

    const client = new OpenAI({
      apiKey,
      baseURL: request.baseUrl ?? process.env.OPENAI_BASE_URL,
      timeout: 30000,
      maxRetries: 0,
    });

    const completion = await client.chat.completions.create({
      model: request.model,
      messages: request.messages as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
      ...(request.tools ? {
        tools: request.tools as OpenAI.Chat.Completions.ChatCompletionTool[],
        tool_choice: request.tool_choice as OpenAI.Chat.Completions.ChatCompletionToolChoiceOption | undefined ?? "auto",
      } : {}),
    });

    const choice = completion.choices[0];
    const msg = choice?.message;

    const messageContent = (msg?.content as string) ?? "";
    const toolCalls = msg?.tool_calls?.map((tc): LLMToolCall => {
      const fn = (tc as any).function;
      return {
        id: tc.id,
        type: "function" as const,
        function: {
          name: fn?.name ?? "",
          arguments: fn?.arguments ?? "{}",
        },
      };
    });

    const usage = completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens,
          completionTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
        }
      : undefined;

    return { content: messageContent, toolCalls, usage };
  }
}
