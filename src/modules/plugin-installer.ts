import { cp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentModule } from "../core/module";
import type { FeatureInstallLevel, FeatureIntegrationType } from "../core/event-types";
import {
  needsHumanApproval,
  isInstallBlocked,
  isPathAllowed,
} from "../core/policy";

/**
 * ArtifactInstaller Module (formerly PluginInstaller)
 *
 * Subscribes to feature.eval.passed
 * Handles three integration types:
 *
 *   plugin     → Install to src/plugins/<name>/
 *   code_patch → Apply changes to source files (or feed into repair chain)
 *   skill_file → Save to skills/<name>.md
 *
 * Publishes plugin.install.requested → plugin.installed
 */
export const PluginInstallerModule: AgentModule = {
  name: "plugin-installer",

  start(ctx) {
    ctx.bus.subscribe("feature.eval.passed", async (event) => {
      const { candidateId, workspace } = event.payload;
      const pluginName = `feature-${candidateId.slice(0, 8)}`;

      // Read the spec to determine integration type
      let integrationType: FeatureIntegrationType = "plugin";
      let installLevel: FeatureInstallLevel = 2;

      try {
        const specRaw = await readFile(join(workspace, "spec.json"), "utf8");
        const spec = JSON.parse(specRaw);
        integrationType = spec.integrationType ?? "plugin";
        installLevel = [1, 2, 3, 4].includes(spec.installLevel) ? spec.installLevel : 2;
      } catch {
        console.log(`[plugin-installer] No spec.json found, defaulting to plugin/level 2`);
      }

      console.log(`[plugin-installer] Installing ${pluginName} as ${integrationType} (level ${installLevel})`);

      // Publish install request
      await ctx.bus.publish({
        type: "plugin.install.requested",
        source: "plugin-installer",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: { candidateId, pluginName, installLevel, workspace },
      });

      // Policy check
      if (isInstallBlocked(installLevel)) {
        console.log(`[plugin-installer] Level ${installLevel} blocked by policy`);
        return;
      }
      if (needsHumanApproval(installLevel)) {
        console.log(`[plugin-installer] Level ${installLevel} requires human approval, skipping`);
        return;
      }

      // Route by integration type
      let installPath: string;

      if (integrationType === "code_patch") {
        installPath = await installCodePatch(workspace, candidateId, ctx);
      } else if (integrationType === "skill_file") {
        installPath = await installSkillFile(workspace, candidateId);
      } else {
        // Default: plugin
        installPath = await installPlugin(workspace, candidateId);
      }

      await ctx.bus.publish({
        type: "plugin.installed",
        source: "plugin-installer",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: { candidateId, pluginName, installLevel, installPath },
      });

      console.log(`[plugin-installer] Installed ${integrationType} to ${installPath}`);
    });
  },
};

// ===== Plugin Install =====

async function installPlugin(workspace: string, candidateId: string): Promise<string> {
  const pluginName = `feature-${candidateId.slice(0, 8)}`;
  const installPath = join(process.cwd(), "src", "plugins", pluginName);

  await mkdir(installPath, { recursive: true });

  try { await cp(join(workspace, "src"), join(installPath, "src"), { recursive: true }); } catch { /* ok */ }
  try {
    const pkg = await readFile(join(workspace, "package.json"), "utf8");
    await writeFile(join(installPath, "package.json"), pkg, "utf8");
  } catch { /* ok */ }
  try {
    const spec = await readFile(join(workspace, "spec.json"), "utf8");
    await writeFile(join(installPath, "spec.json"), spec, "utf8");
  } catch { /* ok */ }

  await writeFile(
    join(installPath, "install.json"),
    JSON.stringify({ candidateId, installedAt: new Date().toISOString(), source: "feature-scout", integrationType: "plugin" }, null, 2),
    "utf8",
  );

  return installPath;
}

// ===== Code Patch Install =====

async function installCodePatch(
  workspace: string,
  candidateId: string,
  ctx: { bus: { publish: (e: any) => Promise<any> } },
): Promise<string> {
  // Read the generated changes
  let changes: Array<{ path: string; content: string }> = [];
  try {
    const raw = await readFile(join(workspace, "changes.json"), "utf8");
    changes = JSON.parse(raw);
  } catch {
    console.log(`[plugin-installer] No changes.json found for code_patch`);
    return workspace;
  }

  // Filter to allowed paths only
  const allowed = changes.filter((c) => {
    const ok = isPathAllowed(c.path);
    if (!ok) console.log(`[plugin-installer] Skipping forbidden path: ${c.path}`);
    return ok;
  });

  if (allowed.length === 0) {
    console.log(`[plugin-installer] No allowed file changes, skipping patch`);
    return workspace;
  }

  console.log(`[plugin-installer] Applying code patch to ${allowed.length} file(s): ${allowed.map((c) => c.path).join(", ")}`);

  // Feed into the repair chain for safe application
  await ctx.bus.publish({
    type: "evolution.patch.proposed",
    source: "plugin-installer",
    payload: {
      reason: `Scout patch: ${allowed.length} file(s) from candidate ${candidateId.slice(0, 8)}`,
      risk: "low" as const,
      changes: allowed.map((c) => ({
        path: c.path,
        operation: "replace_file" as const,
        content: c.content,
      })),
    },
  });

  // Return where the patch originated
  const installPath = join(process.cwd(), "src", "plugins", `feature-${candidateId.slice(0, 8)}`);
  await mkdir(installPath, { recursive: true });
  await writeFile(
    join(installPath, "install.json"),
    JSON.stringify({ candidateId, installedAt: new Date().toISOString(), source: "feature-scout", integrationType: "code_patch", appliedFiles: allowed.map((c) => c.path) }, null, 2),
    "utf8",
  );

  return installPath;
}

// ===== Skill File Install =====

async function installSkillFile(workspace: string, candidateId: string): Promise<string> {
  let content = "";
  try {
    content = await readFile(join(workspace, "skill.md"), "utf8");
  } catch {
    console.log(`[plugin-installer] No skill.md found`);
    return workspace;
  }

  const skillsDir = join(process.cwd(), "skills");
  await mkdir(skillsDir, { recursive: true });

  const skillPath = join(skillsDir, `skill-${candidateId.slice(0, 8)}.md`);
  await writeFile(skillPath, content, "utf8");

  console.log(`[plugin-installer] Skill file saved to ${skillPath}`);
  return skillPath;
}
