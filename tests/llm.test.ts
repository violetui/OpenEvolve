import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/core/event-bus";
import { LLMService } from "../src/llm";
import { ModelRegistry, createDefaultRegistry } from "../src/llm/model-registry";
import { ModelRouter } from "../src/llm/model-router";
import { FallbackProvider } from "../src/llm/providers/fallback-provider";
import type { LLMModelConfig, LLMTaskType, LLMRequest } from "../src/llm/types";

describe("LLM Model Registry", () => {
  it("should register and retrieve models", () => {
    const registry = new ModelRegistry();
    const model: LLMModelConfig = {
      id: "test-model",
      name: "Test Model",
      provider: "zai",
      model: "test-model-v1",
      status: "available",
    };

    registry.registerModel(model);

    const retrieved = registry.getModel("test-model");
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe("test-model");
    expect(retrieved!.name).toBe("Test Model");
  });

  it("should unregister models", () => {
    const registry = new ModelRegistry();
    registry.registerModel({
      id: "removable",
      name: "Removable",
      provider: "custom",
      model: "removable",
      status: "available",
    });

    expect(registry.getModel("removable")).toBeDefined();
    const result = registry.unregisterModel("removable");
    expect(result).toBe(true);
    expect(registry.getModel("removable")).toBeUndefined();
  });

  it("should set default model", () => {
    const registry = new ModelRegistry();
    registry.registerModel({
      id: "model-a",
      name: "Model A",
      provider: "zai",
      model: "model-a",
      isDefault: true,
      status: "available",
    });
    registry.registerModel({
      id: "model-b",
      name: "Model B",
      provider: "zai",
      model: "model-b",
      status: "available",
    });

    expect(registry.getDefaultModelId()).toBe("model-a");

    registry.setDefaultModel("model-b");
    expect(registry.getDefaultModelId()).toBe("model-b");
  });

  it("should manage fallback chain", () => {
    const registry = new ModelRegistry();
    registry.registerModel({
      id: "primary",
      name: "Primary",
      provider: "zai",
      model: "primary",
      status: "available",
    });
    registry.registerModel({
      id: "secondary",
      name: "Secondary",
      provider: "zai",
      model: "secondary",
      status: "available",
    });

    registry.setFallbackModels(["primary", "secondary"]);
    const fallbacks = registry.getFallbackModelIds();

    // Should include fallback as last resort
    expect(fallbacks).toContain("primary");
    expect(fallbacks).toContain("secondary");
    expect(fallbacks).toContain("fallback");
    expect(fallbacks[fallbacks.length - 1]).toBe("fallback");
  });

  it("should update model status", () => {
    const registry = new ModelRegistry();
    registry.registerModel({
      id: "changing",
      name: "Changing",
      provider: "zai",
      model: "changing",
      status: "available",
    });

    expect(registry.getModel("changing")!.status).toBe("available");
    registry.setModelStatus("changing", "error");
    expect(registry.getModel("changing")!.status).toBe("error");
  });

  it("should list all and available models", () => {
    const registry = new ModelRegistry();
    // Empty registry — no models registered by default, only providers
    expect(registry.getAllModels().length).toBe(0);

    registry.registerModel({
      id: "available-model",
      name: "Available",
      provider: "zai",
      model: "available",
      status: "available",
    });
    registry.registerModel({
      id: "unavailable-model",
      name: "Unavailable",
      provider: "zai",
      model: "unavailable",
      status: "unavailable",
    });

    expect(registry.getAllModels().length).toBe(2);
    expect(registry.getAvailableModels().length).toBe(1);
  });
});

