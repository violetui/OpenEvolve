/**
 * LLM Service — Unified interface for all LLM operations
 *
 * This is the main entry point for the multi-model configuration layer.
 * It combines the ModelRegistry and ModelRouter to provide:
 * - Single chat() method with automatic routing and fallback
 * - Runtime model switching
 * - Usage tracking and logging
 * - EventBus integration via LLMBridgeModule
 */

import type {
  LLMRequest,
  LLMResponse,
  LLMModelConfig,
  LLMTaskType,
  LLMTaskRoute,
  LLMProviderType,
  LLMModelStatus,
  LLMConfigFile,
} from "./types";
import { ModelRegistry, createDefaultRegistry } from "./model-registry";
import { ModelRouter } from "./model-router";

export class LLMService {
  private registry: ModelRegistry;
  private router: ModelRouter;
  private requestCount = 0;
  private totalTokensUsed = 0;
  private totalCostUsd = 0;
  private onLog?: (message: string) => void;

  constructor(env: Record<string, string | undefined>, onLog?: (message: string) => void) {
    this.onLog = onLog;
    this.registry = createDefaultRegistry(env);
    this.router = new ModelRouter(this.registry);
    this.log("LLM Service initialized");
    this.log(`  Default model: ${this.registry.getDefaultModelId()}`);
    this.log(`  Available models: ${this.registry.getAvailableModels().map((m) => m.id).join(", ")}`);
  }

  // ===== Core API =====

  /**
   * Send a chat completion request with automatic routing and fallback
   */
  async chat(request: LLMRequest): Promise<LLMResponse> {
    this.requestCount++;
    const startTime = Date.now();

    // Resolve the target model
    const resolved = this.router.resolveModel(request);
    const { modelId, config, effectiveMaxTokens, effectiveTemperature, effectiveTopP } = resolved;

    this.log(`[${request.taskType}] -> ${modelId} (${config.model})`);

    // Try the primary model
    let response = await this.tryModel(modelId, config, request, {
      maxTokens: effectiveMaxTokens,
      temperature: effectiveTemperature,
      topP: effectiveTopP,
    });

    if (response) {
      const durationMs = Date.now() - startTime;
      this.trackUsage(response, config, durationMs, false);
      return { ...response, durationMs, fallbackUsed: false };
    }

    // Try fallback models
    const fallbackChain = this.router.getFallbackChain(modelId);
    this.log(`  Primary model failed, trying fallbacks: ${fallbackChain.join(" -> ")}`);

    for (const fallbackId of fallbackChain) {
      const fallbackConfig = this.registry.getModel(fallbackId);
      if (!fallbackConfig) continue;

      this.log(`  Trying fallback: ${fallbackId}`);
      response = await this.tryModel(fallbackId, fallbackConfig, request, {
        maxTokens: effectiveMaxTokens,
        temperature: effectiveTemperature,
        topP: effectiveTopP,
      });

      if (response) {
        const durationMs = Date.now() - startTime;
        this.trackUsage(response, fallbackConfig, durationMs, true);
        return { ...response, durationMs, fallbackUsed: true };
      }
    }

    // All models failed — return error response from fallback provider
    const durationMs = Date.now() - startTime;
    return {
      content: `[Error] All LLM models failed for task "${request.taskType}". Please check model availability.`,
      modelId: "error",
      modelName: "none",
      provider: "custom" as LLMProviderType,
      durationMs,
      fallbackUsed: true,
    };
  }

