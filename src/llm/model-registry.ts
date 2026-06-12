/**
 * Model Registry — Manages available LLM models and their providers
 *
 * Responsibilities:
 * - Register and unregister model configurations
 * - Manage provider instances
 * - Track model availability status
 * - Support runtime model switching
 */

import type {
  LLMModelConfig,
  LLMProvider,
  LLMProviderType,
  LLMModelStatus,
} from "./types";
import { ZAIProvider } from "./providers/zai-provider";
import { FallbackProvider } from "./providers/fallback-provider";

export class ModelRegistry {
  private models = new Map<string, LLMModelConfig>();
  private providers = new Map<LLMProviderType, LLMProvider>();
  private defaultModelId: string;
  private fallbackModelIds: string[];

  constructor(initialModels?: LLMModelConfig[]) {
    // Register built-in providers
    this.registerProvider(new ZAIProvider());
    this.registerProvider(new FallbackProvider());

    // Default configuration
    this.defaultModelId = "fallback";
    this.fallbackModelIds = ["fallback"];

    // Register initial models
    if (initialModels) {
      for (const model of initialModels) {
        this.models.set(model.id, model);
      }
    }
  }

  // ===== Model Management =====

  /**
   * Register a new model configuration
   */
  registerModel(config: LLMModelConfig): void {
    this.models.set(config.id, config);

    // If this is the first model or marked as default, set as default
    if (config.isDefault || this.models.size === 1) {
      this.defaultModelId = config.id;
    }
  }

  /**
   * Unregister a model configuration
   */
  unregisterModel(modelId: string): boolean {
    if (!this.models.has(modelId)) return false;
    this.models.delete(modelId);

    // If we removed the default, pick a new one
    if (this.defaultModelId === modelId) {
      const first = this.models.keys().next();
      this.defaultModelId = first.done ? "fallback" : first.value;
    }

    // Remove from fallbacks
    this.fallbackModelIds = this.fallbackModelIds.filter((id) => id !== modelId);

    return true;
  }

  /**
   * Get a model configuration by ID
   */
  getModel(modelId: string): LLMModelConfig | undefined {
    return this.models.get(modelId);
  }

  /**
   * Get all registered model configurations
   */
  getAllModels(): LLMModelConfig[] {
    return [...this.models.values()];
  }

  /**
   * Get all available models
   */
  getAvailableModels(): LLMModelConfig[] {
    return [...this.models.values()].filter(
      (m) => m.status === "available"
    );
  }

  /**
   * Update model status
   */
  setModelStatus(modelId: string, status: LLMModelStatus): void {
    const model = this.models.get(modelId);
    if (model) {
      model.status = status;
    }
  }

  // ===== Default & Fallback =====

  /**
   * Set the default model ID
   */
  setDefaultModel(modelId: string): boolean {
    if (!this.models.has(modelId)) return false;
    // Clear previous default flag
    for (const [id, model] of this.models) {
      if (model.isDefault) {
        model.isDefault = false;
      }
    }
    this.defaultModelId = modelId;
    const model = this.models.get(modelId);
    if (model) model.isDefault = true;
    return true;
  }

  /**
   * Get the default model ID
   */
  getDefaultModelId(): string {
    return this.defaultModelId;
  }

  /**
   * Set fallback model IDs (tried in order when primary fails)
   */
  setFallbackModels(modelIds: string[]): void {
    this.fallbackModelIds = modelIds.filter((id) => this.models.has(id));
    // Always include fallback provider as last resort
    if (!this.fallbackModelIds.includes("fallback")) {
      this.fallbackModelIds.push("fallback");
    }
  }

  /**
   * Get fallback model IDs
   */
  getFallbackModelIds(): string[] {
    return [...this.fallbackModelIds];
  }

  // ===== Provider Management =====

