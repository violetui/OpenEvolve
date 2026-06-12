import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/core/event-bus";

/**
 * TUI module tests
 *
 * TUI uses blessed library which requires a terminal environment, so it cannot be launched directly in tests
 * These tests verify the event pipelines that the TUI depends on
 */
describe("TUI event integration", () => {
  it("should support chat flow via event bus", async () => {
    const bus = new EventBus();
    const chatLog: string[] = [];

    // Simulate TUI sending message
    bus.subscribe("agent.message.received", async (event) => {
      chatLog.push(`sent: ${event.payload.message}`);

      // Simulate agent response
      await bus.publish({
        type: "agent.message.completed",
        source: "agent-runtime",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          message: event.payload.message,
          result: `Reply: ${event.payload.message}`
        }
      });
    });

    bus.subscribe("agent.message.completed", async (event) => {
      chatLog.push(`received: ${event.payload.result}`);
    });

    // Send message
    await bus.publish({
      type: "agent.message.received",
      source: "tui",
      payload: {
        message: "hello",
        userId: "tui-user"
      }
    });

    expect(chatLog).toContain("sent: hello");
    expect(chatLog).toContain("received: Reply: hello");
  });

  it("should support search command flow", async () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.subscribe("browser.search.requested", async (event) => {
      log.push(`search: ${event.payload.query}`);

      await bus.publish({
        type: "browser.search.completed",
        source: "browser-search",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          query: event.payload.query,
          results: [
            { title: "Test", url: "https://example.com", snippet: "Test result" }
          ]
        }
      });
    });

    bus.subscribe("browser.search.completed", async (event) => {
      log.push(`results: ${event.payload.results.length}`);
    });

    await bus.publish({
      type: "browser.search.requested",
      source: "tui",
      payload: { query: "AI agent" }
    });

    expect(log).toContain("search: AI agent");
    expect(log).toContain("results: 1");
  });

  it("should support scout command flow", async () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.subscribe("feature.scout.requested", async (event) => {
      log.push(`scout: ${event.payload.triggeredBy}`);

      await bus.publish({
        type: "feature.sources.discovered",
        source: "feature-scout",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          sources: [
            { type: "github", url: "https://github.com", name: "GitHub", description: "Code hosting" }
          ]
        }
      });
    });

    bus.subscribe("feature.sources.discovered", async (event) => {
      log.push(`discovered: ${event.payload.sources.length}`);
    });

    await bus.publish({
      type: "feature.scout.requested",
      source: "tui",
      payload: {
        triggeredBy: "manual"
      }
    });

    expect(log).toContain("scout: manual");
    expect(log).toContain("discovered: 1");
  });

  it("should support trigger repair command flow", async () => {
    const bus = new EventBus();
    const log: string[] = [];

    bus.subscribe("agent.failure.reported", async (event) => {
      log.push(`failure: ${event.payload.errorType}`);
    });

    await bus.publish({
      type: "agent.failure.reported",
      source: "tui",
      payload: {
        errorType: "runtime_error",
        message: "Manual repair trigger test"
      }
    });

    expect(log).toContain("failure: runtime_error");
  });

  it("should track all three chain states", async () => {
    const bus = new EventBus();
    const eventTypes: string[] = [];

    bus.subscribeAll(async (event) => {
      eventTypes.push(event.type);
    });

    // Trigger repair chain
    await bus.publish({
      type: "agent.failure.reported",
      source: "test",
      payload: { errorType: "runtime_error", message: "test" }
    });

    // Trigger scout chain
    await bus.publish({
      type: "feature.scout.requested",
      source: "test",
      payload: { triggeredBy: "manual" }
    });

    // Trigger browser chain
    await bus.publish({
      type: "browser.search.requested",
      source: "test",
      payload: { query: "test" }
    });

    expect(eventTypes).toContain("agent.failure.reported");
    expect(eventTypes).toContain("feature.scout.requested");
    expect(eventTypes).toContain("browser.search.requested");
  });
});