  /**
   * Try a specific model for a request
   */
  private async tryModel(
    modelId: string,
    config: LLMModelConfig,
    request: LLMRequest,
    params: {
      maxTokens?: number;
      temperature?: number;
      topP?: number;
    }
  ): Promise<LLMResponse | null> {
    const provider = this.registry.getProvider(config.provider);
    if (!provider) {
      this.log(`  No provider for ${config.provider}`);
      return null;
    }

    try {
      const result = await provider.chat({
        model: config.model,
        messages: request.messages,
        maxTokens: params.maxTokens,
        temperature: params.temperature,
        topP: params.topP,
      });

      return {
        content: result.content,
        modelId,
        modelName: config.model,
        provider: config.provider,
        usage: result.usage,
        durationMs: 0, // Will be set by caller
        fallbackUsed: false,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      this.log(`  Model ${modelId} failed: ${errMsg}`);

      // Mark model as potentially unavailable
      this.registry.setModelStatus(modelId, "error");

      return null;
    }
  }

  // ===== Runtime Configuration =====

  /**
   * Switch the default model at runtime
   */
  switchModel(modelId: string): { success: boolean; message: string } {
    const model = this.registry.getModel(modelId);
    if (!model) {
      return {
        success: false,
        message: `Model "${modelId}" not found. Available: ${this.registry.getAvailableModels().map((m) => m.id).join(", ")}`,
      };
    }

    const oldDefault = this.registry.getDefaultModelId();
    this.router.updateDefaultModel(oldDefault, modelId);
    this.registry.setDefaultModel(modelId);

    this.log(`Default model switched: ${oldDefault} -> ${modelId}`);
    return {
      success: true,
      message: `Default model switched to "${modelId}" (${model.name})`,
    };
  }

  /**
   * Set the route for a specific task type
   */
  setRoute(taskType: LLMTaskType, modelId: string, overrides?: LLMTaskRoute["overrides"]): { success: boolean; message: string } {
    const model = this.registry.getModel(modelId);
    if (!model) {
      return {
        success: false,
        message: `Model "${modelId}" not found`,
      };
    }

    this.router.setRoute({ taskType, modelId, overrides });
    this.log(`Route updated: ${taskType} -> ${modelId}`);
    return {
      success: true,
      message: `Route for "${taskType}" now uses "${modelId}"`,
    };
  }

  /**
   * Register a new model at runtime
   */
  addModel(config: LLMModelConfig): void {
    this.registry.registerModel(config);
    this.log(`Model registered: ${config.id} (${config.name})`);
  }

  /**
   * Remove a model at runtime
   */
  removeModel(modelId: string): boolean {
    const result = this.registry.unregisterModel(modelId);
    if (result) {
      this.log(`Model removed: ${modelId}`);
    }
    return result;
  }

  // ===== Load Configuration from File =====

  /**
   * Load configuration from an LLMConfigFile object
   */
  loadConfig(config: LLMConfigFile): void {
    // Register models
    for (const model of config.models) {
      this.registry.registerModel(model);
    }

    // Set default
    this.registry.setDefaultModel(config.defaultModelId);

    // Set fallbacks
    if (config.fallbackModelIds) {
      this.registry.setFallbackModels(config.fallbackModelIds);
    }

    // Set routes
    for (const route of config.routes) {
      this.router.setRoute(route);
    }

    this.log("Configuration loaded from file");
  }

  // ===== Status & Monitoring =====

  /**
   * Get current model status
   */
  getStatus(): {
    defaultModelId: string;
    models: Array<{ id: string; name: string; provider: string; status: LLMModelStatus }>;
    routes: Record<string, string>;
    fallbackChain: string[];
    usage: {
      totalRequests: number;
      totalTokens: number;
      estimatedCostUsd: number;
    };
  } {
    return {
      defaultModelId: this.registry.getDefaultModelId(),
      models: this.registry.getAllModels().map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        status: m.status,
      })),
      routes: this.router.getSummary(),
      fallbackChain: this.registry.getFallbackModelIds(),
      usage: {
        totalRequests: this.requestCount,
        totalTokens: this.totalTokensUsed,
        estimatedCostUsd: this.totalCostUsd,
      },
    };
  }

  /**
   * Check model availability
   */
  async checkAvailability(): Promise<Map<string, LLMModelStatus>> {
    return this.registry.checkAvailability();
  }

  /**
   * Get the underlying registry (for advanced use)
   */
  getRegistry(): ModelRegistry {
    return this.registry;
  }

  /**
   * Get the underlying router (for advanced use)
   */
  getRouter(): ModelRouter {
    return this.router;
  }

  // ===== Internal Helpers =====

  private trackUsage(
    response: LLMResponse,
    config: LLMModelConfig,
    durationMs: number,
    isFallback: boolean
  ): void {
    if (response.usage) {
      this.totalTokensUsed += response.usage.totalTokens;

      // Estimate cost
      if (config.costPer1kInput && config.costPer1kOutput) {
        const inputCost = (response.usage.promptTokens / 1000) * config.costPer1kInput;
        const outputCost = (response.usage.completionTokens / 1000) * config.costPer1kOutput;
        this.totalCostUsd += inputCost + outputCost;
      }
    }

    this.log(
      `  ${isFallback ? "[FALLBACK] " : ""}${response.modelId} completed in ${durationMs}ms` +
        (response.usage ? ` (${response.usage.totalTokens} tokens)` : "")
    );
  }

  private log(message: string): void {
    if (this.onLog) {
      this.onLog(message);
    }
  }
}
