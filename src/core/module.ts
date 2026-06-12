import type { EventBus } from "./event-bus";
import type { LLMService } from "../llm";

export type ModuleContext = {
  bus: EventBus;
  env: Record<string, string | undefined>;
  llm: LLMService;
};

export interface AgentModule {
  name: string;
  start(ctx: ModuleContext): Promise<void> | void;
}

export async function startModules(
  ctx: ModuleContext,
  modules: AgentModule[]
) {
  for (const mod of modules) {
    await mod.start(ctx);

    await ctx.bus.publish({
      type: "system.module.started",
      source: "kernel",
      payload: {
        moduleName: mod.name
      }
    });
  }
}
