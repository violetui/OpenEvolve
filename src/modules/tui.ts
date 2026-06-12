/**
 * OpenEvolve TUI — Terminal Interactive Interface
 *
 * Layout:
 * ┌─────────────────────────────────────────────────┐
 * │  OpenEvolve v0.1.0          [Status Bar]        │
 * ├──────────────────────┬──────────────────────────┤
 * │                      │                          │
 * │   Chat Panel         │   Event Log Panel        │
 * │                      │                          │
 * │                      │                          │
 * │                      │                          │
 * ├──────────────────────┴──────────────────────────┤
 * │  Chain Status: Repair Scout Browser             │
 * ├─────────────────────────────────────────────────┤
 * │  > Enter message or command (/help for help)    │
 * └─────────────────────────────────────────────────┘
 */

import blessed from "blessed";
import type { Widgets } from "blessed";
import type { EventBus } from "../core/event-bus";
import type { EventType } from "../core/event-types";
import type { LLMService } from "../llm";

// ANSI colors
const C = {
  brand: "{cyan-fg}",
  green: "{green-fg}",
  red: "{red-fg}",
  yellow: "{yellow-fg}",
  blue: "{blue-fg}",
  magenta: "{magenta-fg}",
  cyan: "{cyan-fg}",
  white: "{white-fg}",
  gray: "{gray-fg}",
  dim: "{#666-fg}",
  bold: "{bold}",
  reset: "{/}",
};

export class OpenEvolveTUI {
  private screen!: Widgets.Screen;
  private chatBox!: Widgets.BoxElement;
  private eventBox!: Widgets.Log;
  private inputBar!: Widgets.TextboxElement;
  private chainBar!: Widgets.BoxElement;

  private bus: EventBus;
  private llm: LLMService;
  private version: string;
  private startedAt: Date;

  // Chain states
  private chainState = {
    repair: "idle",
    scout: "idle",
    browser: "idle",
    llm: "idle",
  };

  // Event counts
  private eventCounts = new Map<string, number>();

  constructor(bus: EventBus, llm: LLMService, version = "0.1.0") {
    this.bus = bus;
    this.llm = llm;
    this.version = version;
    this.startedAt = new Date();
  }

  /**
   * Initialize and start the TUI
   */
  start(): void {
    this.createScreen();
    this.createLayout();
    this.bindEvents();

    this.screen.render();

    // Focus on input bar
    this.inputBar.focus();

    // Welcome messages
    this.appendChat("system", `${C.brand}${C.bold}OpenEvolve${C.reset} v${this.version}`);
    this.appendChat("system", "Event-driven self-evolving agent");
    this.appendChat("system", `${C.dim}Type a message to chat with the agent, or use / prefix for commands${C.reset}`);
    this.appendChat("system", `${C.dim}Type /help to see all commands${C.reset}`);
    this.appendChat("system", "");
  }

