import { mkdir, appendFile } from "node:fs/promises";
import { dirname } from "node:path";

export class EventStore {
  constructor(private filePath: string) {}

  async append(event: unknown) {
    await mkdir(dirname(this.filePath), { recursive: true });

    await appendFile(
      this.filePath,
      JSON.stringify(event) + "\n",
      "utf8"
    );
  }
}
