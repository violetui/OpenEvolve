import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/core/event-bus";
import type { EventEnvelope } from "../src/core/event-bus";
import type { EventType } from "../src/core/event-types";

describe("EventBus", () => {
  it("should publish and subscribe to events", async () => {
    const bus = new EventBus();
    const received: EventEnvelope<"agent.message.received">[] = [];

    bus.subscribe("agent.message.received", async (event) => {
      received.push(event);
    });

    await bus.publish({
      type: "agent.message.received",
      source: "test",
      payload: {
        message: "hello"
      }
    });

    expect(received.length).toBe(1);
    expect(received[0]!.payload.message).toBe("hello");
    expect(received[0]!.source).toBe("test");
  });

  it("should support unsubscribe", async () => {
    const bus = new EventBus();
    const received: EventEnvelope<"agent.message.received">[] = [];

    const unsub = bus.subscribe("agent.message.received", async (event) => {
      received.push(event);
    });

    await bus.publish({
      type: "agent.message.received",
      source: "test",
      payload: {
        message: "first"
      }
    });

    unsub();

    await bus.publish({
      type: "agent.message.received",
      source: "test",
      payload: {
        message: "second"
      }
    });

    expect(received.length).toBe(1);
    expect(received[0]!.payload.message).toBe("first");
  });

  it("should support subscribeAll (wildcard)", async () => {
    const bus = new EventBus();
    const allReceived: EventEnvelope<EventType>[] = [];

    bus.subscribeAll(async (event) => {
      allReceived.push(event as EventEnvelope<EventType>);
    });

    await bus.publish({
      type: "agent.message.received",
      source: "test",
      payload: {
        message: "hello"
      }
    });

    await bus.publish({
      type: "system.module.started",
      source: "test",
      payload: {
        moduleName: "test-module"
      }
    });

    expect(allReceived.length).toBe(2);
  });

  it("should propagate correlationId and causationId", async () => {
    const bus = new EventBus();
    const received: EventEnvelope<"agent.message.completed">[] = [];

    bus.subscribe("agent.message.completed", async (event) => {
      received.push(event);
    });

    const parent = await bus.publish({
      type: "agent.message.received",
      source: "test",
      correlationId: "corr-123",
      payload: {
        message: "hello"
      }
    });

    await bus.publish({
      type: "agent.message.completed",
      source: "test",
      correlationId: parent.correlationId,
      causationId: parent.id,
      payload: {
        message: "hello",
        result: "ok"
      }
    });

    expect(received.length).toBe(1);
    expect(received[0]!.correlationId).toBe("corr-123");
    expect(received[0]!.causationId).toBe(parent.id);
  });

  it("should auto-generate correlationId if not provided", async () => {
    const bus = new EventBus();
    const received: EventEnvelope<"agent.message.received">[] = [];

    bus.subscribe("agent.message.received", async (event) => {
      received.push(event);
    });

    await bus.publish({
      type: "agent.message.received",
      source: "test",
      payload: {
        message: "hello"
      }
    });

    expect(received[0]!.correlationId).toBeDefined();
    expect(received[0]!.correlationId.length).toBeGreaterThan(0);
  });

  it("should not break when handler throws", async () => {
    const bus = new EventBus();
    const received: EventEnvelope<"agent.message.received">[] = [];

    bus.subscribe("agent.message.received", async () => {
      throw new Error("handler error");
    });

    bus.subscribe("agent.message.received", async (event) => {
      received.push(event);
    });

    await bus.publish({
      type: "agent.message.received",
      source: "test",
      payload: {
        message: "hello"
      }
    });

    // Second handler should still be called even if first one threw
    expect(received.length).toBe(1);
  });
});
