import { describe, it, expect } from "bun:test";
import { EventBus } from "../src/core/event-bus";
import { EventStore } from "../src/core/event-store";
import { isPathAllowed } from "../src/core/policy";
import { loadPlugin } from "../src/core/plugin";
import type { AgentPlugin } from "../src/core/plugin";
import { existsSync, rmSync } from "node:fs";

describe("Smoke tests", () => {
  it("EventStore should append events to file", async () => {
    const testPath = "/tmp/test-smoke-events.jsonl";
    // Clean up before test
    if (existsSync(testPath)) {
      rmSync(testPath);
    }

    const store = new EventStore(testPath);
    await store.append({ type: "test", data: "hello" });
    await store.append({ type: "test", data: "world" });

    const file = Bun.file(testPath);
    const content = await file.text();
    const lines = content.trim().split("\n");

    expect(lines.length).toBe(2);
    expect(JSON.parse(lines[0]!).data).toBe("hello");
    expect(JSON.parse(lines[1]!).data).toBe("world");

    // Clean up
    rmSync(testPath);
  });

  it("policy should allow correct paths", () => {
    expect(isPathAllowed("src/modules/agent-runtime.ts")).toBe(true);
    expect(isPathAllowed("skills/general.md")).toBe(true);
    expect(isPathAllowed("tests/agent.test.ts")).toBe(true);
    expect(isPathAllowed("src/modules/tool-router.ts")).toBe(true);
    expect(isPathAllowed("src/modules/skill-loader.ts")).toBe(true);
  });

  it("policy should forbid protected paths", () => {
    expect(isPathAllowed("src/core/event-bus.ts")).toBe(false);
    expect(isPathAllowed("src/core/policy.ts")).toBe(false);
    expect(isPathAllowed("package.json")).toBe(false);
    expect(isPathAllowed("bun.lock")).toBe(false);
    expect(isPathAllowed("supervisor/index.ts")).toBe(false);
    expect(isPathAllowed("evolution/worker.ts")).toBe(false);
  });

  it("should load plugin and emit system.plugin.loaded event", async () => {
    const bus = new EventBus();
    const loadedEvents: string[] = [];

    bus.subscribe("system.plugin.loaded", async (event) => {
      loadedEvents.push(event.payload.pluginName);
    });

    const testPlugin: AgentPlugin = {
      name: "test-plugin",
      version: "1.0.0",
      permissions: {
        subscribe: ["agent.failure.reported"]
      },
      setup(ctx) {
        ctx.bus.subscribe("agent.failure.reported", async (_event) => {
          // Plugin handler
        });
      }
    };

    await loadPlugin({ bus, plugin: testPlugin });

    expect(loadedEvents).toContain("test-plugin");
  });

  it("EventBus should generate unique event IDs", async () => {
    const bus = new EventBus();
    const ids = new Set<string>();

    bus.subscribeAll(async (event) => {
      ids.add(event.id);
    });

    for (let i = 0; i < 100; i++) {
      await bus.publish({
        type: "agent.message.received",
        source: "test",
        payload: {
          message: `msg-${i}`
        }
      });
    }

    expect(ids.size).toBe(100);
  });
});
