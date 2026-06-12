import type { AgentModule } from "../core/module";
import { newPage } from "./browser-automation";

/**
 * BrowserSearch Module
 *
 * Subscribes to browser.search.requested
 * Uses Playwright to control the browser and execute search engine queries
 * Publishes browser.search.completed or browser.action.failed
 *
 * Supported search engines:
 *   google      → https://www.google.com/search?q=
 *   bing        → https://www.bing.com/search?q=
 *   duckduckgo  → https://duckduckgo.com/?q=
 *   baidu       → https://www.baidu.com/s?wd=
 *
 * MVP version: uses Google search, extracts top N results
 */
export const BrowserSearchModule: AgentModule = {
  name: "browser-search",

  start(ctx) {
    ctx.bus.subscribe("browser.search.requested", async (event) => {
      const { query, engine, maxResults } = event.payload;
      const searchEngine = engine ?? "google";
      const limit = maxResults ?? 10;

      console.log(`[browser-search] Searching: "${query}" (engine: ${searchEngine}, max results: ${limit})`);

      try {
        const searchUrl = buildSearchUrl(searchEngine, query);
        const page = await newPage();

        await page.goto(searchUrl, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        // Wait for search results to load
        const resultSelector = getSearchResultSelector(searchEngine);
        await page.waitForSelector(resultSelector, { timeout: 15000 });

        // Extra wait to ensure dynamic content is loaded
        await page.waitForTimeout(1000);

        // Extract search results
        const results = await extractSearchResults(page, searchEngine, limit);

        await page.close();

        await ctx.bus.publish({
          type: "browser.search.completed",
          source: "browser-search",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            query,
            results
          }
        });

        console.log(`[browser-search] Search completed, got ${results.length} results`);
      } catch (error) {
        await ctx.bus.publish({
          type: "browser.action.failed",
          source: "browser-search",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            action: "search",
            error: error instanceof Error ? error.message : String(error)
          }
        });

        console.error(`[browser-search] Search failed:`, error instanceof Error ? error.message : String(error));
      }
    });

    // Also subscribe to browser.fetch.requested for page content extraction
    ctx.bus.subscribe("browser.fetch.requested", async (event) => {
      const { url, selector, waitFor } = event.payload;

      console.log(`[browser-search] Fetching page: ${url}`);

      try {
        const page = await newPage();
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout: 30000
        });

        if (waitFor) {
          await page.waitForTimeout(waitFor);
        }

        if (selector) {
          await page.waitForSelector(selector, { timeout: 10000 });
        }

        const title = await page.title();

        // Extract page text content
        const content = selector
          ? await page.locator(selector).innerText().catch(() => "")
          : await page.evaluate(() => {
              // Remove script and style tags, get plain text
              const clone = document.body.cloneNode(true) as HTMLElement;
              clone.querySelectorAll("script, style, nav, footer, header").forEach(el => el.remove());
              return clone.innerText?.substring(0, 50000) ?? "";
            });

        const statusCode = response?.status() ?? 0;

        await page.close();

        await ctx.bus.publish({
          type: "browser.fetch.completed",
          source: "browser-search",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            url,
            title,
            content,
            statusCode
          }
        });

        console.log(`[browser-search] Page fetched: ${title} (${statusCode})`);
      } catch (error) {
        await ctx.bus.publish({
          type: "browser.action.failed",
          source: "browser-search",
          correlationId: event.correlationId,
          causationId: event.id,
          payload: {
            action: "fetch",
            url,
            error: error instanceof Error ? error.message : String(error)
          }
        });
      }
    });
  }
};

/**
 * Build search URL
 */
function buildSearchUrl(engine: string, query: string): string {
  const encoded = encodeURIComponent(query);
  const urls: Record<string, string> = {
    google: `https://www.google.com/search?q=${encoded}`,
    bing: `https://www.bing.com/search?q=${encoded}`,
    duckduckgo: `https://duckduckgo.com/?q=${encoded}`,
    baidu: `https://www.baidu.com/s?wd=${encoded}`
  };
  return urls[engine] ?? urls.google!;
}

/**
 * Get search engine result selector
 */
function getSearchResultSelector(engine: string): string {
  const selectors: Record<string, string> = {
    google: "#search div.g",
    bing: ".b_algo",
    duckduckgo: ".result",
    baidu: ".result.c-container"
  };
  return selectors[engine] ?? selectors.google!;
}

/**
 * Extract search results from the page
 */
async function extractSearchResults(
  page: import("playwright").Page,
  engine: string,
  maxResults: number
): Promise<Array<{ title: string; url: string; snippet: string }>> {
  const extractors: Record<string, () => Promise<Array<{ title: string; url: string; snippet: string }>>> = {
    google: async () => {
      return page.evaluate((limit) => {
        const items = document.querySelectorAll("#search div.g");
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        for (let i = 0; i < Math.min(items.length, limit); i++) {
          const item = items[i]!;
          const titleEl = item.querySelector("h3");
          const linkEl = item.querySelector("a");
          const snippetEl = item.querySelector("[data-sncf], .VwiC3b, span.st");

          if (titleEl && linkEl) {
            results.push({
              title: titleEl.textContent?.trim() ?? "",
              url: linkEl.getAttribute("href") ?? "",
              snippet: snippetEl?.textContent?.trim() ?? ""
            });
          }
        }
        return results;
      }, maxResults);
    },

    bing: async () => {
      return page.evaluate((limit) => {
        const items = document.querySelectorAll(".b_algo");
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        for (let i = 0; i < Math.min(items.length, limit); i++) {
          const item = items[i]!;
          const titleEl = item.querySelector("h2 a");
          const snippetEl = item.querySelector(".b_caption p");

          if (titleEl) {
            results.push({
              title: titleEl.textContent?.trim() ?? "",
              url: titleEl.getAttribute("href") ?? "",
              snippet: snippetEl?.textContent?.trim() ?? ""
            });
          }
        }
        return results;
      }, maxResults);
    },

    duckduckgo: async () => {
      return page.evaluate((limit) => {
        const items = document.querySelectorAll(".result");
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        for (let i = 0; i < Math.min(items.length, limit); i++) {
          const item = items[i]!;
          const titleEl = item.querySelector(".result__a");
          const snippetEl = item.querySelector(".result__snippet");

          if (titleEl) {
            results.push({
              title: titleEl.textContent?.trim() ?? "",
              url: titleEl.getAttribute("href") ?? "",
              snippet: snippetEl?.textContent?.trim() ?? ""
            });
          }
        }
        return results;
      }, maxResults);
    },

    baidu: async () => {
      return page.evaluate((limit) => {
        const items = document.querySelectorAll(".result.c-container");
        const results: Array<{ title: string; url: string; snippet: string }> = [];

        for (let i = 0; i < Math.min(items.length, limit); i++) {
          const item = items[i]!;
          const titleEl = item.querySelector("h3 a");
          const snippetEl = item.querySelector(".c-abstract, .content-right_8Zs40");

          if (titleEl) {
            results.push({
              title: titleEl.textContent?.trim() ?? "",
              url: titleEl.getAttribute("href") ?? "",
              snippet: snippetEl?.textContent?.trim() ?? ""
            });
          }
        }
        return results;
      }, maxResults);
    }
  };

  const extractor = extractors[engine] ?? extractors.google!;
  return extractor();
}
