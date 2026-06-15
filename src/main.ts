import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { EventBus } from "./core/event-bus";
import { startModules } from "./core/module";
import { loadPlugin, loadInstalledPlugins } from "./core/plugin";

import type { LLMConfigFile } from "./llm/types";

// Load config.json
const __dirname = dirname(fileURLToPath(import.meta.url));
const configPath = join(__dirname, "..", "config.json");
const appConfig = JSON.parse(readFileSync(configPath, "utf-8")) as {
  system: {
    port: number;
    noTui: boolean;
    version: string;
    browser: { headless: boolean; slowMo: number };
  };
  llm: LLMConfigFile;
};

import { AgentRuntimeModule } from "./modules/agent-runtime";

// Self-optimization: unified reactive (failure) + proactive (idle) agent
import { SelfOptimizerModule } from "./modules/self-optimizer";

import { PatchApplierModule } from "./modules/patch-applier";
import { EvaluatorModule } from "./modules/evaluator";
import { ReleaseManagerModule } from "./modules/release-manager";
import { SupervisorAdapterModule } from "./modules/supervisor-adapter";

// External capability discovery chain modules
import { SchedulerModule } from "./modules/scheduler";
import { FeatureScoutModule } from "./modules/feature-scout";
import { FeatureAnalyzerModule } from "./modules/feature-analyzer";
import { FeatureSpecGeneratorModule } from "./modules/feature-spec-generator";
import { FeaturePrototypeBuilderModule } from "./modules/feature-prototype-builder";
import { FeatureEvaluatorModule } from "./modules/feature-evaluator";
import { PluginInstallerModule } from "./modules/plugin-installer";

// Browser automation modules
import { BrowserAutomationModule } from "./modules/browser-automation";
import { BrowserSearchModule } from "./modules/browser-search";
import { BrowserTaskModule } from "./modules/browser-task";

// LLM tool modules
import { FileOpsModule } from "./modules/file-ops";
import { ShellExecModule } from "./modules/shell-exec";
import { FileSearchModule } from "./modules/file-search";
import { TodoManagerModule } from "./modules/todo-manager";

// LLM bridge module
import { LLMBridgeModule } from "./modules/llm-bridge";

// TUI interactive interface
import { OpenEvolveTUI } from "./modules/tui";

import { registerEventLogger } from "./modules/logger";

// LLM Service
import { LLMService } from "./llm";

import examplePlugin from "./plugins/example-plugin";

const bus = new EventBus();

// Initialize LLM Service with logging
const llm = new LLMService(
  process.env as Record<string, string | undefined>,
  (message) => console.log(`[llm-service] ${message}`)
);

// Load LLM models, routes, and fallback chain from config.json
llm.loadConfig(appConfig.llm);

// Apply system settings from config (env var takes precedence)
if (!process.env.PORT) {
  process.env.PORT = String(appConfig.system.port);
}
if (!process.env.BROWSER_HEADLESS) {
  process.env.BROWSER_HEADLESS = String(appConfig.system.browser.headless);
}
if (!process.env.BROWSER_SLOW_MO) {
  process.env.BROWSER_SLOW_MO = String(appConfig.system.browser.slowMo);
}
if (!process.env.AGENT_VERSION) {
  process.env.AGENT_VERSION = appConfig.system.version;
}

registerEventLogger(bus);

const ctx = {
  bus,
  env: process.env as Record<string, string | undefined>,
  llm,
};

await startModules(ctx, [
  // LLM bridge (should start first to capture events)
  LLMBridgeModule,

  // Internal evolution chain
  AgentRuntimeModule,

  // Unified self-optimization: reactive (failure) + proactive (idle)
  SelfOptimizerModule,

  // Safe application + eval + release + deploy
  PatchApplierModule,
  EvaluatorModule,
  ReleaseManagerModule,
  SupervisorAdapterModule,

  // External evolution chain: external capability discovery
  SchedulerModule,
  FeatureScoutModule,
  FeatureAnalyzerModule,
  FeatureSpecGeneratorModule,
  FeaturePrototypeBuilderModule,
  FeatureEvaluatorModule,
  PluginInstallerModule,

  // Browser automation chain: search + automation tasks
  BrowserAutomationModule,
  BrowserSearchModule,
  BrowserTaskModule,

  // LLM tool modules: file ops, shell, search, todo
  FileOpsModule,
  ShellExecModule,
  FileSearchModule,
  TodoManagerModule,
]);

await loadPlugin({
  bus,
  plugin: examplePlugin
});

// Load any previously scout-installed plugins
const installedCount = await loadInstalledPlugins(bus);
if (installedCount > 0) {
  console.log(`Loaded ${installedCount} installed plugin(s)`);
}

// Start TUI (env NO_TUI overrides config.system.noTui)
const noTui =
  process.env.NO_TUI === "true" || process.env.NO_TUI === "1"
    ? true
    : process.env.NO_TUI === "false" || process.env.NO_TUI === "0"
      ? false
      : appConfig.system.noTui;

if (!noTui) {
  const tui = new OpenEvolveTUI(bus, llm, appConfig.system.version);
  tui.start();
} else {
  console.log("OpenEvolve started (headless mode)");
  console.log("  Self-optimization: failure/proactive -> analyze+edit+verify -> patch -> eval -> deploy -> restart");
  console.log("  External evolution: feature.scout.requested -> feature.candidate.found -> plugin/code/skill");
  console.log("  Browser chain:     browser.search.requested / browser.task.requested -> browser.action.completed");
  console.log("  LLM default model: " + llm.getRegistry().getDefaultModelId());
  console.log("  LLM endpoints:     GET /models | PUT /models/default | PUT /models/route | POST /models/check");
}