  /**
   * Register a provider instance
   */
  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.type, provider);
  }

  /**
   * Get a provider by type
   */
  getProvider(providerType: LLMProviderType): LLMProvider | undefined {
    return this.providers.get(providerType);
  }

  /**
   * Get the provider for a specific model
   */
  getProviderForModel(modelId: string): LLMProvider | undefined {
    const model = this.models.get(modelId);
    if (!model) return undefined;
    return this.providers.get(model.provider);
  }

  // ===== Health Check =====

  /**
   * Check availability of all models and update their status
   */
  async checkAvailability(): Promise<Map<string, LLMModelStatus>> {
    const results = new Map<string, LLMModelStatus>();

    for (const [id, model] of this.models) {
      if (id === "fallback") {
        model.status = "available";
        results.set(id, "available");
        continue;
      }

      const provider = this.providers.get(model.provider);
      if (!provider) {
        model.status = "unavailable";
        results.set(id, "unavailable");
        continue;
      }

      try {
        const available = await provider.isAvailable();
        model.status = available ? "available" : "unavailable";
        results.set(id, model.status);
      } catch {
        model.status = "error";
        results.set(id, "error");
      }
    }

    return results;
  }

  // ===== Summary =====

  /**
   * Get a summary of the registry state
   */
  getSummary(): {
    totalModels: number;
    availableModels: number;
    defaultModelId: string;
    fallbackModelIds: string[];
    providers: LLMProviderType[];
  } {
    return {
      totalModels: this.models.size,
      availableModels: this.getAvailableModels().length,
      defaultModelId: this.defaultModelId,
      fallbackModelIds: [...this.fallbackModelIds],
      providers: [...this.providers.keys()],
    };
  }
}

// ===== Default Configuration Factory =====

/**
 * Create a ModelRegistry with default model configurations
 * based on environment variables
 */
export function createDefaultRegistry(env: Record<string, string | undefined>): ModelRegistry {
  const registry = new ModelRegistry();

  // Always register the fallback model
  registry.registerModel({
    id: "fallback",
    name: "Fallback Provider (Mock)",
    provider: "custom",
    model: "fallback",
    isDefault: false,
    status: "available",
    priority: 999,
  });

  // Register ZAI models if SDK is available
  // The ZAI provider supports multiple models through the same SDK
  const zaiModels: LLMModelConfig[] = [
    {
      id: "deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      provider: "zai",
      model: "deepseek-v4-pro",
      maxTokens: 8192,
      temperature: 0.7,
      isDefault: true,
      status: "available",
      costPer1kInput: 0.002,
      costPer1kOutput: 0.008,
      priority: 1,
    },
    {
      id: "gpt-4o",
      name: "GPT-4o",
      provider: "zai",
      model: "gpt-4o",
      maxTokens: 4096,
      temperature: 0.7,
      isDefault: false,
      status: "available",
      costPer1kInput: 0.005,
      costPer1kOutput: 0.015,
      priority: 2,
    },
    {
      id: "gpt-4o-mini",
      name: "GPT-4o Mini",
      provider: "zai",
      model: "gpt-4o-mini",
      maxTokens: 4096,
      temperature: 0.7,
      isDefault: false,
      status: "available",
      costPer1kInput: 0.00015,
      costPer1kOutput: 0.0006,
      priority: 3,
    },
    {
      id: "claude-3.5-sonnet",
      name: "Claude 3.5 Sonnet",
      provider: "zai",
      model: "claude-3.5-sonnet",
      maxTokens: 8192,
      temperature: 0.7,
      isDefault: false,
      status: "available",
      costPer1kInput: 0.003,
      costPer1kOutput: 0.015,
      priority: 2,
    },
    {
      id: "deepseek-r1",
      name: "DeepSeek R1 (Reasoning)",
      provider: "zai",
      model: "deepseek-r1",
      maxTokens: 16384,
      temperature: 0.5,
      isDefault: false,
      status: "available",
      costPer1kInput: 0.004,
      costPer1kOutput: 0.016,
      priority: 2,
    },
  ];

  // Register ZAI models
  for (const model of zaiModels) {
    registry.registerModel(model);
  }

  // Override default model from env if specified
  const envDefaultModel = env.LLM_DEFAULT_MODEL;
  if (envDefaultModel) {
    registry.setDefaultModel(envDefaultModel);
  }

  // Set fallback chain
  registry.setFallbackModels([
    "deepseek-v4-pro",
    "gpt-4o",
    "gpt-4o-mini",
  ]);

  return registry;
}
