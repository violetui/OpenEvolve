import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AgentModule } from "../core/module";
import type { TodoItem } from "../core/event-types";

const DATA_DIR = resolve(process.cwd(), "data");
const TODO_FILE = resolve(DATA_DIR, "todos.json");

function loadTodos(): TodoItem[] {
  try {
    if (existsSync(TODO_FILE)) {
      const raw = readFileSync(TODO_FILE, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as TodoItem[];
    }
  } catch {
    // Corrupted file — start fresh
  }
  return [];
}

function saveTodos(todos: TodoItem[]): void {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(TODO_FILE, JSON.stringify(todos, null, 2), "utf-8");
}

export const TodoManagerModule: AgentModule = {
  name: "todo-manager",

  start(ctx) {
    let todos = loadTodos();
    console.log(`[todo-manager] Loaded ${todos.length} existing todos`);

    ctx.bus.subscribe("todo.operation.requested", async (event) => {
      const { action, todos: inputTodos, taskId } = event.payload;

      try {
        switch (action) {
          case "create": {
            const now = new Date().toISOString();
            const newItems: TodoItem[] = (inputTodos ?? []).map((t) => ({
              id: randomUUID(),
              content: t.content,
              status: t.status ?? "pending",
              createdAt: now,
            }));
            todos.push(...newItems);
            saveTodos(todos);
            console.log(`[todo-manager] Created ${newItems.length} todos`);
            break;
          }

          case "update": {
            if (!taskId) throw new Error("taskId is required for update action");
            const idx = todos.findIndex((t) => t.id === taskId);
            if (idx === -1) throw new Error(`Todo not found: ${taskId}`);

            if (inputTodos?.[0]) {
              const update = inputTodos[0];
              if (update.content !== undefined) todos[idx]!.content = update.content;
              if (update.status !== undefined) todos[idx]!.status = update.status as TodoItem["status"];
            }
            saveTodos(todos);
            console.log(`[todo-manager] Updated todo: ${taskId}`);
            break;
          }

          case "delete": {
            if (!taskId) throw new Error("taskId is required for delete action");
            const before = todos.length;
            todos = todos.filter((t) => t.id !== taskId);
            if (todos.length === before) throw new Error(`Todo not found: ${taskId}`);
            saveTodos(todos);
            console.log(`[todo-manager] Deleted todo: ${taskId}`);
            break;
          }

          case "list": {
            break;
          }

          default:
            throw new Error(`Unknown todo action: ${action}`);
        }

        await ctx.bus.publish({
          type: "todo.operation.completed",
          source: "todo-manager",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: { action, todos },
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "todo.operation.completed",
          source: "todo-manager",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            action,
            todos,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
  },
};