  /**
   * Create Screen
   */
  private createScreen(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "OpenEvolve",
      fullUnicode: true,
      dockBorders: true,
    });

    // Global shortcuts
    this.screen.key(["C-c"], () => {
      this.appendChat("system", `${C.yellow}Shutting down OpenEvolve...${C.reset}`);
      this.screen.destroy();
      process.exit(0);
    });

    this.screen.key(["escape"], () => {
      this.inputBar.focus();
    });
  }

  /**
   * Create full layout
   */
  private createLayout(): void {
    // ===== Top title bar =====
    blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      content: ` ${C.brand}${C.bold}OpenEvolve${C.reset} v${this.version}  |  Event-Driven Self-Evolving Agent`,
      style: {
        bg: "#1a1a2e",
        fg: "white",
      },
    });

    // ===== Left: Chat Panel =====
    this.chatBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: "55%",
      height: "100%-4",
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: " ",
        track: { bg: "#333" },
        style: { inverse: true },
      },
      border: "line",
      label: ` ${C.brand}Chat${C.reset} `,
      style: {
        border: { fg: "#444" },
      },
      padding: { left: 1, right: 1 },
    });

    // ===== Right: Event Log Panel =====
    this.eventBox = blessed.log({
      parent: this.screen,
      top: 1,
      left: "55%",
      width: "45%",
      height: "100%-4",
      scrollable: true,
      alwaysScroll: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: " ",
        track: { bg: "#333" },
        style: { inverse: true },
      },
      border: "line",
      label: ` ${C.cyan}Event Log${C.reset} `,
      style: {
        border: { fg: "#444" },
      },
      padding: { left: 1, right: 1 },
    });

    // ===== Chain status bar =====
    this.chainBar = blessed.box({
      parent: this.screen,
      bottom: 2,
      left: 0,
      width: "100%",
      height: 1,
      content: this.formatChainBar(),
      style: {
        bg: "#16213e",
        fg: "white",
      },
    });

    // ===== Input bar =====
    this.inputBar = blessed.textbox({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      inputOnFocus: true,
      border: {
        type: "line",
      },
      style: {
        border: { fg: "#0f3460" },
        focus: {
          border: { fg: "cyan" },
        },
      },
      placeholder: " Enter message or command (/help for help)",
    });

    // Input submit handler
    this.inputBar.on("submit", (value: string) => {
      const text = (value ?? "").trim();
      if (text) {
        this.handleInput(text);
      }
      this.inputBar.clearValue();
      this.screen.render();
      // Re-focus input bar
      setTimeout(() => this.inputBar.focus(), 10);
    });
  }

  /**
   * Bind event listeners
   */
  private bindEvents(): void {
    // Listen to all events and write to Event Log
    this.bus.subscribeAll((event) => {
      const type = event.type as string;
      const count = (this.eventCounts.get(type) ?? 0) + 1;
      this.eventCounts.set(type, count);

      // Update chain state
      this.updateChainState(type);

      // Write to event log
      const time = new Date().toLocaleTimeString("en-US", { hour12: false });
      const color = this.getEventColor(type);
      const shortType = type.length > 30 ? type.substring(0, 27) + "..." : type;
      this.eventBox.log(
        `${C.dim}${time}${C.reset} ${color}${shortType}${C.reset} ${C.dim}${event.source}${C.reset}`
      );

      // Update chain status bar
      this.chainBar.setContent(this.formatChainBar());
      this.screen.render();
    });

    // Listen to agent responses and write to Chat
    this.bus.subscribe("agent.message.completed", (event) => {
      this.appendChat("agent", event.payload.result);
    });

    this.bus.subscribe("agent.failure.reported", (event) => {
      this.appendChat("error", `Failed: ${event.payload.message} (${event.payload.errorType})`);
    });

    // Browser search results
    this.bus.subscribe("browser.search.completed", (event) => {
      const count = event.payload.results.length;
      this.appendChat("browser", `Search completed: "${event.payload.query}" -> ${count} results`);
      for (const r of event.payload.results.slice(0, 3)) {
        this.appendChat("browser", `  ${C.blue}${r.title}${C.reset}`);
        this.appendChat("browser", `  ${C.dim}${r.url}${C.reset}`);
      }
    });

    // Browser fetch results
    this.bus.subscribe("browser.fetch.completed", (event) => {
      const preview = event.payload.content.substring(0, 100).replace(/\n/g, " ");
      this.appendChat("browser", `Page: ${event.payload.title} [${event.payload.statusCode}]`);
      this.appendChat("browser", `  ${C.dim}${preview}...${C.reset}`);
    });

    // Feature Scout
    this.bus.subscribe("feature.sources.discovered", (event) => {
      this.appendChat("scout", `Discovered ${event.payload.sources.length} external sources`);
    });

    this.bus.subscribe("feature.candidate.scored", (event) => {
      const status = event.payload.passed ? `${C.green}passed${C.reset}` : `${C.red}rejected${C.reset}`;
      this.appendChat("scout", `Candidate score: ${event.payload.finalScore.toFixed(2)} ${status}`);
    });

    this.bus.subscribe("plugin.installed", (event) => {
      this.appendChat("scout", `${C.green}Plugin installed: ${event.payload.pluginName}${C.reset}`);
    });

    // System events
    this.bus.subscribe("system.module.started", (event) => {
      this.appendChat("system", `${C.dim}Module started: ${event.payload.moduleName}${C.reset}`);
    });

    this.bus.subscribe("browser.ready", (event) => {
      this.appendChat("system", `${C.green}Browser ready${C.reset} (${event.payload.headless ? "headless" : "headed"})`);
    });

    // LLM events
    this.bus.subscribe("llm.chat.completed", (event) => {
      this.chainState.llm = "passed";
      const fallback = event.payload.fallbackUsed ? `${C.red} (fallback)${C.reset}` : "";
      this.appendChat("llm", `${C.green}LLM${C.reset}: ${event.payload.modelName} completed in ${event.payload.durationMs}ms${fallback}` +
        (event.payload.tokensUsed ? ` (${event.payload.tokensUsed} tokens)` : ""));
    });

    this.bus.subscribe("llm.chat.failed", (event) => {
      this.chainState.llm = "failed";
      this.appendChat("llm", `${C.red}LLM failed${C.reset}: ${event.payload.modelId} - ${event.payload.error}`);
    });

    this.bus.subscribe("llm.model.switched", (event) => {
      this.appendChat("llm", `${C.yellow}Model switched${C.reset}: ${event.payload.previousModelId} -> ${event.payload.newModelId} (by ${event.payload.switchedBy})`);
    });

    this.bus.subscribe("llm.route.updated", (event) => {
      this.appendChat("llm", `${C.cyan}Route updated${C.reset}: ${event.payload.taskType} -> ${event.payload.newModelId}`);
    });

    // Repair chain key events
    this.bus.subscribe("evolution.patch.proposed", (event) => {
      this.appendChat("repair", `${C.yellow}Patch proposed: ${event.payload.reason}${C.reset}`);
    });

    this.bus.subscribe("evolution.eval.passed", (event) => {
      this.appendChat("repair", `${C.green}Eval passed${C.reset}`);
    });

    this.bus.subscribe("evolution.eval.failed", (event) => {
      this.appendChat("repair", `${C.red}Eval failed: ${event.payload.reason}${C.reset}`);
    });

    this.bus.subscribe("deploy.succeeded", (event) => {
      this.appendChat("repair", `${C.green}Deploy succeeded: ${event.payload.version}${C.reset}`);
    });
  }

  /**
   * Handle user input
   */
  private async handleInput(text: string): Promise<void> {
    if (text.startsWith("/")) {
      await this.handleCommand(text);
    } else {
      // Send message to agent
      this.appendChat("user", text);
      await this.bus.publish({
        type: "agent.message.received",
        source: "tui",
        payload: {
          message: text,
          userId: "tui-user"
        }
      });
    }
  }

  /**
   * Handle slash commands
   */
  private async handleCommand(cmd: string): Promise<void> {
    const parts = cmd.split(/\s+/);
    const command = (parts[0] ?? "").toLowerCase();
    const args = parts.slice(1);

    switch (command) {
      case "/help":
        this.showHelp();
        break;

      case "/status":
        this.showStatus();
        break;

      case "/search":
      case "/s": {
        const query = args.join(" ");
        if (!query) {
          this.appendChat("system", `${C.yellow}Usage: /search <query>${C.reset}`);
          break;
        }
        this.appendChat("system", `${C.cyan}Searching: ${query}${C.reset}`);
        await this.bus.publish({
          type: "browser.search.requested",
          source: "tui",
          payload: { query }
        });
        break;
      }

      case "/fetch":
      case "/f": {
        const url = args[0];
        if (!url) {
          this.appendChat("system", `${C.yellow}Usage: /fetch <URL>${C.reset}`);
          break;
        }
        this.appendChat("system", `${C.cyan}Fetching: ${url}${C.reset}`);
        await this.bus.publish({
          type: "browser.fetch.requested",
          source: "tui",
          payload: { url }
        });
        break;
      }

      case "/scout": {
        const topics = args.length > 0 ? args : undefined;
        this.appendChat("system", `${C.cyan}Triggering external feature scout...${C.reset}`);
        await this.bus.publish({
          type: "feature.scout.requested",
          source: "tui",
          payload: {
            topics,
            triggeredBy: "manual"
          }
        });
        break;
      }

      case "/task": {
        const taskName = args[0];
        const taskUrl = args[1];
        if (!taskName || !taskUrl) {
          this.appendChat("system", `${C.yellow}Usage: /task <name> <URL>${C.reset}`);
          this.appendChat("system", `${C.dim}Example: /task github-scout https://github.com/trending${C.reset}`);
          break;
        }
        this.appendChat("system", `${C.cyan}Running task: ${taskName}${C.reset}`);
        await this.bus.publish({
          type: "browser.task.requested",
          source: "tui",
          payload: {
            taskName,
            steps: [
              { type: "navigate", value: taskUrl },
              { type: "wait", value: "2000" },
              { type: "extract" },
              { type: "screenshot" }
            ]
          }
        });
        break;
      }

      case "/screenshot":
      case "/ss": {
        const url = args[0];
        if (!url) {
          this.appendChat("system", `${C.yellow}Usage: /screenshot <URL>${C.reset}`);
          break;
        }
        this.appendChat("system", `${C.cyan}Screenshotting: ${url}${C.reset}`);
        await this.bus.publish({
          type: "browser.screenshot.requested",
          source: "tui",
          payload: { url, fullPage: true }
        });
        break;
      }

      case "/events": {
        const sorted = [...this.eventCounts.entries()].sort((a, b) => b[1] - a[1]);
        this.appendChat("system", `${C.bold}Event Stats:${C.reset}`);
        for (const [type, count] of sorted) {
          this.appendChat("system", `  ${type}: ${count}`);
        }
        break;
      }

      case "/trigger": {
        const errorType = args[0] ?? "runtime_error";
        const message = args.slice(1).join(" ") || "Manual repair trigger test";
        this.appendChat("system", `${C.yellow}Triggering repair: ${errorType} - ${message}${C.reset}`);
        await this.bus.publish({
          type: "agent.failure.reported",
          source: "tui",
          payload: {
            errorType: errorType as "runtime_error",
            message
          }
        });
        break;
      }

      case "/clear":
        this.chatBox.setContent("");
        this.screen.render();
        break;

      case "/model":
      case "/m": {
        const subCommand = args[0];
        if (!subCommand) {
          // Show current model status
          this.showModelStatus();
        } else if (subCommand === "switch" || subCommand === "s") {
          const modelId = args[1];
          if (!modelId) {
            this.appendChat("system", `${C.yellow}Usage: /model switch <model-id>${C.reset}`);
            this.appendChat("system", `${C.dim}Available: ${this.llm.getRegistry().getAvailableModels().map(m => m.id).join(", ")}${C.reset}`);
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
                switchedBy: "tui"
              }
            });
          }
          this.appendChat("system", result.success ? `${C.green}${result.message}${C.reset}` : `${C.red}${result.message}${C.reset}`);
        } else if (subCommand === "route" || subCommand === "r") {
          const taskType = args[1];
          const routeModelId = args[2];
          if (!taskType || !routeModelId) {
            this.appendChat("system", `${C.yellow}Usage: /model route <task-type> <model-id>${C.reset}`);
            this.appendChat("system", `${C.dim}Task types: chat, patch_generate, feature_analyze, spec_generate, prototype_build, code_review, summarize${C.reset}`);
            break;
          }
          const result = this.llm.setRoute(taskType as any, routeModelId);
          this.appendChat("system", result.success ? `${C.green}${result.message}${C.reset}` : `${C.red}${result.message}${C.reset}`);
        } else if (subCommand === "check") {
          this.appendChat("system", `${C.cyan}Checking model availability...${C.reset}`);
          const availability = await this.llm.checkAvailability();
          for (const [id, status] of availability) {
            const color = status === "available" ? C.green : status === "error" ? C.red : C.yellow;
            this.appendChat("system", `  ${color}${id}${C.reset}: ${status}`);
          }
        } else if (subCommand === "list" || subCommand === "l") {
          this.showModelList();
        } else {
          this.appendChat("system", `${C.yellow}Unknown /model sub-command: ${subCommand}${C.reset}`);
          this.appendChat("system", `${C.dim}Usage: /model [list|switch|route|check]${C.reset}`);
        }
        break;
      }

      case "/quit":
      case "/q":
        this.appendChat("system", `${C.yellow}Shutting down OpenEvolve...${C.reset}`);
        this.screen.destroy();
        process.exit(0);
        break;

      default:
        this.appendChat("system", `${C.red}Unknown command: ${command}${C.reset}`);
        this.appendChat("system", `${C.dim}Type /help to see all commands${C.reset}`);
    }
  }

  /**
   * Show help information
   */
  private showHelp(): void {
    const help = [
      `${C.bold}${C.brand}OpenEvolve Commands${C.reset}`,
      ``,
      `${C.bold}Chat${C.reset}`,
      `  <message>           Send a message to the agent`,
      ``,
      `${C.bold}Browser${C.reset}`,
      `  /search <query>     Search via search engine (alias: /s)`,
      `  /fetch <URL>        Fetch page content (alias: /f)`,
      `  /screenshot <URL>   Take page screenshot (alias: /ss)`,
      `  /task <name> <URL>  Run browser automation task`,
      ``,
      `${C.bold}Evolution${C.reset}`,
      `  /scout [topics...]  Trigger external feature scout`,
      `  /trigger [type] [msg] Trigger self-repair pipeline`,
      ``,
      `${C.bold}System${C.reset}`,
      `  /status             Show system status`,
      `  /events             Show event statistics`,
      `  /model              Show current model status (alias: /m)`,
      `  /model list         List all available models`,
      `  /model switch <id>  Switch default model`,
      `  /model route <task> <id> Set route for a task type`,
      `  /model check        Check model availability`,
      `  /clear              Clear chat area`,
      `  /help               Show this help`,
      `  /quit               Quit (alias: /q, Ctrl+C)`,
      ``,
      `${C.dim}Shortcuts: Tab=Switch panel  Esc=Focus input  Ctrl+C=Quit${C.reset}`,
    ];

    for (const line of help) {
      this.appendChat("help", line);
    }
  }

  /**
   * Show system status
   */
  private showStatus(): void {
    const uptime = Math.floor((Date.now() - this.startedAt.getTime()) / 1000);
    const hours = Math.floor(uptime / 3600);
    const mins = Math.floor((uptime % 3600) / 60);
    const secs = uptime % 60;
    const uptimeStr = `${hours}h ${mins}m ${secs}s`;

    const totalEvents = [...this.eventCounts.values()].reduce((a, b) => a + b, 0);
    const llmStatus = this.llm.getStatus();

    const lines = [
      `${C.bold}${C.brand}OpenEvolve System Status${C.reset}`,
      ``,
      `  Version:    v${this.version}`,
      `  Uptime:     ${uptimeStr}`,
      `  Events:     ${totalEvents}`,
      ``,
      `${C.bold}Evolution Chains${C.reset}`,
      `  Repair:  ${this.formatChainState(this.chainState.repair)}`,
      `  Scout:   ${this.formatChainState(this.chainState.scout)}`,
      `  Browser: ${this.formatChainState(this.chainState.browser)}`,
      `  LLM:     ${this.formatChainState(this.chainState.llm)}`,
      ``,
      `${C.bold}LLM Models${C.reset}`,
      `  Default:  ${C.green}${llmStatus.defaultModelId}${C.reset}`,
      `  Requests: ${llmStatus.usage.totalRequests}`,
      `  Tokens:   ${llmStatus.usage.totalTokens}`,
      `  Cost:     $${llmStatus.usage.estimatedCostUsd.toFixed(4)}`,
      ``,
      `${C.bold}Event Stats (Top 10)${C.reset}`,
    ];

    const sorted = [...this.eventCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [type, count] of sorted) {
      lines.push(`  ${type}: ${count}`);
    }

    for (const line of lines) {
      this.appendChat("status", line);
    }
  }

  /**
   * Show model status summary
   */
  private showModelStatus(): void {
    const status = this.llm.getStatus();
    const lines = [
      `${C.bold}${C.brand}LLM Model Status${C.reset}`,
      ``,
      `  Default Model: ${C.green}${status.defaultModelId}${C.reset}`,
      `  Fallback Chain: ${status.fallbackChain.join(" -> ")}`,
      ``,
      `${C.bold}Models${C.reset}`,
    ];

    for (const model of status.models) {
      const statusColor = model.status === "available" ? C.green : model.status === "error" ? C.red : C.yellow;
      const defaultTag = model.id === status.defaultModelId ? `${C.bold} (default)${C.reset}` : "";
      lines.push(`  ${statusColor}${model.id}${C.reset}${defaultTag} — ${model.name} [${model.provider}] ${statusColor}${model.status}${C.reset}`);
    }

    lines.push("");
    lines.push(`${C.bold}Routes${C.reset}`);
    for (const [task, modelId] of Object.entries(status.routes)) {
      lines.push(`  ${task}: ${C.cyan}${modelId}${C.reset}`);
    }

    lines.push("");
    lines.push(`${C.bold}Usage${C.reset}`);
    lines.push(`  Requests: ${status.usage.totalRequests}`);
    lines.push(`  Tokens:   ${status.usage.totalTokens}`);
    lines.push(`  Cost:     $${status.usage.estimatedCostUsd.toFixed(4)}`);

    for (const line of lines) {
      this.appendChat("llm", line);
    }
  }

  /**
   * Show detailed model list
   */
  private showModelList(): void {
    const models = this.llm.getRegistry().getAllModels();
    const defaultId = this.llm.getRegistry().getDefaultModelId();

    const lines = [
      `${C.bold}${C.brand}Available Models${C.reset}`,
      ``,
    ];

    for (const model of models) {
      const statusColor = model.status === "available" ? C.green : model.status === "error" ? C.red : C.yellow;
      const defaultTag = model.id === defaultId ? `${C.bold} [DEFAULT]${C.reset}` : "";
      lines.push(`${C.bold}${model.id}${C.reset}${defaultTag}`);
      lines.push(`  Name:       ${model.name}`);
      lines.push(`  Provider:   ${model.provider}`);
      lines.push(`  Model:      ${model.model}`);
      lines.push(`  Status:     ${statusColor}${model.status}${C.reset}`);
      if (model.maxTokens) lines.push(`  Max Tokens: ${model.maxTokens}`);
      if (model.temperature !== undefined) lines.push(`  Temperature:${model.temperature}`);
      if (model.costPer1kInput) lines.push(`  Cost In:    $${model.costPer1kInput}/1K tokens`);
      if (model.costPer1kOutput) lines.push(`  Cost Out:   $${model.costPer1kOutput}/1K tokens`);
      if (model.priority) lines.push(`  Priority:   ${model.priority}`);
      lines.push("");
    }

    for (const line of lines) {
      this.appendChat("llm", line);
    }
  }

  // ===== Helper Methods =====

  /**
   * Append message to Chat panel
   */
  private appendChat(role: string, text: string): void {
    const time = new Date().toLocaleTimeString("en-US", { hour12: false });
    const prefix = this.getChatPrefix(role);
    const content = this.chatBox.getContent() as string;
    const newLine = `${C.dim}${time}${C.reset} ${prefix}${text}`;
    this.chatBox.setContent(content + (content ? "\n" : "") + newLine);
    this.chatBox.setScrollPerc(100);
    this.screen.render();
  }

  /**
   * Get Chat prefix
   */
  private getChatPrefix(role: string): string {
    const prefixes: Record<string, string> = {
      user: `${C.green}${C.bold}You${C.reset} | `,
      agent: `${C.cyan}${C.bold}Agent${C.reset} | `,
      system: `${C.dim}System${C.reset} | `,
      error: `${C.red}Error${C.reset} | `,
      help: `  `,
      status: `  `,
      browser: `${C.blue}Browser${C.reset} | `,
      scout: `${C.magenta}Scout${C.reset} | `,
      repair: `${C.yellow}Repair${C.reset} | `,
      llm: `${C.magenta}LLM${C.reset} | `,
    };
    return prefixes[role] ?? `${role} | `;
  }

  /**
   * Update chain state
   */
  private updateChainState(eventType: string): void {
    // Repair chain
    const repairRunning = [
      "agent.failure.reported",
      "evolution.analysis.requested",
      "evolution.patch.proposed",
      "evolution.patch.applied",
      "evolution.eval.requested",
    ];
    const repairSuccess = [
      "evolution.eval.passed",
      "release.created",
      "deploy.succeeded",
    ];
    const repairFail = [
      "evolution.eval.failed",
      "deploy.rollbacked",
    ];

    if (repairRunning.includes(eventType)) this.chainState.repair = "running";
    else if (repairSuccess.includes(eventType)) this.chainState.repair = "passed";
    else if (repairFail.includes(eventType)) this.chainState.repair = "failed";

    // Scout chain
    const scoutRunning = [
      "feature.scout.requested",
      "feature.sources.discovered",
      "feature.candidate.found",
      "feature.candidate.scored",
      "feature.spec.generated",
      "feature.prototype.requested",
      "feature.prototype.created",
      "feature.eval.requested",
    ];
    const scoutSuccess = [
      "feature.eval.passed",
      "plugin.installed",
    ];
    const scoutFail = [
      "feature.eval.failed",
    ];

    if (scoutRunning.includes(eventType)) this.chainState.scout = "running";
    else if (scoutSuccess.includes(eventType)) this.chainState.scout = "passed";
    else if (scoutFail.includes(eventType)) this.chainState.scout = "failed";

    // Browser chain
    const browserRunning = [
      "browser.search.requested",
      "browser.fetch.requested",
      "browser.task.requested",
      "browser.screenshot.requested",
    ];
    const browserSuccess = [
      "browser.search.completed",
      "browser.fetch.completed",
      "browser.task.completed",
      "browser.screenshot.completed",
    ];
    const browserFail = [
      "browser.action.failed",
    ];

    if (browserRunning.includes(eventType)) this.chainState.browser = "running";
    else if (browserSuccess.includes(eventType)) this.chainState.browser = "passed";
    else if (browserFail.includes(eventType)) this.chainState.browser = "failed";

    // LLM chain
    const llmRunning = [
      "llm.chat.requested",
    ];
    const llmSuccess = [
      "llm.chat.completed",
    ];
    const llmFail = [
      "llm.chat.failed",
    ];

    if (llmRunning.includes(eventType)) this.chainState.llm = "running";
    else if (llmSuccess.includes(eventType)) this.chainState.llm = "passed";
    else if (llmFail.includes(eventType)) this.chainState.llm = "failed";
  }

  /**
   * Format chain status bar
   */
  private formatChainBar(): string {
    const repair = this.formatChainState(this.chainState.repair);
    const scout = this.formatChainState(this.chainState.scout);
    const browser = this.formatChainState(this.chainState.browser);
    const llm = this.formatChainState(this.chainState.llm);
    const total = [...this.eventCounts.values()].reduce((a, b) => a + b, 0);

    return ` Chains: Repair:${repair}  Scout:${scout}  Browser:${browser}  LLM:${llm}  |  Events: ${total}  |  /help`;
  }

  /**
   * Format chain state
   */
  private formatChainState(state: string): string {
    switch (state) {
      case "running": return `${C.yellow}running${C.reset}`;
      case "passed": return `${C.green}passed${C.reset}`;
      case "failed": return `${C.red}failed${C.reset}`;
      default: return `${C.dim}idle${C.reset}`;
    }
  }

  /**
   * Get event color
   */
  private getEventColor(type: string): string {
    if (type.startsWith("agent.")) return C.green;
    if (type.startsWith("evolution.")) return C.yellow;
    if (type.startsWith("release.") || type.startsWith("deploy.")) return C.magenta;
    if (type.startsWith("feature.")) return C.cyan;
    if (type.startsWith("plugin.")) return C.blue;
    if (type.startsWith("browser.")) return C.blue;
    if (type.startsWith("llm.")) return C.magenta;
    if (type.startsWith("system.")) return C.gray;
    return C.white;
  }
}
