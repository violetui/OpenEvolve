/**
 * Shared Tool Definitions & Execution
 *
 * Central tool registry used by both the interactive agent (agent-runtime)
 * and the self-optimization agent (self-optimizer).
 *
 * Tools communicate with other modules exclusively via EventBus events.
 */
import type { EventBus } from "../core/event-bus";
import type { LLMTool } from "../llm/types";

// ===== Tool Definitions =====

export const AGENT_TOOLS: LLMTool[] = [
  {
    type: "function",
    function: {
      name: "file_read",
      description: "Read a file and return its contents with line numbers. Supports optional offset and limit.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to read" },
          offset: { type: "number", description: "Line number to start reading from (0-indexed)" },
          limit: { type: "number", description: "Maximum number of lines to read" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_write",
      description: "Write content to a file. Creates if not exists, overwrites if exists.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to write" },
          content: { type: "string", description: "Content to write to the file" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "file_edit",
      description: "Replace exact text in a file. First occurrence only unless replace_all is true.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "Path to the file to edit" },
          old_string: { type: "string", description: "Exact text to find" },
          new_string: { type: "string", description: "Replacement text" },
          replace_all: { type: "boolean", description: "Replace all occurrences (default: false)" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep",
      description: "Search for a regex pattern in files. Returns matching file paths, line numbers, and content.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Regex pattern to search for" },
          path: { type: "string", description: "Root directory (default: current working directory)" },
          include: { type: "string", description: "File filter glob (e.g., '*.ts')" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "glob",
      description: "Find files matching a glob pattern (e.g., 'src/**/*.ts').",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Glob pattern" },
          path: { type: "string", description: "Root directory (default: cwd)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "bash",
      description: "Execute a shell command. Sandboxed with timeout.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command" },
          timeout: { type: "number", description: "Timeout in ms (default: 120000)" },
          workdir: { type: "string", description: "Working directory" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_search",
      description: "Search the web and return results with titles, URLs, and snippets.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          maxResults: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_fetch",
      description: "Fetch and extract text content of a web page by URL.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to fetch" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browser_screenshot",
      description: "Take a screenshot of a web page.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "URL to screenshot" },
          fullPage: { type: "boolean", description: "Capture full page (default: false)" },
        },
        required: ["url"],
      },
    },
  },
];

// ===== Tool Event Map =====

export const TOOL_MAP: Record<string, { requestType: string; responseType: string }> = {
  file_read: { requestType: "file.read.requested", responseType: "file.read.completed" },
  file_write: { requestType: "file.write.requested", responseType: "file.write.completed" },
  file_edit: { requestType: "file.edit.requested", responseType: "file.edit.completed" },
  grep: { requestType: "file.grep.requested", responseType: "file.grep.completed" },
  glob: { requestType: "file.glob.requested", responseType: "file.glob.completed" },
  bash: { requestType: "shell.exec.requested", responseType: "shell.exec.completed" },
  browser_search: { requestType: "browser.search.requested", responseType: "browser.search.completed" },
  browser_fetch: { requestType: "browser.fetch.requested", responseType: "browser.fetch.completed" },
  browser_screenshot: { requestType: "browser.screenshot.requested", responseType: "browser.screenshot.completed" },
};

// ===== Tool Execution =====

export async function executeTool(
  bus: EventBus,
  toolName: string,
  args: Record<string, unknown>,
  source: string = "tools",
): Promise<string> {
  const mapping = TOOL_MAP[toolName];
  if (!mapping) {
    return `Error: Unknown tool "${toolName}"`;
  }

  const resultPromise = new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Tool ${toolName} timed out after 30s`)),
      30000,
    );

    const unsub = bus.subscribe(mapping.responseType as any, (event: any) => {
      clearTimeout(timeout);
      unsub();
      resolve(JSON.stringify(event.payload, null, 2));
    });
  });

  await (bus as any).publish({
    type: mapping.requestType,
    source,
    payload: args,
  });

  return resultPromise;
}
