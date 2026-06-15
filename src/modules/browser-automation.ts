import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import type { Browser, BrowserContext, Page } from "playwright";
import type { AgentModule } from "../core/module";

// Apply the stealth plugin to evade bot detection
chromium.use(StealthPlugin());

/**
 * BrowserAutomation Core Module
 *
 * Manages the lifecycle of browser instances, provides a shared browser context
 * Uses Playwright with stealth plugin to bypass anti-bot detection.
 *
 * Anti-detection measures:
 *   - puppeteer-extra-plugin-stealth: hides navigator.webdriver, fakes plugins/chrome runtime
 *   - Realistic user agent rotation
 *   - --disable-blink-features=AutomationControlled
 *   - Randomized viewport dimensions
 *   - Common Accept-Language headers
 *
 * Environment variables:
 *   BROWSER_HEADLESS=true|false   Headless mode (default: false)
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

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
];

const ACCEPT_LANGUAGES = [
  "en-US,en;q=0.9",
  "en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7",
  "en-GB,en;q=0.9,en-US;q=0.8",
];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomViewport(): { width: number; height: number } {
  const viewports = [
    { width: 1920, height: 1080 },
    { width: 1680, height: 1050 },
    { width: 1440, height: 900 },
    { width: 1366, height: 768 },
    { width: 1280, height: 720 },
  ];
  return pick(viewports);
}

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
        "--disable-blink-features=AutomationControlled",
        "--disable-features=IsolateOrigins,site-per-process",
        "--disable-site-isolation-trials",
        "--disable-web-security",
        "--disable-features=BlockInsecurePrivateNetworkRequests",
        "--disable-features=OutOfBlinkCors",
        "--window-size=1920,1080",
        "--start-maximized",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-infobars",
        "--disable-breakpad",
        "--disable-component-extensions-with-background-pages",
        "--disable-client-side-phishing-detection",
        "--disable-sync",
        "--disable-default-apps",
        "--hide-scrollbars",
        "--mute-audio",
        "--disable-extensions",
        "--disable-notifications",
        "--disable-popup-blocking",
      ],
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
    const viewport = randomViewport();
    contextInstance = await browser.newContext({
      viewport,
      userAgent: pick(USER_AGENTS),
      locale: "en-US",
      timezoneId: "America/New_York",
      geolocation: { latitude: 40.7128, longitude: -74.006 },
      permissions: ["geolocation"],
      extraHTTPHeaders: {
        "Accept-Language": pick(ACCEPT_LANGUAGES),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "DNT": "1",
        "Upgrade-Insecure-Requests": "1",
        "Sec-Fetch-Dest": "document",
        "Sec-Fetch-Mode": "navigate",
        "Sec-Fetch-Site": "none",
        "Sec-Fetch-User": "?1",
        "Cache-Control": "max-age=0",
      },
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
