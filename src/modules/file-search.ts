import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import type { AgentModule } from "../core/module";

export const FileSearchModule: AgentModule = {
  name: "file-search",

  start(ctx) {
    ctx.bus.subscribe("file.glob.requested", async (event) => {
      const { pattern, path: rootPath } = event.payload;
      const searchPath = resolve(rootPath ?? ".");

      try {
        const { Glob } = await import("bun");
        const glob = new Glob(pattern);
        const files: string[] = [];

        for await (const file of glob.scan({ cwd: searchPath, absolute: true, onlyFiles: true })) {
          files.push(file);
        }

        files.sort();

        await ctx.bus.publish({
          type: "file.glob.completed",
          source: "file-search",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: { pattern, path: searchPath, files },
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "file.glob.completed",
          source: "file-search",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            pattern,
            path: searchPath,
            files: [],
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });

    ctx.bus.subscribe("file.grep.requested", async (event) => {
      const { pattern, path: rootPath, include } = event.payload;
      const searchPath = resolve(rootPath ?? ".");

      try {
        const results: Array<{ file: string; line: number; content: string }> = [];
        const regex = new RegExp(pattern, "g");

        const filePaths = await findFiles(searchPath, include ?? "**/*");
        if (filePaths.length === 0) {
          throw new Error(`No files found matching include pattern: "${include ?? "**/*"}"`);
        }

        for (const fp of filePaths) {
          if (results.length >= 500) break;

          try {
            const content = readFileSync(fp, "utf-8");
            const lines = content.split("\n");

            for (let i = 0; i < lines.length; i++) {
              if (results.length >= 500) break;
              const line = lines[i];
              if (line === undefined) continue;
              regex.lastIndex = 0;
              if (regex.test(line)) {
                results.push({
                  file: fp,
                  line: i + 1,
                  content: line.trim().substring(0, 200),
                });
              }
            }
          } catch {
            // Skip unreadable files (binary, permissions, etc.)
            continue;
          }
        }

        if (results.length === 0) {
          throw new Error(`Pattern "${pattern}" not found in any file`);
        }

        await ctx.bus.publish({
          type: "file.grep.completed",
          source: "file-search",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: { pattern, path: searchPath, results },
        });
      } catch (error) {
        await ctx.bus.publish({
          type: "file.grep.completed",
          source: "file-search",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            pattern,
            path: searchPath,
            results: [],
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    });
  },
};

async function findFiles(root: string, pattern: string): Promise<string[]> {
  const { Glob } = await import("bun");
  const glob = new Glob(pattern);
  const files: string[] = [];
  for await (const file of glob.scan({ cwd: root, absolute: true, onlyFiles: true })) {
    files.push(file);
  }
  return files.sort();
}