describe("Model Router", () => {
  it("should route tasks to correct models", () => {
    const registry = createDefaultRegistry({});
    const router = new ModelRouter(registry);

    // Chat should route to default model
    const chatRoute = router.getRoute("chat");
    expect(chatRoute).toBeDefined();
    expect(chatRoute!.modelId).toBe(registry.getDefaultModelId());

    // Summarize should route to gpt-4o-mini (cheaper)
    const summarizeRoute = router.getRoute("summarize");
    expect(summarizeRoute).toBeDefined();
    expect(summarizeRoute!.modelId).toBe("gpt-4o-mini");
  });

  it("should resolve model with overrides", () => {
    const registry = createDefaultRegistry({});
    const router = new ModelRouter(registry);

    const request: LLMRequest = {
      taskType: "chat",
      messages: [{ role: "user", content: "hello" }],
    };

    const resolved = router.resolveModel(request);
    expect(resolved.modelId).toBeDefined();
    expect(resolved.config).toBeDefined();
  });

  it("should respect explicit model override in request", () => {
    const registry = createDefaultRegistry({});
    const router = new ModelRouter(registry);

    const request: LLMRequest = {
      taskType: "chat",
      messages: [{ role: "user", content: "hello" }],
      modelId: "gpt-4o-mini",
    };

    const resolved = router.resolveModel(request);
    expect(resolved.modelId).toBe("gpt-4o-mini");
  });

  it("should update routes", () => {
    const registry = createDefaultRegistry({});
    const router = new ModelRouter(registry);

    router.setRoute({
      taskType: "chat",
      modelId: "deepseek-r1",
      overrides: { temperature: 0.5 },
    });

    const route = router.getRoute("chat");
    expect(route!.modelId).toBe("deepseek-r1");
    expect(route!.overrides!.temperature).toBe(0.5);
  });

  it("should provide fallback chain", () => {
    const registry = createDefaultRegistry({});
    const router = new ModelRouter(registry);

    const chain = router.getFallbackChain("deepseek-v4-pro");
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[chain.length - 1]).toBe("fallback");
    // Should not include the primary model
    expect(chain).not.toContain("deepseek-v4-pro");
  });
});

describe("Fallback Provider", () => {
  it("should always be available", async () => {
    const provider = new FallbackProvider();
    const available = await provider.isAvailable();
    expect(available).toBe(true);
  });

  it("should return a response for chat", async () => {
    const provider = new FallbackProvider();
    const result = await provider.chat({
      model: "fallback",
      messages: [
        { role: "user", content: "Hello" },
      ],
    });

    expect(result.content).toBeDefined();
    expect(result.content.length).toBeGreaterThan(0);
    expect(result.usage).toBeDefined();
    expect(result.usage!.totalTokens).toBeGreaterThan(0);
  });

  it("should return task-specific responses", async () => {
    const provider = new FallbackProvider();
    const result = await provider.chat({
      model: "fallback",
      messages: [
        { role: "system", content: "You are a patch generator for self-healing." },
        { role: "user", content: "Generate a patch" },
      ],
    });

    expect(result.content).toContain("Fallback Provider");
  });
});

