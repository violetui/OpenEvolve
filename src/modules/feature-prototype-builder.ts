import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentModule } from "../core/module";

/**
 * FeaturePrototypeBuilder Module
 *
 * Subscribes to feature.spec.generated
 * Generates a minimal plugin/skill/module prototype from the internal capability spec
 * Publishes feature.prototype.requested → feature.prototype.created
 *
 * MVP version: generates minimal plugin skeleton code
 * Real version: should call LLM to generate a full implementation from the spec
 */
export const FeaturePrototypeBuilderModule: AgentModule = {
  name: "feature-prototype-builder",

  start(ctx) {
    ctx.bus.subscribe("feature.spec.generated", async (event) => {
      const spec = event.payload.spec;

      console.log(`[feature-prototype-builder] Generating prototype for ${spec.id}`);

      // Publish prototype build request
      await ctx.bus.publish({
        type: "feature.prototype.requested",
        source: "feature-prototype-builder",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: event.payload.candidateId,
          spec
        }
      });

      // Create workspace and generate prototype code
      const workspace = await mkdtemp(join(tmpdir(), "feature-prototype-"));
      const pluginName = `feature-${spec.id}`;
      const files: string[] = [];

      // Generate plugin entry file
      const indexPath = join(workspace, "src", "index.ts");
      await mkdir(join(workspace, "src"), { recursive: true });

      const indexContent = generatePluginCode(spec, pluginName);
      await writeFile(indexPath, indexContent, "utf8");
      files.push("src/index.ts");

      // Generate package.json
      const packageJsonPath = join(workspace, "package.json");
      const packageJson = JSON.stringify({
        name: pluginName,
        version: "0.1.0",
        type: "module",
        main: "src/index.ts"
      }, null, 2);
      await writeFile(packageJsonPath, packageJson, "utf8");
      files.push("package.json");

      // Generate test file
      const testPath = join(workspace, "tests", "index.test.ts");
      await mkdir(join(workspace, "tests"), { recursive: true });

      const testContent = generateTestCode(spec, pluginName);
      await writeFile(testPath, testContent, "utf8");
      files.push("tests/index.test.ts");

      // Publish prototype created event
      await ctx.bus.publish({
        type: "feature.prototype.created",
        source: "feature-prototype-builder",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          candidateId: event.payload.candidateId,
          workspace,
          pluginName,
          files
        }
      });
    });
  }
};

/**
 * Generate plugin skeleton code
 */
function generatePluginCode(spec: {
  id: string;
  type: string;
  description: string;
  permissions: {
    network?: { allow: string[] };
    filesystem?: { read: string[]; write: string[] };
  };
  events: {
    subscribes: string[];
    publishes: string[];
  };
  riskLevel: string;
  evals: string[];
}, pluginName: string): string {
  const subscribeList = spec.events.subscribes
    .map(e => `    "${e}"`)
    .join(",\n");

  const publishList = spec.events.publishes
    .map(e => `    "${e}"`)
    .join(",\n");

  return `/**
 * ${spec.description}
 *
 * Auto-generated plugin prototype
 * riskLevel: ${spec.riskLevel}
 */

import type { AgentPlugin } from "../core/plugin";

export default {
  name: "${pluginName}",
  version: "0.1.0",

  permissions: {
    subscribe: [
${subscribeList}
    ],
    publish: [
${publishList}
    ]
  },

  setup(ctx) {
${spec.events.subscribes.map(e => `    ctx.bus.subscribe("${e}", async (event) => {\n      console.log("[${pluginName}] Received event: ${e}");\n    });`).join("\n\n")}
  }
} satisfies AgentPlugin;
`;
}

/**
 * Generate test skeleton code
 */
function generateTestCode(spec: {
  id: string;
  description: string;
  evals: string[];
}, pluginName: string): string {
  const evalTests = spec.evals.map((evalItem, i) =>
    `  it("eval ${i + 1}: ${evalItem}", async () => {\n    // TODO: Implement evaluation: ${evalItem}\n    expect(true).toBe(true);\n  });`
  ).join("\n\n");

  return `import { describe, it, expect } from "bun:test";

describe("${pluginName}", () => {
${evalTests}
});
`;
}
