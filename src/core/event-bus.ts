import { randomUUID } from "node:crypto";
import type { AppEventMap, EventType } from "./event-types";

export type EventEnvelope<T extends EventType> = {
  id: string;
  type: T;
  payload: AppEventMap[T];
  timestamp: string;
  source: string;
  correlationId: string;
  causationId?: string;
  metadata?: Record<string, unknown>;
};

type Handler<T extends EventType> = (
  event: EventEnvelope<T>
) => Promise<void> | void;

export class EventBus {
  private handlers = new Map<EventType, Handler<any>[]>();
  private wildcardHandlers: Handler<any>[] = [];

  subscribe<T extends EventType>(
    type: T,
    handler: Handler<T>
  ) {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);

    return () => {
      const current = this.handlers.get(type) ?? [];
      this.handlers.set(
        type,
        current.filter((h) => h !== handler)
      );
    };
  }

  subscribeAll(handler: Handler<any>) {
    this.wildcardHandlers.push(handler);

    return () => {
      this.wildcardHandlers = this.wildcardHandlers.filter(
        (h) => h !== handler
      );
    };
  }

  async publish<T extends EventType>(input: {
    type: T;
    payload: AppEventMap[T];
    source: string;
    correlationId?: string;
    causationId?: string;
    metadata?: Record<string, unknown>;
  }) {
    const event: EventEnvelope<T> = {
      id: randomUUID(),
      type: input.type,
      payload: input.payload,
      timestamp: new Date().toISOString(),
      source: input.source,
      correlationId: input.correlationId ?? randomUUID(),
      causationId: input.causationId,
      metadata: input.metadata
    };

    const handlers = [
      ...(this.handlers.get(input.type) ?? []),
      ...this.wildcardHandlers
    ];

    for (const handler of handlers) {
      try {
        await handler(event);
      } catch (error) {
        console.error("event handler failed", {
          eventType: event.type,
          error
        });
      }
    }

    return event;
  }
}
