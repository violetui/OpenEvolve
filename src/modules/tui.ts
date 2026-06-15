/**
 * OpenEvolve TUI — native terminal scrollback + ANSI dock
 *
 * This implementation intentionally does NOT use blessed.screen().
 *
 * Layout:
 * 1. Native terminal scrollback area:
 *    - user messages
 *    - assistant messages
 *    - tool / browser / LLM / scout / repair messages
 * 2. Bottom ANSI dock:
 *    - current task activity
 *    - recent event activity
 *    - readline-powered user input
 *
 * Notes:
 * - No alternate screen buffer.
 * - No mouse tracking.
 * - No terminal scrollback clearing via ESC[3J.
 * - Uses the normal terminal buffer, so content that existed before startup remains in scrollback.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { EventBus } from "../core/event-bus";
import type { LLMService } from "../llm";

const A = {
  brand: "\x1b[38;5;39m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  inverse: "\x1b[7m",
  reset: "\x1b[0m",
};

// Kept as a semantic alias so the rest of the code reads similarly to the old blessed version.
const T = A;

const UI = {
  border: "\x1b[38;5;240m",
  panel: "\x1b[38;5;245m",
  accent: "\x1b[38;5;39m",
  subtle: "\x1b[38;5;244m",
  success: "\x1b[38;5;42m",
  warning: "\x1b[38;5;214m",
  danger: "\x1b[38;5;203m",
  tool: "\x1b[38;5;141m",
};

const GLYPH = {
  prompt: "❯",
  bullet: "•",
  branch: "↳",
  check: "✓",
  cross: "✗",
  run: "▶",
  idle: "◇",
  user: "◆",
  assistant: "✦",
  tool: "◈",
  system: "◇",
  repair: "✚",
  scout: "✣",
  llm: "✧",
  browser: "⌕",
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type ChainName = "repair" | "scout" | "browser" | "llm";

type Key = readline.Key & {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
};

export class OpenEvolveTUI {
  private readonly bus: EventBus;
  private readonly llm: LLMService;
  private readonly version: string;
  private readonly startedAt: Date;

  /** Preferred dock height. The actual height shrinks automatically on small terminals. */
  private readonly preferredDockHeight = 10;

  private spinnerIndex = 0;

  private currentTask = "idle";
  private activityLines: string[] = [];
  private readonly maxActivityLines = 200;

  private inputLine = "";
  private inputCursor = 0;
  private inputHistory: string[] = [];
  private historyIndex: number | null = null;

  private isRunning = false;

  private originalConsoleLog?: (...args: unknown[]) => void;
  private originalConsoleError?: (...args: unknown[]) => void;
  private logStream?: fs.WriteStream;

  private readonly chainState: Record<ChainName, string> = {
    repair: "idle",
    scout: "idle",
    browser: "idle",
    llm: "idle",
  };

  private readonly eventCounts = new Map<string, number>();

  private readonly onKeypress = (str: string, key: Key): void => {
    void this.handleKeypress(str, key);
  };

  private readonly onResize = (): void => {
    this.reserveTranscriptRegion();
    this.renderDock();
  };

  constructor(bus: EventBus, llm: LLMService, version = "0.1.0") {
    this.bus = bus;
    this.llm = llm;
    this.version = version;
    this.startedAt = new Date();
  }

  start(): void {
    this.isRunning = true;

    this.setupTerminal();
    this.createInput();
    this.redirectConsole();
    this.bindEvents();

    this.renderDock();

    this.appendChat(
      "system",
      `${T.brand}${T.bold}OpenEvolve${T.reset} v${this.version} ${T.dim}ready${T.reset}`,
    );
    this.appendChat(
      "system",
      `${T.dim}Native transcript stays in your terminal scrollback. The dock only renders live task/input state.${T.reset}`,
    );
    this.appendChat(
      "system",
      `${T.dim}Try ${T.reset}${T.cyan}/help${T.reset}${T.dim}, ${T.reset}${T.cyan}/tools${T.reset}${T.dim}, or type a message.${T.reset}`,
    );
    this.appendChat("system", "");
  }

  /**
   * Prepare the normal terminal buffer. This does not enter alternate screen.
   */
  private setupTerminal(): void {
    if (!process.stdout.isTTY) return;

    // Make fresh room for the dock without erasing previous terminal content.
    // Old visible lines are pushed into normal scrollback instead of being cleared.
    process.stdout.write("\n".repeat(this.getDockHeight()));

    this.reserveTranscriptRegion();
    process.stdout.write("\x1b[?25h"); // ensure cursor visible
  }

  /**
   * Capture input using readline's keypress parser, while keeping full control over drawing.
   */
  private createInput(): void {
    readline.emitKeypressEvents(process.stdin);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdin.resume();
    process.stdin.on("keypress", this.onKeypress);
    process.stdout.on("resize", this.onResize);
  }

  /**
   * Redirect console output to a log file so it doesn't corrupt the TUI layout.
   */
  private redirectConsole(): void {
    this.originalConsoleLog = console.log.bind(console);
    this.originalConsoleError = console.error.bind(console);

    const logsDir = path.resolve("logs");
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }

    const logPath = path.join(
      logsDir,
      `tui-${new Date().toISOString().replace(/[:.]/g, "-")}.log`,
    );
    this.logStream = fs.createWriteStream(logPath, { flags: "a" });

    const writeToFile = (level: string, args: unknown[]) => {
      const timestamp = new Date().toISOString();
      const msg = args
        .map((a) => {
          if (typeof a === "string") return a;
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        })
        .join(" ");

      this.logStream?.write(`[${timestamp}] [${level}] ${msg}\n`);
    };

    console.log = (...args: unknown[]) => writeToFile("log", args);
    console.error = (...args: unknown[]) => writeToFile("err", args);
  }

  private restoreConsole(): void {
    if (this.originalConsoleLog)
      console.log = this.originalConsoleLog as typeof console.log;
    if (this.originalConsoleError)
      console.error = this.originalConsoleError as typeof console.error;
    this.logStream?.end();
  }

  private bindEvents(): void {
    this.bus.subscribeAll((event) => {
      const type = event.type as string;
      const count = (this.eventCounts.get(type) ?? 0) + 1;
      this.eventCounts.set(type, count);

      this.updateChainState(type);
      this.currentTask = this.describeEventTask(event);

      const time = this.now();
      const color = this.getEventColor(type);
      const source = "source" in event ? String(event.source) : "unknown";
      const shortType = type.length > 36 ? `${type.slice(0, 33)}...` : type;

      this.pushActivity(
        this.formatActivityEvent({
          time,
          glyph: this.taskStatusGlyph(type),
          color,
          type: shortType,
          source,
          detail: this.currentTask,
        }),
      );

      this.renderDock();
    });

    // Agent responses -> native terminal transcript.
    this.bus.subscribe("agent.message.completed", (event) => {
      this.appendChat("assistant", event.payload.result);
    });

    this.bus.subscribe("agent.failure.reported", (event) => {
      this.appendChat(
        "error",
        `Failed: ${event.payload.message} (${event.payload.errorType})`,
      );
    });

    // Browser/tool messages -> native terminal transcript.
    this.bus.subscribe("browser.search.completed", (event) => {
      const count = event.payload.results.length;
      this.appendChat(
        "browser",
        `Search completed: "${event.payload.query}" -> ${count} results`,
      );
      for (const r of event.payload.results.slice(0, 3)) {
        this.appendChat("browser", `  ${T.blue}${r.title}${T.reset}`);
        this.appendChat("browser", `  ${T.dim}${r.url}${T.reset}`);
      }
    });

    this.bus.subscribe("browser.fetch.completed", (event) => {
      const preview = event.payload.content
        .substring(0, 100)
        .replace(/\n/g, " ");
      this.appendChat(
        "browser",
        `Page: ${event.payload.title} [${event.payload.statusCode}]`,
      );
      this.appendChat("browser", `  ${T.dim}${preview}...${T.reset}`);
    });

    // Feature Scout.
    this.bus.subscribe("feature.sources.discovered", (event) => {
      this.appendChat(
        "scout",
        `Discovered ${event.payload.sources.length} external sources`,
      );
    });

    this.bus.subscribe("feature.candidate.scored", (event) => {
      const status = event.payload.passed
        ? `${T.green}passed${T.reset}`
        : `${T.red}rejected${T.reset}`;
      this.appendChat(
        "scout",
        `Candidate score: ${event.payload.finalScore.toFixed(2)} ${status}`,
      );
    });

    this.bus.subscribe("plugin.installed", (event) => {
      this.appendChat(
        "scout",
        `${T.green}Plugin installed: ${event.payload.pluginName}${T.reset}`,
      );
    });

    // System.
    this.bus.subscribe("system.module.started", (event) => {
      this.appendChat(
        "system",
        `${T.dim}Module started: ${event.payload.moduleName}${T.reset}`,
      );
    });

    this.bus.subscribe("browser.ready", (event) => {
      this.appendChat(
        "system",
        `${T.green}Browser ready${T.reset} (${event.payload.headless ? "headless" : "headed"})`,
      );
    });

    // LLM.
    this.bus.subscribe("llm.chat.completed", (event) => {
      this.chainState.llm = "passed";
      const fallback = event.payload.fallbackUsed
        ? `${T.red} (fallback)${T.reset}`
        : "";
      this.appendChat(
        "llm",
        `${T.green}LLM${T.reset}: ${event.payload.modelName} completed in ${event.payload.durationMs}ms${fallback}` +
          (event.payload.tokensUsed
            ? ` (${event.payload.tokensUsed} tokens)`
            : ""),
      );
    });

    this.bus.subscribe("llm.chat.failed", (event) => {
      this.chainState.llm = "failed";
      this.appendChat(
        "llm",
        `${T.red}LLM failed${T.reset}: ${event.payload.modelId} - ${event.payload.error}`,
      );
    });

    this.bus.subscribe("llm.model.switched", (event) => {
      this.appendChat(
        "llm",
        `${T.yellow}Model switched${T.reset}: ${event.payload.previousModelId} -> ${event.payload.newModelId} (by ${event.payload.switchedBy})`,
      );
    });

    this.bus.subscribe("llm.route.updated", (event) => {
      this.appendChat(
        "llm",
        `${T.cyan}Route updated${T.reset}: ${event.payload.taskType} -> ${event.payload.newModelId}`,
      );
    });

    // Repair chain.
    this.bus.subscribe("evolution.patch.proposed", (event) => {
      this.appendChat(
        "repair",
        `${T.yellow}Patch proposed: ${event.payload.reason}${T.reset}`,
      );
    });

    this.bus.subscribe("evolution.eval.passed", () => {
      this.appendChat("repair", `${T.green}Eval passed${T.reset}`);
    });

    this.bus.subscribe("evolution.eval.failed", (event) => {
      this.appendChat(
        "repair",
        `${T.red}Eval failed: ${event.payload.reason}${T.reset}`,
      );
    });

    this.bus.subscribe("deploy.succeeded", (event) => {
      this.appendChat(
        "repair",
        `${T.green}Deploy succeeded: ${event.payload.version}${T.reset}`,
      );
    });
  }

  private async handleKeypress(str: string, key: Key): Promise<void> {
    if (!this.isRunning) return;

    if (key?.ctrl && key.name === "c") {
      this.shutdown();
      return;
    }

    switch (key?.name) {
      case "return":
      case "enter":
        await this.submitInput();
        return;

      case "backspace":
        if (this.inputCursor > 0) {
          this.inputLine =
            this.inputLine.slice(0, this.inputCursor - 1) +
            this.inputLine.slice(this.inputCursor);
          this.inputCursor -= 1;
        }
        this.renderDock();
        return;

      case "delete":
        if (this.inputCursor < this.inputLine.length) {
          this.inputLine =
            this.inputLine.slice(0, this.inputCursor) +
            this.inputLine.slice(this.inputCursor + 1);
        }
        this.renderDock();
        return;

      case "left":
        this.inputCursor = Math.max(0, this.inputCursor - 1);
        this.renderDock();
        return;

      case "right":
        this.inputCursor = Math.min(
          this.inputLine.length,
          this.inputCursor + 1,
        );
        this.renderDock();
        return;

      case "home":
        this.inputCursor = 0;
        this.renderDock();
        return;

      case "end":
        this.inputCursor = this.inputLine.length;
        this.renderDock();
        return;

      case "up":
        this.navigateHistory(-1);
        return;

      case "down":
        this.navigateHistory(1);
        return;

      case "escape":
        this.inputLine = "";
        this.inputCursor = 0;
        this.historyIndex = null;
        this.renderDock();
        return;

      default:
        break;
    }

    if (key?.ctrl && key.name === "u") {
      this.inputLine = this.inputLine.slice(this.inputCursor);
      this.inputCursor = 0;
      this.renderDock();
      return;
    }

    if (key?.ctrl && key.name === "k") {
      this.inputLine = this.inputLine.slice(0, this.inputCursor);
      this.renderDock();
      return;
    }

    if (str && !key?.ctrl && !key?.meta) {
      const printable = str.replace(/[\r\n]/g, "");
      if (printable) {
        this.inputLine =
          this.inputLine.slice(0, this.inputCursor) +
          printable +
          this.inputLine.slice(this.inputCursor);
        this.inputCursor += printable.length;
        this.historyIndex = null;
        this.renderDock();
      }
    }
  }

  private async submitInput(): Promise<void> {
    const text = this.inputLine.trim();
    this.inputLine = "";
    this.inputCursor = 0;
    this.historyIndex = null;
    this.renderDock();

    if (!text) return;

    this.inputHistory.push(text);
    if (this.inputHistory.length > 200) this.inputHistory.shift();

    try {
      await this.handleInput(text);
    } catch (error) {
      this.appendChat(
        "error",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.renderDock();
    }
  }

  private navigateHistory(direction: -1 | 1): void {
    if (this.inputHistory.length === 0) return;

    if (this.historyIndex === null) {
      this.historyIndex = direction < 0 ? this.inputHistory.length - 1 : null;
    } else {
      const next = this.historyIndex + direction;
      if (next < 0) this.historyIndex = 0;
      else if (next >= this.inputHistory.length) this.historyIndex = null;
      else this.historyIndex = next;
    }

    this.inputLine =
      this.historyIndex === null
        ? ""
        : (this.inputHistory[this.historyIndex] ?? "");
    this.inputCursor = this.inputLine.length;
    this.renderDock();
  }

  private async handleInput(text: string): Promise<void> {
    if (text.startsWith("/")) {
      await this.handleCommand(text);
    } else {
      this.appendChat("user", text);
      await this.bus.publish({
        type: "agent.message.received",
        source: "tui",
        payload: { message: text, userId: "tui-user" },
      });
    }
  }

  private async handleCommand(cmd: string): Promise<void> {
    const parts = cmd.split(/\s+/);
    const command = (parts[0] ?? "").toLowerCase();
    const args = parts.slice(1);

    switch (command) {
      case "/help":
        this.showHelp();
        break;

      case "/tools":
        this.showTools();
        break;

      case "/status":
        this.showStatus();
        break;

      case "/search":
      case "/s": {
        const query = args.join(" ");
        if (!query) {
          this.appendChat(
            "system",
            `${T.yellow}Usage: /search <query>${T.reset}`,
          );
          break;
        }
        this.appendChat("system", `${T.cyan}Searching: ${query}${T.reset}`);
        await this.bus.publish({
          type: "browser.search.requested",
          source: "tui",
          payload: { query },
        });
        break;
      }

      case "/fetch":
      case "/f": {
        const url = args[0];
        if (!url) {
          this.appendChat("system", `${T.yellow}Usage: /fetch <URL>${T.reset}`);
          break;
        }
        this.appendChat("system", `${T.cyan}Fetching: ${url}${T.reset}`);
        await this.bus.publish({
          type: "browser.fetch.requested",
          source: "tui",
          payload: { url },
        });
        break;
      }

      case "/scout": {
        const topics = args.length > 0 ? args : undefined;
        this.appendChat(
          "system",
          `${T.cyan}Triggering external feature scout...${T.reset}`,
        );
        await this.bus.publish({
          type: "feature.scout.requested",
          source: "tui",
          payload: { topics, triggeredBy: "manual" },
        });
        break;
      }

      case "/task": {
        const taskName = args[0];
        const taskUrl = args[1];
        if (!taskName || !taskUrl) {
          this.appendChat(
            "system",
            `${T.yellow}Usage: /task <name> <URL>${T.reset}`,
          );
          this.appendChat(
            "system",
            `${T.dim}Example: /task github-scout https://github.com/trending${T.reset}`,
          );
          break;
        }
        this.appendChat(
          "system",
          `${T.cyan}Running task: ${taskName}${T.reset}`,
        );
        await this.bus.publish({
          type: "browser.task.requested",
          source: "tui",
          payload: {
            taskName,
            steps: [
              { type: "navigate", value: taskUrl },
              { type: "wait", value: "2000" },
              { type: "extract" },
              { type: "screenshot" },
            ],
          },
        });
        break;
      }

      case "/screenshot":
      case "/ss": {
        const url = args[0];
        if (!url) {
          this.appendChat(
            "system",
            `${T.yellow}Usage: /screenshot <URL>${T.reset}`,
          );
          break;
        }
        this.appendChat("system", `${T.cyan}Screenshotting: ${url}${T.reset}`);
        await this.bus.publish({
          type: "browser.screenshot.requested",
          source: "tui",
          payload: { url, fullPage: true },
        });
        break;
      }

      case "/events": {
        const sorted = [...this.eventCounts.entries()].sort(
          (a, b) => b[1] - a[1],
        );
        this.appendChat("system", `${T.bold}Event Stats:${T.reset}`);
        for (const [type, count] of sorted) {
          this.appendChat("system", `  ${type}: ${count}`);
        }
        break;
      }

      case "/trigger": {
        const errorType = args[0] ?? "runtime_error";
        const message = args.slice(1).join(" ") || "Manual repair trigger test";
        this.appendChat(
          "system",
          `${T.yellow}Triggering repair: ${errorType} - ${message}${T.reset}`,
        );
        await this.bus.publish({
          type: "agent.failure.reported",
          source: "tui",
          payload: { errorType: errorType as "runtime_error", message },
        });
        break;
      }

      case "/clear":
        this.clearVisibleScreenOnly();
        this.activityLines = [];
        this.currentTask = "idle";
        this.renderDock();
        break;

      case "/model":
      case "/m": {
        const subCommand = args[0];
        if (!subCommand) {
          this.showModelStatus();
          break;
        }
        if (subCommand === "switch" || subCommand === "s") {
          const modelId = args[1];
          if (!modelId) {
            this.appendChat(
              "system",
              `${T.yellow}Usage: /model switch <model-id>${T.reset}`,
            );
            this.appendChat(
              "system",
              `${T.dim}Available: ${this.llm
                .getRegistry()
                .getAvailableModels()
                .map((m) => m.id)
                .join(", ")}${T.reset}`,
            );
            break;
          }
          const previousModelId = this.llm.getRegistry().getDefaultModelId();
          const result = this.llm.switchModel(modelId);
          if (result.success) {
            await this.bus.publish({
              type: "llm.model.switched",
              source: "tui",
              payload: {
                previousModelId,
                newModelId: modelId,
                switchedBy: "tui",
              },
            });
          }
          this.appendChat(
            "system",
            result.success
              ? `${T.green}${result.message}${T.reset}`
              : `${T.red}${result.message}${T.reset}`,
          );
        } else if (subCommand === "route" || subCommand === "r") {
          const taskType = args[1];
          const routeModelId = args[2];
          if (!taskType || !routeModelId) {
            this.appendChat(
              "system",
              `${T.yellow}Usage: /model route <task-type> <model-id>${T.reset}`,
            );
            this.appendChat(
              "system",
              `${T.dim}Task types: chat, patch_generate, feature_analyze, spec_generate, prototype_build, code_review, summarize${T.reset}`,
            );
            break;
          }
          const result = this.llm.setRoute(taskType as any, routeModelId);
          this.appendChat(
            "system",
            result.success
              ? `${T.green}${result.message}${T.reset}`
              : `${T.red}${result.message}${T.reset}`,
          );
        } else if (subCommand === "check") {
          this.appendChat(
            "system",
            `${T.cyan}Checking model availability...${T.reset}`,
          );
          const availability = await this.llm.checkAvailability();
          for (const [id, status] of availability) {
            const color =
              status === "available"
                ? T.green
                : status === "error"
                  ? T.red
                  : T.yellow;
            this.appendChat("system", `  ${color}${id}${T.reset}: ${status}`);
          }
        } else if (subCommand === "list" || subCommand === "l") {
          this.showModelList();
        } else {
          this.appendChat(
            "system",
            `${T.yellow}Unknown /model sub-command: ${subCommand}${T.reset}`,
          );
          this.appendChat(
            "system",
            `${T.dim}Usage: /model [list|switch|route|check]${T.reset}`,
          );
        }
        break;
      }

      case "/quit":
      case "/q":
        this.shutdown();
        break;

      default:
        this.appendChat(
          "system",
          `${T.red}Unknown command: ${command}${T.reset}`,
        );
        this.appendChat(
          "system",
          `${T.dim}Type /help to see all commands${T.reset}`,
        );
    }
  }

  private showHelp(): void {
    const lines = [
      `${T.bold}${T.brand}OpenEvolve${T.reset} ${T.dim}command palette${T.reset}`,
      ``,
      `${T.bold}Conversation${T.reset}`,
      `  <message>              send a message to the agent`,
      `  native scrollback       user / assistant / tool messages stay in terminal history`,
      ``,
      `${T.bold}Tools${T.reset}`,
      `  /tools                 show tool commands`,
      `  /search <query>        search via browser provider  (/s)`,
      `  /fetch <URL>           fetch page content          (/f)`,
      `  /screenshot <URL>      take page screenshot        (/ss)`,
      `  /task <name> <URL>     run browser automation task`,
      ``,
      `${T.bold}Agent Ops${T.reset}`,
      `  /scout [topics...]     trigger feature scout`,
      `  /trigger [type] [msg]  trigger repair pipeline`,
      `  /model                 model status               (/m)`,
      `  /model list            list models`,
      `  /model switch <id>     switch default model`,
      `  /model route <task> <id> set model route`,
      `  /model check           check availability`,
      ``,
      `${T.bold}System${T.reset}`,
      `  /status                show system status`,
      `  /events                show event statistics`,
      `  /clear                 clear visible screen only; keep scrollback`,
      `  /quit                  quit                        (/q, Ctrl+C)`,
      ``,
      `${T.dim}Keys: ↑/↓ history  ←/→ move  Ctrl+U clear left  Ctrl+K clear right  Esc clear input${T.reset}`,
    ];
    for (const line of lines) this.appendChat("help", line);
  }

  private showTools(): void {
    const lines = [
      `${T.bold}${T.brand}Tools${T.reset} ${T.dim}slash commands publish typed events${T.reset}`,
      ``,
      `  ${T.blue}/search${T.reset} <query>        ${T.dim}→ browser.search.requested${T.reset}`,
      `  ${T.blue}/fetch${T.reset} <URL>           ${T.dim}→ browser.fetch.requested${T.reset}`,
      `  ${T.blue}/screenshot${T.reset} <URL>      ${T.dim}→ browser.screenshot.requested${T.reset}`,
      `  ${T.blue}/task${T.reset} <name> <URL>     ${T.dim}→ browser.task.requested${T.reset}`,
      `  ${T.magenta}/scout${T.reset} [topics...]     ${T.dim}→ feature.scout.requested${T.reset}`,
      `  ${T.yellow}/trigger${T.reset} [type] [msg]  ${T.dim}→ agent.failure.reported${T.reset}`,
      ``,
      `${T.dim}Plain text is sent as agent.message.received.${T.reset}`,
    ];
    for (const line of lines) this.appendChat("tool", line);
  }

  private showStatus(): void {
    const uptime = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
    const h = Math.floor(uptime / 3600);
    const m = Math.floor((uptime % 3600) / 60);
    const s = uptime % 60;
    const totalEvents = [...this.eventCounts.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const st = this.llm.getStatus();

    const lines = [
      `${T.bold}${T.brand}OpenEvolve System Status${T.reset}`,
      ``,
      `  Version: v${this.version}`,
      `  Uptime:  ${h}h ${m}m ${s}s`,
      `  Events:  ${totalEvents}`,
      `  Current: ${this.currentTask}`,
      ``,
      `${T.bold}Evolution Chains${T.reset}`,
      `  Repair:  ${this.fmtState(this.chainState.repair)}`,
      `  Scout:   ${this.fmtState(this.chainState.scout)}`,
      `  Browser: ${this.fmtState(this.chainState.browser)}`,
      `  LLM:     ${this.fmtState(this.chainState.llm)}`,
      ``,
      `${T.bold}LLM Models${T.reset}`,
      `  Default:  ${T.green}${st.defaultModelId}${T.reset}`,
      `  Requests: ${st.usage.totalRequests}`,
      `  Tokens:   ${st.usage.totalTokens}`,
      `  Cost:     $${st.usage.estimatedCostUsd.toFixed(4)}`,
      ``,
      `${T.bold}Event Stats (Top 10)${T.reset}`,
    ];
    const sorted = [...this.eventCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10);
    for (const [type, count] of sorted) lines.push(`  ${type}: ${count}`);

    for (const line of lines) this.appendChat("status", line);
  }

  private showModelStatus(): void {
    const status = this.llm.getStatus();
    const lines = [
      `${T.bold}${T.brand}LLM Model Status${T.reset}`,
      ``,
      `  Default Model: ${T.green}${status.defaultModelId}${T.reset}`,
      `  Fallback Chain: ${status.fallbackChain.join(" -> ")}`,
      ``,
      `${T.bold}Models${T.reset}`,
    ];
    for (const m of status.models) {
      const c =
        m.status === "available"
          ? T.green
          : m.status === "error"
            ? T.red
            : T.yellow;
      const d =
        m.id === status.defaultModelId ? `${T.bold} (default)${T.reset}` : "";
      lines.push(
        `  ${c}${m.id}${T.reset}${d} - ${m.name} [${m.provider}] ${c}${m.status}${T.reset}`,
      );
    }
    lines.push("", `${T.bold}Routes${T.reset}`);
    for (const [task, modelId] of Object.entries(status.routes)) {
      lines.push(`  ${task}: ${T.cyan}${modelId}${T.reset}`);
    }
    lines.push("", `${T.bold}Usage${T.reset}`);
    lines.push(
      `  Requests: ${status.usage.totalRequests}`,
      `  Tokens:   ${status.usage.totalTokens}`,
      `  Cost:     $${status.usage.estimatedCostUsd.toFixed(4)}`,
    );
    for (const line of lines) this.appendChat("llm", line);
  }

  private showModelList(): void {
    const models = this.llm.getRegistry().getAllModels();
    const defaultId = this.llm.getRegistry().getDefaultModelId();
    const lines = [`${T.bold}${T.brand}Available Models${T.reset}`, ``];
    for (const m of models) {
      const c =
        m.status === "available"
          ? T.green
          : m.status === "error"
            ? T.red
            : T.yellow;
      const d = m.id === defaultId ? `${T.bold} [DEFAULT]${T.reset}` : "";
      lines.push(`${T.bold}${m.id}${T.reset}${d}`);
      lines.push(
        `  Name: ${m.name}`,
        `  Provider: ${m.provider}`,
        `  Model: ${m.model}`,
        `  Status: ${c}${m.status}${T.reset}`,
      );
      if (m.maxTokens) lines.push(`  Max Tokens: ${m.maxTokens}`);
      if (m.temperature !== undefined)
        lines.push(`  Temperature: ${m.temperature}`);
      if (m.costPer1kInput)
        lines.push(`  Cost In: $${m.costPer1kInput}/1K tokens`);
      if (m.costPer1kOutput)
        lines.push(`  Cost Out: $${m.costPer1kOutput}/1K tokens`);
      if (m.priority) lines.push(`  Priority: ${m.priority}`);
      lines.push("");
    }
    for (const line of lines) this.appendChat("llm", line);
  }

  // ===== Native transcript =====

  private appendChat(role: string, text: string): void {
    const block = this.formatTranscriptBlock(role, text);
    this.writeTranscript(block);
  }

  private formatTranscriptBlock(role: string, text: string): string {
    const cfg = this.getRoleConfig(role);
    const rawText = String(text ?? "");
    const isMarkdown =
      this.isAssistantRole(role) && this.isLikelyMarkdown(rawText);
    const time = `${A.dim}${this.now()}${A.reset}`;
    const markdownBadge = isMarkdown ? ` ${A.dim}markdown${A.reset}` : "";
    const header = `${cfg.color}${cfg.glyph} ${cfg.label}${A.reset}${markdownBadge} ${time}`;
    const width = Math.max(40, this.getCols() - 4);
    const body = isMarkdown
      ? this.renderMarkdownLines(rawText, width - 4)
      : rawText
          .split(/\r?\n/)
          .flatMap((line) => this.wrapPlainLine(line, width - 4));

    if (
      body.length === 0 ||
      body.every((line) => this.stripAnsi(line).length === 0)
    ) {
      return header;
    }

    const bodyLines = body.map((line) => `${A.dim}│${A.reset} ${line}`);
    return [header, ...bodyLines].join("\n");
  }

  private writeTranscript(text: string): void {
    if (!process.stdout.isTTY) {
      process.stdout.write(`${this.stripAnsi(text)}\n`);
      return;
    }

    this.reserveTranscriptRegion();

    const bottom = this.getTranscriptBottom();
    readline.cursorTo(process.stdout, 0, bottom - 1);

    for (const line of text.split(/\r?\n/)) {
      process.stdout.write(`${line}${A.reset}\n`);
    }

    this.renderDock();
  }

  private getRoleConfig(role: string): {
    label: string;
    glyph: string;
    color: string;
  } {
    const p: Record<string, { label: string; glyph: string; color: string }> = {
      user: { label: "User", glyph: GLYPH.user, color: T.green },
      agent: { label: "Assistant", glyph: GLYPH.assistant, color: T.cyan },
      assistant: { label: "Assistant", glyph: GLYPH.assistant, color: T.cyan },
      system: { label: "System", glyph: GLYPH.system, color: T.gray },
      error: { label: "Error", glyph: GLYPH.cross, color: T.red },
      help: { label: "Help", glyph: "?", color: T.brand },
      status: { label: "Status", glyph: GLYPH.idle, color: T.brand },
      tool: { label: "Tool", glyph: GLYPH.tool, color: T.yellow },
      browser: { label: "Browser", glyph: GLYPH.browser, color: T.blue },
      scout: { label: "Scout", glyph: GLYPH.scout, color: T.magenta },
      repair: { label: "Repair", glyph: GLYPH.repair, color: T.yellow },
      llm: { label: "LLM", glyph: GLYPH.llm, color: T.magenta },
    };
    return p[role] ?? { label: role, glyph: GLYPH.bullet, color: T.white };
  }

  private isAssistantRole(role: string): boolean {
    return role === "assistant" || role === "agent";
  }

  /**
   * Fast heuristic: only render as Markdown when the assistant output clearly
   * contains Markdown structure. Plain prose stays plain, which avoids false
   * positives such as "2 * 3" or paths with underscores.
   */
  private isLikelyMarkdown(text: string): boolean {
    const s = String(text ?? "").trim();
    if (!s) return false;

    const lines = s.split(/\r?\n/);
    const mdSignals = [
      /^#{1,6}\s+\S/m, // ATX heading
      /^\s*([-*+]|\d+[.)])\s+\S/m, // unordered / ordered list
      /^\s*>\s+\S/m, // blockquote
      /^\s*```[\s\S]*?```\s*$/m, // fenced code block
      /^\s*~~~[\s\S]*?~~~\s*$/m, // fenced code block
      /^\s{0,3}[-*_]{3,}\s*$/m, // horizontal rule
      /`[^`\n]+`/, // inline code
      /\[[^\]\n]+\]\([^\s)]+\)/, // link
      /(^|\s)(\*\*|__)[^\n]+\2(\s|$)/, // bold
      /(^|\s)(\*|_)[^\n]+\2(\s|$)/, // italic
      /^\s*\|.+\|\s*$/m, // table-ish row
    ];

    let score = 0;
    for (const signal of mdSignals) {
      if (signal.test(s)) score += 1;
    }

    const hasFence = /^\s*(```|~~~)/m.test(s);
    const hasMultipleStructuredLines =
      lines.filter((line) =>
        /^\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|\|.+\|\s*$)/.test(line),
      ).length >= 2;

    return hasFence || hasMultipleStructuredLines || score >= 2;
  }

  private renderMarkdownLines(markdown: string, width: number): string[] {
    const lines = String(markdown ?? "")
      .replace(/\r\n/g, "\n")
      .split("\n");
    const rendered: string[] = [];
    let inFence = false;
    let fenceMarker = "";
    let fenceLang = "";

    const pushWrapped = (line: string) => {
      rendered.push(...this.wrapAnsiLine(line, width));
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\t/g, "  ");
      const fenceMatch = line.match(/^\s*(```|~~~)\s*([\w.+-]*)\s*$/);

      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceMarker = fenceMatch[1] ?? "```";
          fenceLang = fenceMatch[2] ?? "";
          rendered.push(
            `${UI.border}╭─${A.reset} ${UI.tool}${fenceLang || "code"}${A.reset}`,
          );
        } else if (line.trim().startsWith(fenceMarker)) {
          inFence = false;
          fenceMarker = "";
          fenceLang = "";
          rendered.push(
            `${UI.border}╰${"─".repeat(Math.max(8, Math.min(width - 1, 24)))}${A.reset}`,
          );
        }
        continue;
      }

      if (inFence) {
        rendered.push(
          `${UI.border}│${A.reset} ${UI.panel}${line || " "}${A.reset}`,
        );
        continue;
      }

      if (/^\s*$/.test(line)) {
        rendered.push("");
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        const title = this.renderMarkdownInline(heading[2]);
        const marker = level <= 2 ? "━" : "─";
        pushWrapped(
          `${UI.accent}${A.bold}${marker.repeat(Math.max(1, 4 - Math.min(level, 3)))} ${title}${A.reset}`,
        );
        continue;
      }

      if (/^\s{0,3}[-*_]{3,}\s*$/.test(line)) {
        rendered.push(
          `${UI.border}${"─".repeat(Math.max(8, Math.min(width, 72)))}${A.reset}`,
        );
        continue;
      }

      const quote = line.match(/^\s*>\s?(.*)$/);
      if (quote) {
        pushWrapped(
          `${UI.border}▌${A.reset} ${A.dim}${this.renderMarkdownInline(quote[1] ?? "")}${A.reset}`,
        );
        continue;
      }

      const taskItem = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/);
      if (taskItem) {
        const checked = taskItem[1].toLowerCase() === "x";
        const icon = checked
          ? `${UI.success}${GLYPH.check}${A.reset}`
          : `${UI.subtle}□${A.reset}`;
        pushWrapped(`  ${icon} ${this.renderMarkdownInline(taskItem[2])}`);
        continue;
      }

      const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
      if (unordered) {
        const indent = " ".repeat(
          Math.min(Math.floor((unordered[1] ?? "").length / 2) * 2, 6),
        );
        pushWrapped(
          `${indent}${UI.accent}${GLYPH.bullet}${A.reset} ${this.renderMarkdownInline(unordered[2])}`,
        );
        continue;
      }

      const ordered = line.match(/^(\s*)\d+[.)]\s+(.+)$/);
      if (ordered) {
        const index = (line.match(/^\s*(\d+)/)?.[1] ?? "1").padStart(2, " ");
        const indent = " ".repeat(
          Math.min(Math.floor((ordered[1] ?? "").length / 2) * 2, 6),
        );
        pushWrapped(
          `${indent}${UI.subtle}${index}.${A.reset} ${this.renderMarkdownInline(ordered[2])}`,
        );
        continue;
      }

      if (/^\s*\|.+\|\s*$/.test(line)) {
        rendered.push(this.renderMarkdownTableLine(line, width));
        continue;
      }

      pushWrapped(this.renderMarkdownInline(line));
    }

    while (rendered.length > 0 && rendered[rendered.length - 1] === "") {
      rendered.pop();
    }

    return rendered;
  }

  private renderMarkdownTableLine(line: string, width: number): string {
    const trimmed = line.trim();
    if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(trimmed)) {
      return `${UI.border}${"─".repeat(Math.max(8, Math.min(width, 72)))}${A.reset}`;
    }
    const cells = trimmed.replace(/^\|/, "").replace(/\|$/, "").split("|");
    const renderedCells = cells.map(
      (cell) => ` ${this.renderMarkdownInline(cell.trim())} `,
    );
    return `${UI.border}│${A.reset}${renderedCells.join(`${UI.border}│${A.reset}`)}${UI.border}│${A.reset}`;
  }

  private renderMarkdownInline(text: string): string {
    const placeholders: string[] = [];
    const stash = (value: string): string => {
      const token = `\u0000${placeholders.length}\u0000`;
      placeholders.push(value);
      return token;
    };

    let out = String(text ?? "");

    out = out.replace(/`([^`\n]+)`/g, (_m, code: string) =>
      stash(`${UI.tool}${A.inverse} ${code} ${A.reset}`),
    );

    out = out.replace(
      /\[([^\]\n]+)\]\(([^\s)]+)\)/g,
      (_m, label: string, url: string) =>
        stash(
          `${A.underline}${UI.accent}${label}${A.reset}${A.dim} (${url})${A.reset}`,
        ),
    );

    out = out.replace(
      /(\*\*|__)(.+?)\1/g,
      (_m, _marker: string, value: string) => `${A.bold}${value}${A.reset}`,
    );

    out = out.replace(
      /(^|\s)(\*|_)([^*_\n]+?)\2(?=\s|$|[.,;:!?])/g,
      (_m, lead: string, _marker: string, value: string) =>
        `${lead}${A.italic}${value}${A.reset}`,
    );

    out = out.replace(
      /~~(.+?)~~/g,
      (_m, value: string) => `${A.dim}${value}${A.reset}`,
    );

    return out.replace(
      /\u0000(\d+)\u0000/g,
      (_m, index: string) => placeholders[Number(index)] ?? "",
    );
  }

  private wrapAnsiLine(line: string, width: number): string[] {
    if (width <= 0) return [line];
    if (this.visibleLength(line) <= width) return [line];

    const chunks: string[] = [];
    let current = "";
    let visible = 0;
    let i = 0;

    while (i < line.length) {
      if (line[i] === "\x1b") {
        const match = line.slice(i).match(/^\x1b\[[0-9;?]*[ -/]*[@-~]/);
        if (match) {
          current += match[0];
          i += match[0].length;
          continue;
        }
      }

      const char = line[i] ?? "";
      if (visible >= width && char !== " ") {
        chunks.push(current.trimEnd() + A.reset);
        current = "";
        visible = 0;
      }

      current += char;
      visible += 1;
      i += 1;

      if (visible >= width && char === " ") {
        chunks.push(current.trimEnd() + A.reset);
        current = "";
        visible = 0;
      }
    }

    if (current.length > 0) chunks.push(current.trimEnd());
    return chunks.length ? chunks : [""];
  }

  // ===== ANSI dock =====

  private renderDock(): void {
    if (!process.stdout.isTTY || !this.isRunning) return;

    this.spinnerIndex = (this.spinnerIndex + 1) % SPINNER.length;

    const rows = this.getRows();
    const cols = this.getCols();
    const dockHeight = this.getDockHeight();
    const dockTop = rows - dockHeight + 1; // 1-based
    const activityCapacity = Math.max(1, dockHeight - 6);
    const recentActivity = this.activityLines.slice(-activityCapacity);

    const lines: string[] = [];
    lines.push(this.formatDockHeader(cols));
    lines.push(this.formatTaskLine(cols));

    if (recentActivity.length === 0) {
      lines.push(
        `${UI.border}│${A.reset} ${A.dim}no tool activity yet${A.reset}`,
      );
    } else {
      for (const line of recentActivity)
        lines.push(`${UI.border}│${A.reset} ${line}`);
    }

    while (lines.length < dockHeight - 3) lines.push(`${UI.border}│${A.reset}`);

    lines.push(this.formatChainLine(cols));
    lines.push(this.formatHintLine(cols));
    lines.push(this.formatInputLine(cols));

    process.stdout.write("[?25l");

    for (let i = 0; i < dockHeight; i++) {
      readline.cursorTo(process.stdout, 0, dockTop - 1 + i);
      readline.clearLine(process.stdout, 0);
      process.stdout.write(this.fitAnsiLine(lines[i] ?? "", cols));
    }

    const inputRow = rows - 1;
    const inputPrefix = this.getInputPrefix();
    const inputCol = Math.min(
      cols - 1,
      this.visibleLength(
        `${inputPrefix}${this.inputLine.slice(0, this.inputCursor)}`,
      ),
    );
    readline.cursorTo(process.stdout, inputCol, inputRow);
    process.stdout.write("[?25h");
  }

  private formatDockHeader(cols: number): string {
    const model = this.safeDefaultModelId();
    const cwd = this.shortenMiddle(
      process.cwd(),
      Math.max(12, Math.floor(cols / 4)),
    );
    const brand = `${UI.accent}${A.bold}OpenEvolve${A.reset}${A.dim} v${this.version}${A.reset}`;
    const right = `${A.dim}${GLYPH.branch} ${cwd}${A.reset}${model ? ` ${A.dim}•${A.reset} ${UI.tool}${model}${A.reset}` : ""}`;
    const visible = this.visibleLength(brand) + this.visibleLength(right) + 4;
    const fill = "─".repeat(Math.max(1, cols - visible));
    return `${UI.border}╭─${A.reset} ${brand} ${UI.border}${fill}${A.reset} ${right}`;
  }

  private formatTaskLine(cols: number): string {
    const busy = this.isBusy();
    const spinner = busy
      ? `${UI.warning}${SPINNER[this.spinnerIndex]}${A.reset}`
      : `${UI.success}${GLYPH.check}${A.reset}`;
    const state = busy
      ? this.pill("working", UI.warning)
      : this.pill("ready", UI.success);
    const task = this.currentTask || "idle";
    const text = `${UI.border}│${A.reset} ${spinner} ${state} ${A.bold}Task${A.reset} ${A.dim}${GLYPH.branch}${A.reset} ${task}`;
    return this.fitAnsiLine(text, cols);
  }

  private formatChainLine(cols: number): string {
    const totalEvents = [...this.eventCounts.values()].reduce(
      (a, b) => a + b,
      0,
    );
    const chains = [
      this.chainPill("repair", this.chainState.repair),
      this.chainPill("scout", this.chainState.scout),
      this.chainPill("browser", this.chainState.browser),
      this.chainPill("llm", this.chainState.llm),
    ].join(" ");
    const line = `${UI.border}│${A.reset} ${chains} ${A.dim}events ${totalEvents}${A.reset}`;
    return this.fitAnsiLine(line, cols);
  }

  private formatHintLine(cols: number): string {
    const hint = `${A.dim}/help  /tools  /status  /model  /quit    ↑↓ history  Ctrl+U/K edit  Esc clear${A.reset}`;
    return this.fitAnsiLine(`${UI.border}│${A.reset} ${hint}`, cols);
  }

  private formatInputLine(cols: number): string {
    const prefix = this.getInputPrefix();
    const placeholder = this.inputLine
      ? ""
      : `${A.dim}message or /command${A.reset}`;
    return this.fitAnsiLine(`${prefix}${this.inputLine || placeholder}`, cols);
  }

  private getInputPrefix(): string {
    return `${UI.border}╰─${A.reset}${A.green}${A.bold}${GLYPH.prompt}${A.reset} `;
  }

  private pill(label: string, color: string): string {
    return `${color}${A.bold}${label}${A.reset}`;
  }

  private chainPill(label: ChainName, state: string): string {
    const color =
      state === "running"
        ? UI.warning
        : state === "passed"
          ? UI.success
          : state === "failed"
            ? UI.danger
            : UI.subtle;
    const icon =
      state === "running"
        ? GLYPH.run
        : state === "passed"
          ? GLYPH.check
          : state === "failed"
            ? GLYPH.cross
            : GLYPH.idle;
    return `${color}${icon} ${label}:${state}${A.reset}`;
  }

  private reserveTranscriptRegion(): void {
    if (!process.stdout.isTTY) return;
    const bottom = this.getTranscriptBottom();
    process.stdout.write(`\x1b[1;${bottom}r`);
  }

  private restoreTranscriptRegion(): void {
    if (!process.stdout.isTTY) return;
    process.stdout.write("\x1b[r");
  }

  private clearVisibleScreenOnly(): void {
    if (!process.stdout.isTTY) return;
    this.restoreTranscriptRegion();
    process.stdout.write("\x1b[2J\x1b[H"); // intentionally no ESC[3J; keep terminal scrollback
    this.reserveTranscriptRegion();
  }

  private clearDock(): void {
    if (!process.stdout.isTTY) return;
    const rows = this.getRows();
    const dockHeight = this.getDockHeight();
    const dockTop = rows - dockHeight + 1;

    this.restoreTranscriptRegion();
    for (let i = 0; i < dockHeight; i++) {
      readline.cursorTo(process.stdout, 0, dockTop - 1 + i);
      readline.clearLine(process.stdout, 0);
    }
    this.reserveTranscriptRegion();
  }

  private formatActivityEvent(event: {
    time: string;
    glyph: string;
    color: string;
    type: string;
    source: string;
    detail: string;
  }): string {
    const source =
      event.source && event.source !== "unknown"
        ? ` ${A.dim}from ${event.source}${A.reset}`
        : "";
    return `${A.dim}${event.time}${A.reset} ${event.glyph} ${event.color}${event.type}${A.reset}${source} ${A.dim}${GLYPH.branch}${A.reset} ${event.detail}`;
  }

  private isBusy(): boolean {
    return Object.values(this.chainState).some((state) => state === "running");
  }

  private safeDefaultModelId(): string {
    try {
      return (
        this.llm.getRegistry?.().getDefaultModelId?.() ??
        this.llm.getStatus?.().defaultModelId ??
        ""
      );
    } catch {
      return "";
    }
  }

  private shortenMiddle(value: string, max: number): string {
    if (value.length <= max) return value;
    if (max <= 3) return value.slice(0, max);
    const left = Math.ceil((max - 1) / 2);
    const right = Math.floor((max - 1) / 2);
    return `${value.slice(0, left)}…${value.slice(value.length - right)}`;
  }

  private wrapPlainLine(line: string, width: number): string[] {
    const plain = String(line ?? "");
    if (plain.length <= width) return [plain];

    const result: string[] = [];
    let rest = plain;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut <= 0) cut = width;
      result.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    result.push(rest);
    return result;
  }

  private fitAnsiLine(text: string, cols: number): string {
    const visible = this.visibleLength(text);
    if (visible === cols) return text;
    if (visible < cols) return text + " ".repeat(cols - visible);

    // Keep truncation simple and safe: strip ANSI if a line is too long.
    const plain = this.stripAnsi(text);
    if (plain.length <= cols) return plain;
    return plain.slice(0, Math.max(0, cols - 1)) + "…";
  }

  private visibleLength(text: string): number {
    return this.stripAnsi(text).length;
  }

  private stripAnsi(text: string): string {
    return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }

  private getRows(): number {
    return process.stdout.rows || 24;
  }

  private getCols(): number {
    return process.stdout.columns || 80;
  }

  private getDockHeight(): number {
    const rows = this.getRows();
    return Math.min(
      this.preferredDockHeight,
      Math.max(5, Math.floor(rows / 3)),
    );
  }

  private getTranscriptBottom(): number {
    return Math.max(1, this.getRows() - this.getDockHeight());
  }

  private pushActivity(line: string): void {
    this.activityLines.push(line);
    if (this.activityLines.length > this.maxActivityLines) {
      this.activityLines.splice(
        0,
        this.activityLines.length - this.maxActivityLines,
      );
    }
  }

  // ===== Task state helpers =====

  private describeEventTask(event: any): string {
    const type = String(event.type ?? "event");
    const payload = event.payload ?? {};

    switch (type) {
      case "agent.message.received":
        return "agent is processing user message";
      case "llm.chat.requested":
        return payload.modelId
          ? `LLM chat requested: ${payload.modelId}`
          : "LLM chat requested";
      case "browser.search.requested":
        return `search: ${payload.query ?? ""}`.trim();
      case "browser.fetch.requested":
        return `fetch: ${payload.url ?? ""}`.trim();
      case "browser.screenshot.requested":
        return `screenshot: ${payload.url ?? ""}`.trim();
      case "browser.task.requested":
        return `browser task: ${payload.taskName ?? "unnamed"}`;
      case "feature.scout.requested":
        return `feature scout${payload.topics ? `: ${payload.topics.join(", ")}` : ""}`;
      case "agent.failure.reported":
        return `repair trigger: ${payload.errorType ?? "unknown"}`;
      case "llm.chat.completed":
        return `LLM completed${payload.durationMs ? ` in ${payload.durationMs}ms` : ""}`;
      case "llm.chat.failed":
        return `LLM failed: ${payload.modelId ?? "unknown"}`;
      default:
        return type;
    }
  }

  private taskStatusGlyph(eventType: string): string {
    if (this.isFailureEvent(eventType)) return `${A.red}✗${A.reset}`;
    if (this.isSuccessEvent(eventType)) return `${A.green}✓${A.reset}`;
    if (this.isRunningEvent(eventType)) return `${A.yellow}▶${A.reset}`;
    return `${A.gray}•${A.reset}`;
  }

  private isRunningEvent(eventType: string): boolean {
    return (
      eventType.endsWith(".requested") ||
      [
        "agent.message.received",
        "agent.failure.reported",
        "evolution.analysis.requested",
        "evolution.patch.proposed",
        "evolution.patch.applied",
        "evolution.eval.requested",
        "feature.sources.discovered",
        "feature.candidate.found",
        "feature.candidate.scored",
        "feature.spec.generated",
        "feature.prototype.requested",
        "feature.prototype.created",
        "feature.eval.requested",
      ].includes(eventType)
    );
  }

  private isSuccessEvent(eventType: string): boolean {
    return (
      eventType.endsWith(".completed") ||
      eventType.endsWith(".passed") ||
      [
        "release.created",
        "deploy.succeeded",
        "plugin.installed",
        "browser.ready",
      ].includes(eventType)
    );
  }

  private isFailureEvent(eventType: string): boolean {
    return (
      eventType.endsWith(".failed") ||
      [
        "deploy.rollbacked",
        "browser.action.failed",
        "llm.chat.failed",
      ].includes(eventType)
    );
  }

  private updateChainState(eventType: string): void {
    const running: Record<ChainName, string[]> = {
      repair: [
        "agent.failure.reported",
        "evolution.analysis.requested",
        "evolution.patch.proposed",
        "evolution.patch.applied",
        "evolution.eval.requested",
      ],
      scout: [
        "feature.scout.requested",
        "feature.sources.discovered",
        "feature.candidate.found",
        "feature.candidate.scored",
        "feature.spec.generated",
        "feature.prototype.requested",
        "feature.prototype.created",
        "feature.eval.requested",
      ],
      browser: [
        "browser.search.requested",
        "browser.fetch.requested",
        "browser.task.requested",
        "browser.screenshot.requested",
      ],
      llm: ["llm.chat.requested"],
    };
    const success: Record<ChainName, string[]> = {
      repair: ["evolution.eval.passed", "release.created", "deploy.succeeded"],
      scout: ["feature.eval.passed", "plugin.installed"],
      browser: [
        "browser.search.completed",
        "browser.fetch.completed",
        "browser.task.completed",
        "browser.screenshot.completed",
      ],
      llm: ["llm.chat.completed"],
    };
    const fail: Record<ChainName, string[]> = {
      repair: ["evolution.eval.failed", "deploy.rollbacked"],
      scout: ["feature.eval.failed"],
      browser: ["browser.action.failed"],
      llm: ["llm.chat.failed"],
    };

    for (const chain of ["repair", "scout", "browser", "llm"] as ChainName[]) {
      if (running[chain].includes(eventType))
        this.chainState[chain] = "running";
      else if (success[chain].includes(eventType))
        this.chainState[chain] = "passed";
      else if (fail[chain].includes(eventType))
        this.chainState[chain] = "failed";
    }
  }

  private fmtState(state: string): string {
    switch (state) {
      case "running":
        return `${UI.warning}${GLYPH.run} running${T.reset}`;
      case "passed":
        return `${UI.success}${GLYPH.check} passed${T.reset}`;
      case "failed":
        return `${UI.danger}${GLYPH.cross} failed${T.reset}`;
      default:
        return `${T.dim}${GLYPH.idle} idle${T.reset}`;
    }
  }

  private getEventColor(type: string): string {
    if (type.startsWith("agent.")) return A.green;
    if (type.startsWith("evolution.")) return A.yellow;
    if (type.startsWith("release.") || type.startsWith("deploy."))
      return A.magenta;
    if (type.startsWith("feature.")) return A.cyan;
    if (type.startsWith("plugin.")) return A.blue;
    if (type.startsWith("browser.")) return A.blue;
    if (type.startsWith("llm.")) return A.magenta;
    if (type.startsWith("system.")) return A.gray;
    return A.white;
  }

  private now(): string {
    return new Date().toLocaleTimeString("en-US", { hour12: false });
  }

  private shutdown(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    this.appendChat(
      "system",
      `${T.yellow}Shutting down OpenEvolve...${T.reset}`,
    );

    process.stdin.off("keypress", this.onKeypress);
    process.stdout.off("resize", this.onResize);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }

    this.restoreTranscriptRegion();
    this.clearDock();
    this.restoreTranscriptRegion();

    const rows = this.getRows();
    readline.cursorTo(process.stdout, 0, rows - 1);
    readline.clearLine(process.stdout, 0);
    process.stdout.write("\n");
    process.stdout.write("\x1b[?25h");

    this.restoreConsole();
    process.exit(0);
  }
}
