import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/core/event-bus";

describe("Agent self-healing pipeline", () => {
  it("should complete full event chain: failure → analysis → patch → eval", async () => {
    const bus = new EventBus();
    const eventLog: string[] = [];

    // Subscribe to all events to track the chain
    bus.subscribeAll(async (event) => {
      eventLog.push(event.type);
    });

    // Manually register module handlers (same as the real modules, but simplified for testing)
    // FailureMiner: subscribes to agent.failure.reported
    bus.subscribe("agent.failure.reported", async (event) => {
      await bus.publish({
        type: "evolution.analysis.requested",
        source: "failure-miner",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          failureEventId: event.id
        }
      });
    });

    // PatchGenerator: subscribes to evolution.analysis.requested
    bus.subscribe("evolution.analysis.requested", async (event) => {
      await bus.publish({
        type: "evolution.patch.proposed",
        source: "patch-generator",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          reason: "test patch",
          risk: "low",
          changes: [
            {
              path: "tests/dummy.ts",
              operation: "replace_file" as const,
              content: "// test"
            }
          ]
        }
      });
    });

    // Simulate: agent.failure.reported
    await bus.publish({
      type: "agent.failure.reported",
      source: "test",
      payload: {
        errorType: "runtime_error",
        message: "test error"
      }
    });

    expect(eventLog).toContain("agent.failure.reported");
    expect(eventLog).toContain("evolution.analysis.requested");
    expect(eventLog).toContain("evolution.patch.proposed");
  });

  it("should track correlationId across the chain", async () => {
    const bus = new EventBus();
    const correlationIds: string[] = [];

    bus.subscribeAll(async (event) => {
      correlationIds.push(event.correlationId);
    });

    // FailureMiner
    bus.subscribe("agent.failure.reported", async (event) => {
      await bus.publish({
        type: "evolution.analysis.requested",
        source: "failure-miner",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          failureEventId: event.id
        }
      });
    });

    await bus.publish({
      type: "agent.failure.reported",
      source: "test",
      payload: {
        errorType: "runtime_error",
        message: "test error"
      }
    });

    // All events in the chain should share the same correlationId
    const uniqueIds = new Set(correlationIds);
    expect(uniqueIds.size).toBe(1);
  });
});
