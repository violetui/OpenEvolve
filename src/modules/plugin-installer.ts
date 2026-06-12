import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentModule } from "../core/module";
import type { FeatureInstallLevel } from "../core/event-types";
import {
  canAutoInstall,
  needsEvalApproval,
  needsHumanApproval,
  isInstallBlocked
} from "../core/policy";

/**
 * PluginInstaller Module
 *
 * Subscribes to feature.eval.passed
 * Decides whether to auto-install based on install level
 * Publishes plugin.install.requested → plugin.installed
 *
 * Install levels:
 * Level 1: Auto-install allowed (skills/prompts)
 * Level 2: Requires eval approval (read-only plugins)
 * Level 3: Requires human approval or strict sandbox (external API tools)
 * Level 4: Auto-install blocked by default (high-permission tools)
 */
export const PluginInstallerModule: AgentModule = {
  name: "plugin-installer",

  start(ctx) {
    ctx.bus.subscribe("feature.eval.passed", async (event) => {
      const { candidateId, workspace } = event.payload;

      // Determine install level from previous events
      // MVP version: default Level 2 (requires eval approval)
      // Real version: read install level from spec
      const installLevel: FeatureInstallLevel = determineInstallLevel(workspace);

      console.log(`[plugin-installer] Candidate ${candidateId} eval passed, install level: Level ${installLevel}`);

      // Publish install request event
      await ctx.bus.publish({
        type: "plugin.install.requested",
        source: "plugin-installer",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId,
          pluginName: `feature-${candidateId.slice(0, 8)}`,
          installLevel,
          workspace
        }
      });

      // Decide action based on install level
      if (isInstallBlocked(installLevel)) {
        console.log(`[plugin-installer] Candidate ${candidateId} is Level 4 high-permission tool, auto-install blocked`);
        return;
      }

      if (needsHumanApproval(installLevel)) {
        console.log(`[plugin-installer] Candidate ${candidateId} is Level ${installLevel}, requires human approval`);
        // MVP: log and wait for confirmation; real version should publish an event and wait for human action
        return;
      }

      // Level 1 or Level 2 (already eval-approved) can be installed
      if (canAutoInstall(installLevel) || needsEvalApproval(installLevel)) {
        const installPath = await installPlugin(workspace, candidateId);

        await ctx.bus.publish({
          type: "plugin.installed",
          source: "plugin-installer",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            candidateId,
            pluginName: `feature-${candidateId.slice(0, 8)}`,
            installLevel,
            installPath
          }
        });

        console.log(`[plugin-installer] Plugin installed to ${installPath}`);
      }
    });
  }
};

/**
 * Read install level from workspace
 *
 * MVP version: default Level 2
 * Real version: read from spec or package.json declaration
 */
function determineInstallLevel(_workspace: string): FeatureInstallLevel {
  return 2;
}

/**
 * Install plugin into the system
 *
 * Copy prototype workspace code to src/plugins directory
 */
async function installPlugin(
  workspace: string,
  candidateId: string
): Promise<string> {
  const pluginName = `feature-${candidateId.slice(0, 8)}`;
  const installPath = join(process.cwd(), "src", "plugins", pluginName);

  await mkdir(installPath, { recursive: true });

  // Copy source code
  try {
    await cp(join(workspace, "src"), join(installPath, "src"), {
      recursive: true
    });
  } catch {
    // src directory may not exist
  }

  // Copy package.json
  try {
    const packageJson = await readFile(join(workspace, "package.json"), "utf8");
    await writeFile(join(installPath, "package.json"), packageJson, "utf8");
  } catch {
    // package.json may not exist
  }

  // Write install metadata
  await writeFile(
    join(installPath, "install.json"),
    JSON.stringify({
      candidateId,
      installedAt: new Date().toISOString(),
      source: "feature-scout"
    }, null, 2),
    "utf8"
  );

  return installPath;
}
