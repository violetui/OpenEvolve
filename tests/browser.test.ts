import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/core/event-bus";

/**
 * Browser module tests
 *
 * These tests verify that browser event pipelines are correct
 * Browser is not actually launched (avoid CI dependency on browser)
 * Real browser functionality is verified in integration tests
 */
describe("Browser event pipeline", () => {
  it("should complete search event chain", async () => {
    const bus = new EventBus();
    const eventLog: string[] = [];

    bus.subscribeAll(async (event) => {
      eventLog.push(event.type);
    });

    // Simulate BrowserSearch module behavior
    bus.subscribe("browser.search.requested", async (event) => {
      await bus.publish({
        type: "browser.search.completed",
        source: "browser-search",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          query: event.payload.query,
          results: [
            {
              title: "Test Result",
              url: "https://example.com",
              snippet: "A test search result"
            }
          ]
        }
      });
    });

    await bus.publish({
      type: "browser.search.requested",
      source: "test",
      payload: {
        query: "AI agent plugin",
        engine: "google"
      }
    });

    expect(eventLog).toContain("browser.search.requested");
    expect(eventLog).toContain("browser.search.completed");
  });

  it("should complete fetch event chain", async () => {
    const bus = new EventBus();
    const eventLog: string[] = [];

    bus.subscribeAll(async (event) => {
      eventLog.push(event.type);
    });

    bus.subscribe("browser.fetch.requested", async (event) => {
      await bus.publish({
        type: "browser.fetch.completed",
        source: "browser-search",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          url: event.payload.url,
          title: "Test Page",
          content: "Page content here",
          statusCode: 200
        }
      });
    });

    await bus.publish({
      type: "browser.fetch.requested",
      source: "test",
      payload: {
        url: "https://example.com"
      }
    });

    expect(eventLog).toContain("browser.fetch.requested");
    expect(eventLog).toContain("browser.fetch.completed");
  });

  it("should complete task event chain with steps", async () => {
    const bus = new EventBus();
    const eventLog: string[] = [];
    const stepResults: Array<{ stepIndex: number; success: boolean }> = [];

    bus.subscribeAll(async (event) => {
      eventLog.push(event.type);
    });

    // Simulate BrowserTask module behavior
    bus.subscribe("browser.task.requested", async (event) => {
      const steps = event.payload.steps;

      for (let i = 0; i < steps.length; i++) {
        stepResults.push({ stepIndex: i, success: true });

        await bus.publish({
          type: "browser.task.step.completed",
          source: "browser-task",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            taskName: event.payload.taskName,
            stepIndex: i,
            stepType: steps[i]!.type,
            success: true,
            data: `step ${i} done`
          }
        });
      }

      await bus.publish({
        type: "browser.task.completed",
        source: "browser-task",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          taskName: event.payload.taskName,
          totalSteps: steps.length,
          completedSteps: steps.length
        }
      });
    });

    await bus.publish({
      type: "browser.task.requested",
      source: "test",
      payload: {
        taskName: "test-task",
        steps: [
          { type: "navigate", value: "https://example.com" },
          { type: "wait", value: "1000" },
          { type: "extract" },
          { type: "screenshot" }
        ]
      }
    });

    expect(eventLog).toContain("browser.task.requested");
    expect(eventLog).toContain("browser.task.completed");
    // 4 steps → 4 step.completed events
    const stepEvents = eventLog.filter(e => e === "browser.task.step.completed");
    expect(stepEvents.length).toBe(4);
    expect(stepResults.length).toBe(4);
  });

  it("should handle browser action failure", async () => {
    const bus = new EventBus();
    const failures: string[] = [];

    bus.subscribe("browser.action.failed", async (event) => {
      failures.push(event.payload.action);
    });

    // Simulate search failure
    bus.subscribe("browser.search.requested", async (event) => {
      await bus.publish({
        type: "browser.action.failed",
        source: "browser-search",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          action: "search",
          error: "browser not available"
        }
      });
    });

    await bus.publish({
      type: "browser.search.requested",
      source: "test",
      payload: {
        query: "test"
      }
    });

    expect(failures.length).toBe(1);
    expect(failures[0]).toBe("search");
  });

  it("should track correlationId across browser events", async () => {
    const bus = new EventBus();
    const correlationIds: string[] = [];

    bus.subscribeAll(async (event) => {
      correlationIds.push(event.correlationId);
    });

    bus.subscribe("browser.search.requested", async (event) => {
      await bus.publish({
        type: "browser.search.completed",
        source: "browser-search",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          query: event.payload.query,
          results: []
        }
      });
    });

    await bus.publish({
      type: "browser.search.requested",
      source: "test",
      payload: {
        query: "test"
      }
    });

    const uniqueIds = new Set(correlationIds);
    expect(uniqueIds.size).toBe(1);
  });

  it("should support screenshot event chain", async () => {
    const bus = new EventBus();
    const eventLog: string[] = [];

    bus.subscribeAll(async (event) => {
      eventLog.push(event.type);
    });

    bus.subscribe("browser.screenshot.requested", async (event) => {
      await bus.publish({
        type: "browser.screenshot.completed",
        source: "browser-automation",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          url: event.payload.url,
          imagePath: "/tmp/test-screenshot.png",
          width: 1280,
          height: 720
        }
      });
    });

    await bus.publish({
      type: "browser.screenshot.requested",
      source: "test",
      payload: {
        url: "https://example.com",
        fullPage: true
      }
    });

    expect(eventLog).toContain("browser.screenshot.requested");
    expect(eventLog).toContain("browser.screenshot.completed");
  });

  it("should integrate browser search with feature scout", async () => {
    const bus = new EventBus();
    const searchResults: string[] = [];

    // FeatureScout subscribes to feature.scout.requested and triggers browser.search
    bus.subscribe("feature.scout.requested", async (event) => {
      // Publish search request
      await bus.publish({
        type: "browser.search.requested",
        source: "feature-scout",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          query: "AI agent plugin MCP server",
          engine: "google"
        }
      });
    });

    // BrowserSearch simulation
    bus.subscribe("browser.search.requested", async (event) => {
      await bus.publish({
        type: "browser.search.completed",
        source: "browser-search",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          query: event.payload.query,
          results: [
            { title: "MCP Registry", url: "https://registry.modelcontextprotocol.io", snippet: "MCP server directory" },
            { title: "AI Agent Framework", url: "https://github.com/example/agent", snippet: "Agent framework" }
          ]
        }
      });
    });

    // FeatureScout converts search results to feature.sources.discovered
    bus.subscribe("browser.search.completed", async (event) => {
      searchResults.push(...event.payload.results.map(r => r.title));

      await bus.publish({
        type: "feature.sources.discovered",
        source: "feature-scout",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          sources: event.payload.results.map(r => ({
            type: "github" as const,
            url: r.url,
            name: r.title,
            description: r.snippet
          }))
        }
      });
    });

    await bus.publish({
      type: "feature.scout.requested",
      source: "test",
      payload: {
        triggeredBy: "manual"
      }
    });

    expect(searchResults.length).toBe(2);
    expect(searchResults).toContain("MCP Registry");
  });
});
