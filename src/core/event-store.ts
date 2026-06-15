import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export interface EventQuery {
  /** Filter by event type */
  type?: string;
  /** Only events after this ISO timestamp */
  since?: string;
  /** Maximum number of events to return */
  limit?: number;
}

export interface StoredEvent {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  timestamp: string;
  source: string;
  correlationId: string;
  causationId?: string;
}

export class EventStore {
  constructor(private filePath: string) {}

  async append(event: unknown) {
    await mkdir(dirname(this.filePath), { recursive: true });
    await appendFile(this.filePath, JSON.stringify(event) + "\n", "utf8");
  }

  /**
   * Query events with optional filters.
   * Reads the file in reverse (newest first) and applies filters.
   */
  async query(q: EventQuery = {}): Promise<StoredEvent[]> {
    const results: StoredEvent[] = [];
    const limit = q.limit ?? 100;

    try {
      const rl = createInterface({
        input: createReadStream(this.filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });

      const lines: string[] = [];
      for await (const line of rl) {
        if (line.trim()) lines.push(line);
      }

      // Read from newest to oldest
      for (let i = lines.length - 1; i >= 0 && results.length < limit; i--) {
        try {
          const event: StoredEvent = JSON.parse(lines[i]!);
          if (q.type && event.type !== q.type) continue;
          if (q.since && event.timestamp <= q.since) continue;
          results.push(event);
        } catch {
          // Skip malformed lines
        }
      }
    } catch {
      // File may not exist yet
    }

    return results;
  }

  /**
   * Read the most recent N events.
   */
  async readRecent(limit: number = 500): Promise<StoredEvent[]> {
    return this.query({ limit });
  }

  /**
   * Query events by type.
   */
  async queryByType(type: string, limit: number = 100): Promise<StoredEvent[]> {
    return this.query({ type, limit });
  }

  /**
   * Query events since a given ISO timestamp.
   */
  async querySince(since: string, limit: number = 200): Promise<StoredEvent[]> {
    return this.query({ since, limit });
  }

  /**
   * Get the total number of events stored.
   */
  async count(): Promise<number> {
    let count = 0;
    try {
      const rl = createInterface({
        input: createReadStream(this.filePath, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of rl) {
        if (line.trim()) count++;
      }
    } catch {
      // File may not exist
    }
    return count;
  }
}
