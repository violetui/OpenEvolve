import type { EventBus } from "./event-bus";

export type PluginContext = {
  bus: EventBus;
  pluginName: string;
  dataDir: string;
};

export interface AgentPlugin {
  name: string;
  version: string;

  permissions: {
    subscribe?: string[];
    publish?: string[];
    readFiles?: string[];
    writeFiles?: string[];
  };

  setup(ctx: PluginContext): Promise<void> | void;
}

export async function loadPlugin(input: {
  bus: EventBus;
  plugin: AgentPlugin;
}) {
  await input.plugin.setup({
    bus: input.bus,
    pluginName: input.plugin.name,
    dataDir: `data/plugins/${input.plugin.name}`
  });

  await input.bus.publish({
    type: "system.plugin.loaded",
    source: "plugin-manager",
    payload: {
      pluginName: input.plugin.name,
      version: input.plugin.version
    }
  });
}
