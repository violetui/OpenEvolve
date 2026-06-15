import type { AgentModule } from "../core/module";

/**
 * Scheduler Module
 *
 * Manages two idle-time self-improvement loops:
 *
 * 1. Scout (external): Triggers feature.scout.requested when system is idle
 *    and cooldown has elapsed. Searches external sources for new capabilities.
 *    Default cooldown: 30h. Set SCOUT_COOLDOWN_MS to override.
 *
 * 2. Proactive optimization (internal): Triggers proactive.optimization.triggered
 *    when system is idle. Scans historical chat logs and LLM execution patterns,
 *    proposes code/skill improvements. Default cooldown: 6h.
 *    Set PROACTIVE_COOLDOWN_MS to override.
 *
 * Checks system idle state every 10 minutes.
 * Set SCOUT_CHECK_INTERVAL_MS to override.
 */

type ChainName = "repair" | "scout" | "browser" | "llm" | "proactive";

export const SchedulerModule: AgentModule = {
  name: "scheduler",

  start(ctx) {
    const scoutCooldownMs = Number(ctx.env.SCOUT_COOLDOWN_MS ?? 30 * 60 * 60 * 1000);
    const proactiveCooldownMs = Number(ctx.env.PROACTIVE_COOLDOWN_MS ?? 6 * 60 * 60 * 1000);
    const checkIntervalMs = Number(ctx.env.SCOUT_CHECK_INTERVAL_MS ?? 10 * 60 * 1000);
    const maxPlugins = Number(ctx.env.SCOUT_MAX_PLUGINS ?? 20);

    let lastScoutCompletedAt = Date.now();
    let lastProactiveCompletedAt = 0; // Allow first proactive run sooner
    let installedPluginCount = 0;

    const chainState: Record<ChainName, string> = {
      repair: "idle",
      scout: "idle",
      browser: "idle",
      llm: "idle",
      proactive: "idle",
    };

    // ---- Track chain states from events ----
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
      proactive: [
        "proactive.optimization.triggered",
        "evolution.patch.proposed",
        "evolution.patch.applied",
        "evolution.eval.requested",
      ],
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
      proactive: ["evolution.eval.passed", "deploy.succeeded"],
    };
    const fail: Record<ChainName, string[]> = {
      repair: ["evolution.eval.failed", "deploy.rollbacked"],
      scout: ["feature.eval.failed"],
      browser: ["browser.action.failed"],
      llm: ["llm.chat.failed"],
      proactive: ["evolution.eval.failed", "deploy.rollbacked"],
    };

    ctx.bus.subscribeAll((event) => {
      const type = event.type as string;
      for (const chain of ["repair", "scout", "browser", "llm", "proactive"] as ChainName[]) {
        if (running[chain].includes(type)) chainState[chain] = "running";
        else if (success[chain].includes(type)) chainState[chain] = "passed";
        else if (fail[chain].includes(type)) chainState[chain] = "failed";
      }

      // Record when scout chain finishes
      if (
        type === "feature.eval.passed" ||
        type === "plugin.installed" ||
        type === "feature.eval.failed"
      ) {
        lastScoutCompletedAt = Date.now();
        chainState.scout = "idle";
      }

      // Record when proactive optimization chain finishes
      if (
        type === "evolution.eval.passed" ||
        type === "evolution.eval.failed" ||
        type === "deploy.succeeded" ||
        type === "deploy.rollbacked"
      ) {
        lastProactiveCompletedAt = Date.now();
        chainState.proactive = "idle";
      }

      // Track installed plugin count for rate limiting
      if (type === "plugin.installed") {
        installedPluginCount++;
      }

      // Reset states to idle after completion/failure events
      for (const chain of ["repair", "browser", "llm"] as ChainName[]) {
        if (success[chain].includes(type) || fail[chain].includes(type)) {
          chainState[chain] = "idle";
        }
      }
    });

    // ---- Periodic idle check ----
    const isIdle = () =>
      chainState.repair !== "running" &&
      chainState.scout !== "running" &&
      chainState.browser !== "running" &&
      chainState.llm !== "running" &&
      chainState.proactive !== "running";

    const tryScout = async () => {
      const elapsed = Date.now() - lastScoutCompletedAt;
      if (!isIdle()) return;
      if (elapsed < scoutCooldownMs) return;
      if (installedPluginCount >= maxPlugins) return;

      console.log(`[scheduler] Idle + scout cooldown met, triggering scout`);
      await ctx.bus.publish({
        type: "feature.scout.requested",
        source: "scheduler",
        payload: {
          topics: [
            "AI agent plugin",
            "MCP server",
            "coding agent feature",
            "self healing agent",
            "agent security",
            "agent evaluation",
          ],
          triggeredBy: "scheduler",
        },
      });
    };

    const tryProactive = async () => {
      const elapsed = Date.now() - lastProactiveCompletedAt;
      if (!isIdle()) return;
      if (elapsed < proactiveCooldownMs) return;

      console.log(`[scheduler] Idle + proactive cooldown met, triggering proactive optimization`);
      await ctx.bus.publish({
        type: "proactive.optimization.triggered",
        source: "scheduler",
        payload: {},
      });
    };

    console.log(
      `[scheduler] Started — scout cooldown=${scoutCooldownMs / 3600000}h, proactive cooldown=${proactiveCooldownMs / 3600000}h, check=${checkIntervalMs / 1000}s, max plugins=${maxPlugins}`,
    );

    // Periodic check — no immediate trigger on startup
    setInterval(() => {
      // Report state periodically for observability
      const idle = isIdle();
      const scoutRemaining = Math.ceil((scoutCooldownMs - (Date.now() - lastScoutCompletedAt)) / 3600000);
      const proactiveRemaining = Math.ceil((proactiveCooldownMs - (Date.now() - lastProactiveCompletedAt)) / 3600000);
      if (idle && (scoutRemaining > 0 || proactiveRemaining > 0)) {
        console.log(`[scheduler] Idle — scout in ~${Math.max(0, scoutRemaining)}h, proactive in ~${Math.max(0, proactiveRemaining)}h`);
      }

      tryScout();
      tryProactive();
    }, checkIntervalMs);
  },
};
