/**
 * Model Router — Routes LLM requests to appropriate models based on task type
 *
 * Responsibilities:
 * - Map task types to model IDs via configurable routing rules
 * - Apply task-specific parameter overrides
 * - Support runtime route changes
 * - Fall back through the model chain on failure
 */

import type {
  LLMTaskType,
  LLMTaskRoute,
  LLMModelConfig,
  LLMRequest,
} from "./types";
import type { ModelRegistry } from "./model-registry";

export class ModelRouter {
  private routes = new Map<LLMTaskType, LLMTaskRoute>();
  private registry: ModelRegistry;

  constructor(registry: ModelRegistry, initialRoutes?: LLMTaskRoute[]) {
    this.registry = registry;

    // Register default routes
    const defaultRoutes: LLMTaskRoute[] = [
      {
        taskType: "chat",
        modelId: registry.getDefaultModelId(),
        overrides: { temperature: 0.7 },
      },
      {
        taskType: "patch_generate",
        modelId: registry.getDefaultModelId(),
        overrides: { temperature: 0.3, maxTokens: 8192 },
      },
      {
        taskType: "feature_analyze",
        modelId: registry.getDefaultModelId(),
        overrides: { temperature: 0.5 },
      },
      {
        taskType: "spec_generate",
        modelId: registry.getDefaultModelId(),
        overrides: { temperature: 0.4, maxTokens: 4096 },
      },
      {
        taskType: "prototype_build",
        modelId: registry.getDefaultModelId(),
        overrides: { temperature: 0.3, maxTokens: 8192 },
      },
      {
        taskType: "code_review",
        modelId: registry.getDefaultModelId(),
        overrides: { temperature: 0.3 },
      },
      {
        taskType: "summarize",
        modelId: "gpt-4o-mini",
        overrides: { temperature: 0.5, maxTokens: 2048 },
      },
      {
        taskType: "embedding",
        modelId: "gpt-4o-mini",
      },
    ];

    const routesToRegister = initialRoutes ?? defaultRoutes;
    for (const route of routesToRegister) {
      this.routes.set(route.taskType, route);
    }
  }

  // ===== Route Management =====

  /**
   * Set or update a route
   */
  setRoute(route: LLMTaskRoute): void {
    this.routes.set(route.taskType, route);
  }

  /**
   * Remove a route
   */
  removeRoute(taskType: LLMTaskType): boolean {
    return this.routes.delete(taskType);
  }

  /**
   * Get the route for a task type
   */
  getRoute(taskType: LLMTaskType): LLMTaskRoute | undefined {
    return this.routes.get(taskType);
  }

  /**
   * Get all routes
   */
  getAllRoutes(): LLMTaskRoute[] {
    return [...this.routes.values()];
  }

  /**
   * Update all routes to point to a new default model
   */
  updateDefaultModel(oldDefaultId: string, newModelId: string): void {
    for (const [taskType, route] of this.routes) {
      // Only update routes that use the old default
      // (preserves routes explicitly set to specific models)
      if (route.modelId === oldDefaultId) {
        this.routes.set(taskType, { ...route, modelId: newModelId });
      }
    }
  }

  // ===== Routing Logic =====

  /**
   * Resolve the model and parameters for a request
   */
  resolveModel(request: LLMRequest): {
    modelId: string;
    config: LLMModelConfig;
    effectiveMaxTokens?: number;
    effectiveTemperature?: number;
    effectiveTopP?: number;
  } {
    // 1. Explicit model override takes highest priority
    if (request.modelId) {
      const config = this.registry.getModel(request.modelId);
      if (config) {
        return {
          modelId: request.modelId,
          config,
          effectiveMaxTokens: request.maxTokens ?? config.maxTokens,
          effectiveTemperature: request.temperature ?? config.temperature,
          effectiveTopP: config.topP,
        };
      }
    }

    // 2. Check task route
    const route = this.routes.get(request.taskType);
    if (route) {
      const config = this.registry.getModel(route.modelId);
      if (config) {
        return {
          modelId: route.modelId,
          config,
          effectiveMaxTokens:
            request.maxTokens ?? route.overrides?.maxTokens ?? config.maxTokens,
          effectiveTemperature:
            request.temperature ?? route.overrides?.temperature ?? config.temperature,
          effectiveTopP: route.overrides?.topP ?? config.topP,
        };
      }
    }

    // 3. Fall back to default model
    const defaultId = this.registry.getDefaultModelId();
    const defaultConfig = this.registry.getModel(defaultId);
    if (defaultConfig) {
      return {
        modelId: defaultId,
        config: defaultConfig,
        effectiveMaxTokens: request.maxTokens ?? defaultConfig.maxTokens,
        effectiveTemperature: request.temperature ?? defaultConfig.temperature,
        effectiveTopP: defaultConfig.topP,
      };
    }

    // 4. Ultimate fallback
    const fallbackConfig = this.registry.getModel("fallback");
    return {
      modelId: "fallback",
      config: fallbackConfig ?? {
        id: "fallback",
        name: "Fallback",
        provider: "custom",
        model: "fallback",
        status: "available",
      },
      effectiveMaxTokens: request.maxTokens,
      effectiveTemperature: request.temperature,
    };
  }

  /**
   * Get the fallback chain for a model
   * Returns model IDs to try in order after the primary fails
   */
  getFallbackChain(primaryModelId: string): string[] {
    const chain: string[] = [];
    const fallbackIds = this.registry.getFallbackModelIds();

    // Add other fallback models (skip the primary)
    for (const id of fallbackIds) {
      if (id !== primaryModelId) {
        const model = this.registry.getModel(id);
        if (model && model.status === "available") {
          chain.push(id);
        }
      }
    }

    // Always end with the fallback provider
    if (!chain.includes("fallback")) {
      chain.push("fallback");
    }

    return chain;
  }

  /**
   * Get a summary of the routing state
   */
  getSummary(): Record<LLMTaskType, string> {
    const result = {} as Record<LLMTaskType, string>;
    for (const [taskType, route] of this.routes) {
      result[taskType] = route.modelId;
    }
    return result;
  }
}
