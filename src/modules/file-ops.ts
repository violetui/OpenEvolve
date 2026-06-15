import type { AgentModule } from "../core/module";
import { isPathAllowed } from "../core/policy";

export const FileOpsModule: AgentModule = {
  name: "file-ops",

  start(ctx) {
    ctx.bus.subscribe("file.read.requested", async (event) => {
      const { file_path, offset, limit } = event.payload;

      try {
        const { access, readFile } = await import("node:fs/promises");
        await access(file_path);

        const content = await readFile(file_path, "utf-8");
        const lines = content.split("\n");
        const totalLines = lines.length;

        const start = offset ?? 0;
        const end = limit ? Math.min(start + limit, totalLines) : totalLines;
        const selectedLines = lines.slice(start, end);

        const numbered = selectedLines
          .map((line, i) => `${start + i + 1}\t${line}`)
          .join("\n");

        await ctx.bus.publish({
          type: "file.read.completed",
          source: "file-ops",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            file_path,
            content: numbered,
            totalLines,
            truncated: end < totalLines,
          },
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "file.read.completed",
          source: "file-ops",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            file_path,
            content: "",
            totalLines: 0,
            truncated: false,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });

    ctx.bus.subscribe("file.write.requested", async (event) => {
      const { file_path, content } = event.payload;

      try {
        if (!isPathAllowed(file_path)) {
          throw new Error(`Path not allowed by security policy: ${file_path}`);
        }

        const { mkdir, writeFile } = await import("node:fs/promises");
        const { dirname } = await import("node:path");

        await mkdir(dirname(file_path), { recursive: true });
        await writeFile(file_path, content, "utf-8");

        const size = Buffer.byteLength(content, "utf-8");

        await ctx.bus.publish({
          type: "file.write.completed",
          source: "file-ops",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: { file_path, size },
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "file.write.completed",
          source: "file-ops",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            file_path,
            size: 0,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });

    ctx.bus.subscribe("file.edit.requested", async (event) => {
      const { file_path, old_string, new_string, replace_all } = event.payload;

      try {
        if (!isPathAllowed(file_path)) {
          throw new Error(`Path not allowed by security policy: ${file_path}`);
        }

        const { readFile, writeFile } = await import("node:fs/promises");

        const content = await readFile(file_path, "utf-8");

        if (!content.includes(old_string)) {
          throw new Error(`old_string not found in file: "${old_string.substring(0, 80)}"`);
        }

        let replacedCount: number;
        let newContent: string;

        if (replace_all) {
          const matches = content.match(new RegExp(escapeRegex(old_string), "g"));
          replacedCount = matches ? matches.length : 0;
          newContent = content.split(old_string).join(new_string);
        } else {
          replacedCount = 1;
          newContent = content.replace(old_string, new_string);
        }

        await writeFile(file_path, newContent, "utf-8");

        await ctx.bus.publish({
          type: "file.edit.completed",
          source: "file-ops",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: { file_path, old_string, new_string, replacedCount },
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "file.edit.completed",
          source: "file-ops",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            file_path,
            old_string,
            new_string,
            replacedCount: 0,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
  },
};

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
