import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
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
    dataDir: `data/plugins/${input.plugin.name}`,
  });

  await input.bus.publish({
    type: "system.plugin.loaded",
    source: "plugin-manager",
    payload: {
      pluginName: input.plugin.name,
      version: input.plugin.version,
    },
  });
}

/**
 * Scan src/plugins/ for installed feature-* plugins and load them dynamically.
 * Skips example-plugin.ts (loaded statically) and handles errors per-plugin.
 */
export async function loadInstalledPlugins(bus: EventBus): Promise<number> {
  const pluginsDir = join(process.cwd(), "src", "plugins");
  let loaded = 0;

  let entries: string[];
  try {
    entries = await readdir(pluginsDir);
  } catch {
    return 0;
  }

  for (const name of entries) {
    if (name === "example-plugin.ts" || !name.startsWith("feature-")) continue;

    const pluginPath = join(pluginsDir, name);
    try {
      const s = await stat(pluginPath);
      if (!s.isDirectory()) continue;
    } catch {
      continue;
    }
    const indexPath = join(pluginPath, "src", "index.ts");
    const installPath = join(pluginPath, "install.json");

    // Verify it has an install manifest
    try {
      await import("node:fs/promises").then((fs) => fs.access(installPath));
    } catch {
      continue; // No install.json, skip
    }

    try {
      const mod = await import(indexPath);
      const plugin: AgentPlugin = mod.default ?? mod;

      if (!plugin.name || !plugin.setup) {
        console.warn(`[plugin-loader] Invalid plugin at ${name}: missing name or setup`);
        continue;
      }

      await loadPlugin({ bus, plugin });
      console.log(`[plugin-loader] Loaded installed plugin: ${plugin.name} v${plugin.version}`);
      loaded++;
    } catch (err) {
      console.warn(`[plugin-loader] Failed to load ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return loaded;
}
