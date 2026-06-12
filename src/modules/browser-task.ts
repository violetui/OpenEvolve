import type { AgentModule } from "../core/module";
import type { BrowserStep } from "../core/event-types";
import { newPage } from "./browser-automation";

/**
 * BrowserTask module
 *
 * Subscribes to browser.task.requested
 * Executes browser automation tasks (step sequences)
 * Publishes browser.task.step.completed / browser.task.completed / browser.action.failed
 *
 * Supported step types:
 *   navigate  → Navigate to URL
 *   click     → Click element
 *   type      → Type text into input field
 *   wait      → Wait for element or fixed duration
 *   extract   → Extract page content
 *   screenshot → Take screenshot
 *   scroll    → Scroll page
 */
export const BrowserTaskModule: AgentModule = {
  name: "browser-task",

  start(ctx) {
    ctx.bus.subscribe("browser.task.requested", async (event) => {
      const { taskName, steps, timeout } = event.payload;
      const taskTimeout = timeout ?? 60000;

      console.log(`[browser-task] Starting task: "${taskName}" (${steps.length} steps)`);

      const page = await newPage();
      page.setDefaultTimeout(taskTimeout);

      let completedSteps = 0;

      try {
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i]!;
          const startTime = Date.now();

          try {
            const data = await executeStep(page, step);
            completedSteps++;

            await ctx.bus.publish({
              type: "browser.task.step.completed",
              source: "browser-task",
              correlationId: event.correlationId,
              causationId: event.id,
              payload: {
                taskName,
                stepIndex: i,
                stepType: step.type,
                success: true,
                data
              }
            });
          } catch (stepError) {
            completedSteps++;

            await ctx.bus.publish({
              type: "browser.task.step.completed",
              source: "browser-task",
              correlationId: event.correlationId,
              causationId: event.id,
              payload: {
                taskName,
                stepIndex: i,
                stepType: step.type,
                success: false,
                data: stepError instanceof Error ? stepError.message : String(stepError)
              }
            });

            // Step failed, abort task
            throw stepError;
          }
        }

        // Task completed
        const screenshot = await page.screenshot({ type: "png" }).catch(() => null);
        let screenshotPath: string | undefined;

        if (screenshot) {
          const { mkdir, writeFile } = await import("node:fs/promises");
          const { join } = await import("node:path");
          const screenshotDir = join(process.cwd(), "data", "screenshots");
          await mkdir(screenshotDir, { recursive: true });
          screenshotPath = join(screenshotDir, `task-${taskName}-${Date.now()}.png`);
          await writeFile(screenshotPath, screenshot);
        }

        await ctx.bus.publish({
          type: "browser.task.completed",
          source: "browser-task",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            taskName,
            totalSteps: steps.length,
            completedSteps,
            screenshot: screenshotPath
          }
        });

        console.log(`[browser-task] Task completed: "${taskName}" (${completedSteps}/${steps.length})`);
      } catch (error) {
        await ctx.bus.publish({
          type: "browser.action.failed",
          source: "browser-task",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            action: `task:${taskName}`,
            error: error instanceof Error ? error.message : String(error)
          }
        });

        console.error(`[browser-task] Task failed: "${taskName}" (${completedSteps}/${steps.length})`);
      } finally {
        await page.close();
      }
    });
  }
};

/**
 * Execute a single browser step
 */
async function executeStep(page: import("playwright").Page, step: BrowserStep): Promise<string | undefined> {
  switch (step.type) {
    case "navigate": {
      const url = step.value;
      if (!url) throw new Error("navigate step requires a value (URL)");
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
      return page.url();
    }

    case "click": {
      const selector = step.selector;
      if (!selector) throw new Error("click step requires a selector");
      await page.click(selector);
      return `clicked: ${selector}`;
    }

    case "type": {
      const selector = step.selector;
      const value = step.value;
      if (!selector || value === undefined) throw new Error("type step requires selector and value");
      await page.fill(selector, value);
      return `typed into: ${selector}`;
    }

    case "wait": {
      if (step.selector) {
        await page.waitForSelector(step.selector, { timeout: step.timeout ?? 10000 });
        return `waited for: ${step.selector}`;
      }
      const ms = Number(step.value) || 1000;
      await page.waitForTimeout(ms);
      return `waited: ${ms}ms`;
    }

    case "extract": {
      if (step.selector) {
        const text = await page.locator(step.selector).innerText().catch(() => "");
        return text;
      }
      const bodyText = await page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("script, style, nav, footer, header").forEach(el => el.remove());
        return clone.innerText?.substring(0, 50000) ?? "";
      });
      return bodyText;
    }

    case "screenshot": {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { join } = await import("node:path");
      const screenshotDir = join(process.cwd(), "data", "screenshots");
      await mkdir(screenshotDir, { recursive: true });

      const filename = `step-${Date.now()}.png`;
      const path = join(screenshotDir, filename);

      if (step.selector) {
        const element = await page.$(step.selector);
        if (element) {
          await element.screenshot({ type: "png", path });
        }
      } else {
        await page.screenshot({ type: "png", path, fullPage: true });
      }
      return path;
    }

    case "scroll": {
      const pixels = Number(step.value) || 500;
      await page.evaluate((px) => window.scrollBy(0, px), pixels);
      return `scrolled: ${pixels}px`;
    }

    default:
      throw new Error(`unknown step type: ${step.type}`);
  }
}
