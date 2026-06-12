/**
 * ZAI Provider — LLM provider backed by z-ai-web-dev-sdk
 *
 * Uses the z-ai-web-dev-sdk to provide chat completions through
 * the ZAI platform, supporting models like deepseek-v4-pro, GPT-4, etc.
 */

import type { LLMProvider, LLMChatMessage } from "../types";

// Lazy-loaded ZAI instance
let zaiInstance: any = null;

async function getZAI(): Promise<any> {
  if (!zaiInstance) {
    const ZAI = (await import("z-ai-web-dev-sdk")).default;
    zaiInstance = await ZAI.create();
  }
  return zaiInstance;
}

export class ZAIProvider implements LLMProvider {
  readonly type = "zai" as const;

  async isAvailable(): Promise<boolean> {
    try {
      const zai = await getZAI();
      return !!zai;
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
  }): Promise<{
    content: string;
    usage?: {
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
    };
  }> {
    const zai = await getZAI();

    const completion = await zai.chat.completions.create({
      model: request.model,
      messages: request.messages.map((m) => ({
        role: m.role,
        content: m.content,
        ...(m.name ? { name: m.name } : {}),
      })),
      ...(request.maxTokens ? { max_tokens: request.maxTokens } : {}),
      ...(request.temperature !== undefined
        ? { temperature: request.temperature }
        : {}),
      ...(request.topP !== undefined ? { top_p: request.topP } : {}),
    });

    const messageContent = completion.choices?.[0]?.message?.content ?? "";
    const usage = completion.usage
      ? {
          promptTokens: completion.usage.prompt_tokens ?? 0,
          completionTokens: completion.usage.completion_tokens ?? 0,
          totalTokens: completion.usage.total_tokens ?? 0,
        }
      : undefined;

    return {
      content: messageContent,
      usage,
    };
  }
}
