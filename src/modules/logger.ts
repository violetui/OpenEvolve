import { EventBus } from "../core/event-bus";
import { EventStore } from "../core/event-store";

export function registerEventLogger(bus: EventBus) {
  const store = new EventStore("logs/events.jsonl");

  bus.subscribeAll(async (event) => {
    await store.append(event);
  });
}
