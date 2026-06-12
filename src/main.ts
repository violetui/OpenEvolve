import { EventBus } from "./core/event-bus";
import { startModules } from "./core/module";
import { loadPlugin } from "./core/plugin";

import { AgentRuntimeModule } from "./modules/agent-runtime";
import { FailureMinerModule } from "./modules/failure-miner";
import { PatchGeneratorModule } from "./modules/patch-generator";
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

registerEventLogger(bus);

const ctx = {
  bus,
  env: process.env as Record<string, string | undefined>,
  llm,
};

await startModules(ctx, [
  // LLM bridge (should start first to capture events)
  LLMBridgeModule,

  // Internal evolution chain: usage-triggered repair
  AgentRuntimeModule,
  FailureMinerModule,
  PatchGeneratorModule,
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
  BrowserTaskModule
]);

await loadPlugin({
  bus,
  plugin: examplePlugin
});

// Start TUI (unless NO_TUI env var is set)
const noTui = process.env.NO_TUI === "true" || process.env.NO_TUI === "1";

if (!noTui) {
  const tui = new OpenEvolveTUI(bus, llm, "0.2.0");
  tui.start();
} else {
  console.log("OpenEvolve started (headless mode)");
  console.log("  Internal evolution: agent.failure.reported -> evolution.patch.proposed -> release.created");
  console.log("  External evolution: feature.scout.requested -> feature.candidate.found -> plugin.installed");
  console.log("  Browser chain:      browser.search.requested / browser.task.requested -> browser.action.completed");
  console.log("  LLM default model:  " + llm.getRegistry().getDefaultModelId());
  console.log("  LLM endpoints:      GET /models | PUT /models/default | PUT /models/route | POST /models/check");
}
