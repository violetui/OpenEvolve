import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { AgentModule } from "../core/module";

/**
 * BrowserAutomation Core Module
 *
 * Manages the lifecycle of browser instances, provides a shared browser context
 * Uses Playwright's built-in Chromium by default (headless mode)
 * Can be configured via environment variables for system browser or headed mode
 *
 * Environment variables:
 *   BROWSER_HEADLESS=true|false   Headless mode (default: true)
 *   BROWSER_TYPE=chromium|firefox  Browser type (default: chromium)
 *   BROWSER_SLOW_MO=0             Delay between operations in ms (default: 0)
 *
 * Subscribes:
 *   browser.screenshot.requested  → Execute screenshot
 *
 * Publishes:
 *   browser.ready                 → Browser is ready
 *   browser.screenshot.completed  → Screenshot completed
 *   browser.action.failed         → Action failed
 */

let browserInstance: Browser | null = null;
let contextInstance: BrowserContext | null = null;

/**
 * Get shared browser instance (lazy initialization)
 */
export async function getBrowser(): Promise<Browser> {
  if (!browserInstance || !browserInstance.isConnected()) {
    const headless = process.env.BROWSER_HEADLESS !== "false";
    const slowMo = Number(process.env.BROWSER_SLOW_MO ?? 0);

    browserInstance = await chromium.launch({
      headless,
      slowMo,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--window-size=1280,720"
      ]
    });
  }
  return browserInstance;
}

/**
 * Get shared browser context (lazy initialization)
 */
export async function getBrowserContext(): Promise<BrowserContext> {
  if (!contextInstance) {
    const browser = await getBrowser();
    contextInstance = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      locale: "en-US",
      timezoneId: "UTC"
    });
  }
  return contextInstance;
}

/**
 * Create a new page
 */
export async function newPage(): Promise<Page> {
  const context = await getBrowserContext();
  return context.newPage();
}

/**
 * Close browser
 */
export async function closeBrowser(): Promise<void> {
  if (contextInstance) {
    await contextInstance.close();
    contextInstance = null;
  }
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

export const BrowserAutomationModule: AgentModule = {
  name: "browser-automation",

  async start(ctx) {
    // Screenshot request handler
    ctx.bus.subscribe("browser.screenshot.requested", async (event) => {
      const { url, fullPage, selector } = event.payload;

      try {
        const page = await newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });

        // Wait for selector if specified
        if (selector) {
          await page.waitForSelector(selector, { timeout: 10000 });
        }

        let screenshotBuffer: Buffer;

        if (selector) {
          const element = await page.$(selector);
          if (!element) {
            throw new Error(`selector not found: ${selector}`);
          }
          screenshotBuffer = await element.screenshot({ type: "png" });
        } else {
          screenshotBuffer = await page.screenshot({
            fullPage: fullPage ?? false,
            type: "png"
          });
        }

        // Save screenshot to file
        const { mkdir, writeFile } = await import("node:fs/promises");
        const { join } = await import("node:path");
        const screenshotDir = join(process.cwd(), "data", "screenshots");
        await mkdir(screenshotDir, { recursive: true });

        const filename = `screenshot-${Date.now()}.png`;
        const imagePath = join(screenshotDir, filename);
        await writeFile(imagePath, screenshotBuffer);

        const size = await page.viewportSize();

        await ctx.bus.publish({
          type: "browser.screenshot.completed",
          source: "browser-automation",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            url,
            imagePath,
            width: size?.width ?? 1280,
            height: size?.height ?? 720
          }
        });

        await page.close();
      } catch (error) {
        await ctx.bus.publish({
          type: "browser.action.failed",
          source: "browser-automation",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            action: "screenshot",
            url,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });

    // Initialize browser and publish ready event
    try {
      const browser = await getBrowser();
      const headless = process.env.BROWSER_HEADLESS !== "false";

      await ctx.bus.publish({
        type: "browser.ready",
        source: "browser-automation",
        payload: {
          browserType: browser.browserType().name(),
          headless
        }
      });

      console.log(`[browser-automation] Browser ready (${headless ? "headless" : "headed"})`);
    } catch (error) {
      console.error("[browser-automation] Browser launch failed:", error);
    }

    // Cleanup browser on process exit
    process.on("SIGINT", async () => {
      await closeBrowser();
    });
    process.on("SIGTERM", async () => {
      await closeBrowser();
    });
  }
};