describe("LLM Service", () => {
  it("should initialize with default registry", () => {
    const service = new LLMService({});
    const status = service.getStatus();

    expect(status.defaultModelId).toBeDefined();
    expect(status.models.length).toBeGreaterThan(0);
    expect(status.routes).toBeDefined();
  });

  it("should complete a chat request using fallback", async () => {
    const service = new LLMService({});
    const response = await service.chat({
      taskType: "chat",
      messages: [
        { role: "user", content: "Hello, test message" },
      ],
    });

    expect(response.content).toBeDefined();
    expect(response.content.length).toBeGreaterThan(0);
    expect(response.modelId).toBeDefined();
    expect(response.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should switch default model at runtime", () => {
    const service = new LLMService({});

    const result = service.switchModel("gpt-4o");
    expect(result.success).toBe(true);

    const status = service.getStatus();
    expect(status.defaultModelId).toBe("gpt-4o");
  });

  it("should fail to switch to non-existent model", () => {
    const service = new LLMService({});

    const result = service.switchModel("non-existent-model");
    expect(result.success).toBe(false);
  });

  it("should set route for a task type", () => {
    const service = new LLMService({});

    const result = service.setRoute("chat", "deepseek-r1");
    expect(result.success).toBe(true);

    const route = service.getRouter().getRoute("chat");
    expect(route!.modelId).toBe("deepseek-r1");
  });

  it("should track usage statistics", async () => {
    const service = new LLMService({});

    await service.chat({
      taskType: "chat",
      messages: [{ role: "user", content: "test" }],
    });

    const status = service.getStatus();
    expect(status.usage.totalRequests).toBe(1);
  });

  it("should add and remove models at runtime", () => {
    const service = new LLMService({});

    service.addModel({
      id: "custom-model",
      name: "Custom Model",
      provider: "custom",
      model: "custom",
      status: "available",
    });

    const model = service.getRegistry().getModel("custom-model");
    expect(model).toBeDefined();
    expect(model!.name).toBe("Custom Model");

    const removed = service.removeModel("custom-model");
    expect(removed).toBe(true);
    expect(service.getRegistry().getModel("custom-model")).toBeUndefined();
  });

  it("should load configuration from file", () => {
    const service = new LLMService({});

    service.loadConfig({
      models: [
        {
          id: "config-model",
          name: "Config Model",
          provider: "zai",
          model: "config-model-v1",
          status: "available",
        },
      ],
      defaultModelId: "config-model",
      fallbackModelIds: ["config-model"],
      routes: [
        {
          taskType: "chat",
          modelId: "config-model",
        },
      ],
    });

    expect(service.getRegistry().getDefaultModelId()).toBe("config-model");
    const route = service.getRouter().getRoute("chat");
    expect(route!.modelId).toBe("config-model");
  });
});

describe("LLM Event Bus Integration", () => {
  it("should publish LLM events on model switch", async () => {
    const bus = new EventBus();
    const switchedEvents: string[] = [];

    bus.subscribe("llm.model.switched", async (event) => {
      switchedEvents.push(`${event.payload.previousModelId}->${event.payload.newModelId}`);
    });

    // Simulate model switch event
    await bus.publish({
      type: "llm.model.switched",
      source: "test",
      payload: {
        previousModelId: "deepseek-v4-pro",
        newModelId: "gpt-4o",
        switchedBy: "tui",
      },
    });

    expect(switchedEvents.length).toBe(1);
    expect(switchedEvents[0]).toBe("deepseek-v4-pro->gpt-4o");
  });

  it("should publish LLM chat completion events", async () => {
    const bus = new EventBus();
    const completedEvents: string[] = [];

    bus.subscribe("llm.chat.completed", async (event) => {
      completedEvents.push(event.payload.modelId);
    });

    await bus.publish({
      type: "llm.chat.completed",
      source: "agent-runtime",
      payload: {
        taskType: "chat",
        modelId: "deepseek-v4-pro",
        modelName: "deepseek-v4-pro",
        provider: "zai",
        content: "Hello!",
        durationMs: 150,
        tokensUsed: 42,
        fallbackUsed: false,
      },
    });

    expect(completedEvents.length).toBe(1);
    expect(completedEvents[0]).toBe("deepseek-v4-pro");
  });

  it("should publish LLM failure events", async () => {
    const bus = new EventBus();
    const failedEvents: string[] = [];

    bus.subscribe("llm.chat.failed", async (event) => {
      failedEvents.push(event.payload.modelId);
    });

    await bus.publish({
      type: "llm.chat.failed",
      source: "agent-runtime",
      payload: {
        taskType: "chat",
        modelId: "deepseek-v4-pro",
        error: "Rate limit exceeded",
      },
    });

    expect(failedEvents.length).toBe(1);
    expect(failedEvents[0]).toBe("deepseek-v4-pro");
  });

  it("should publish route update events", async () => {
    const bus = new EventBus();
    const routeEvents: string[] = [];

    bus.subscribe("llm.route.updated", async (event) => {
      routeEvents.push(`${event.payload.taskType}:${event.payload.newModelId}`);
    });

    await bus.publish({
      type: "llm.route.updated",
      source: "tui",
      payload: {
        taskType: "patch_generate",
        previousModelId: "deepseek-v4-pro",
        newModelId: "deepseek-r1",
      },
    });

    expect(routeEvents.length).toBe(1);
    expect(routeEvents[0]).toBe("patch_generate:deepseek-r1");
  });
});

describe("Default Registry Factory", () => {
  it("should create registry with expected models", () => {
    const registry = createDefaultRegistry({});
    const models = registry.getAllModels();

    const modelIds = models.map((m) => m.id);
    expect(modelIds).toContain("fallback");
    expect(modelIds).toContain("deepseek-v4-pro");
    expect(modelIds).toContain("gpt-4o");
    expect(modelIds).toContain("gpt-4o-mini");
    expect(modelIds).toContain("claude-3.5-sonnet");
    expect(modelIds).toContain("deepseek-r1");
  });

  it("should set deepseek-v4-pro as default", () => {
    const registry = createDefaultRegistry({});
    expect(registry.getDefaultModelId()).toBe("deepseek-v4-pro");
  });

  it("should respect LLM_DEFAULT_MODEL env variable", () => {
    const registry = createDefaultRegistry({ LLM_DEFAULT_MODEL: "gpt-4o" });
    expect(registry.getDefaultModelId()).toBe("gpt-4o");
  });

  it("should include fallback provider", () => {
    const registry = createDefaultRegistry({});
    const provider = registry.getProvider("custom");
    expect(provider).toBeDefined();
  });

  it("should include ZAI provider", () => {
    const registry = createDefaultRegistry({});
    const provider = registry.getProvider("zai");
    expect(provider).toBeDefined();
  });
});
