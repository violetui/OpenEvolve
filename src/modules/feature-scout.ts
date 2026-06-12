import type { AgentModule } from "../core/module";
import type { FeatureSourceType } from "../core/event-types";
import { newPage } from "./browser-automation";

/**
 * FeatureScout Module
 *
 * Subscribes to feature.scout.requested
 * Searches external feature sources (GitHub, MCP Registry, npm, etc.)
 * Publishes feature.sources.discovered
 *
 * Uses Playwright browser for real search
 * Falls back to preset data when browser is unavailable
 */
export const FeatureScoutModule: AgentModule = {
  name: "feature-scout",

  start(ctx) {
    ctx.bus.subscribe("feature.scout.requested", async (event) => {
      const topics = event.payload.topics ?? [
        "AI agent plugin",
        "MCP server",
        "coding agent feature"
      ];
      const requestedSources = event.payload.sources;

      console.log(`[feature-scout] Starting external feature search, topics: ${topics.join(", ")}`);

      let allSources: Array<{
        type: FeatureSourceType;
        url: string;
        name: string;
        description: string;
      }>;

      // Try real browser search
      try {
        allSources = await searchWithBrowser(topics, requestedSources);
      } catch (error) {
        console.log(`[feature-scout] Browser search failed, using preset data: ${error instanceof Error ? error.message : String(error)}`);
        allSources = getFallbackSources(requestedSources);
      }

      await ctx.bus.publish({
        type: "feature.sources.discovered",
        source: "feature-scout",
        correlationId: event.correlationId,
        causationId: event.id,
        payload: {
          sources: allSources
        }
      });
    });
  }
};

/**
 * Search using Playwright browser
 *
 * Search strategy:
 * 1. GitHub Search API → search AI agent related repos
 * 2. npm Search → search agent related packages
 * 3. Hacker News → search trending AI agent discussions
 * 4. Preset MCP Registry and Changelog URLs
 */
async function searchWithBrowser(
  topics: string[],
  requestedSources?: FeatureSourceType[]
): Promise<Array<{
  type: FeatureSourceType;
  url: string;
  name: string;
  description: string;
}>> {
  const results: Array<{
    type: FeatureSourceType;
    url: string;
    name: string;
    description: string;
  }> = [];

  const shouldSearch = (sourceType: FeatureSourceType): boolean => {
    if (!requestedSources || requestedSources.length === 0) return true;
    return requestedSources.includes(sourceType);
  };

  // 1. GitHub search
  if (shouldSearch("github")) {
    try {
      const githubResults = await searchGitHub(topics);
      results.push(...githubResults);
    } catch (error) {
      console.error("[feature-scout] GitHub search failed:", error instanceof Error ? error.message : String(error));
      results.push(...getFallbackSources(["github"]).filter(s => s.type === "github"));
    }
  }

  // 2. npm search
  if (shouldSearch("npm")) {
    try {
      const npmResults = await searchNpm(topics);
      results.push(...npmResults);
    } catch (error) {
      console.error("[feature-scout] npm search failed:", error instanceof Error ? error.message : String(error));
      results.push(...getFallbackSources(["npm"]).filter(s => s.type === "npm"));
    }
  }

  // 3. Hacker News search
  if (shouldSearch("blog")) {
    try {
      const hnResults = await searchHackerNews(topics);
      results.push(...hnResults);
    } catch (error) {
      console.error("[feature-scout] HN search failed:", error instanceof Error ? error.message : String(error));
      results.push(...getFallbackSources(["blog"]).filter(s => s.type === "blog"));
    }
  }

  // 4. Preset sources (fixed URLs that don't need searching)
  if (shouldSearch("mcp_registry")) {
    results.push({
      type: "mcp_registry",
      url: "https://registry.modelcontextprotocol.io",
      name: "MCP Registry",
      description: "MCP Server directory providing standardized AI agent tool registration"
    });
  }

  if (shouldSearch("product_changelog")) {
    results.push(
      {
        type: "product_changelog",
        url: "https://github.blog/changelog/",
        name: "GitHub Copilot Changelog",
        description: "Latest GitHub Copilot feature updates"
      },
      {
        type: "product_changelog",
        url: "https://cursor.com/changelog",
        description: "Latest Cursor AI editor feature updates",
        name: "Cursor Changelog"
      }
    );
  }

  if (shouldSearch("paper")) {
    results.push({
      type: "paper",
      url: "https://paperswithcode.com",
      name: "Papers with Code",
      description: "Latest AI agent related papers with code implementations"
    });
  }

  return results;
}

/**
 * Search GitHub using browser
 */
async function searchGitHub(
  topics: string[]
): Promise<Array<{
  type: FeatureSourceType;
  url: string;
  name: string;
  description: string;
}>> {
  const page = await newPage();
  const results: Array<{
    type: FeatureSourceType;
    url: string;
    name: string;
    description: string;
  }> = [];

  try {
    // GitHub Trending
    await page.goto("https://github.com/trending?since=daily", {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const trending = await page.evaluate(() => {
      const repos = document.querySelectorAll("article.Box-row");
      return Array.from(repos).slice(0, 5).map(repo => {
        const linkEl = repo.querySelector("h2 a");
        const descEl = repo.querySelector("p");
        const href = linkEl?.getAttribute("href") ?? "";
        return {
          name: href.replace(/^\//, ""),
          url: `https://github.com${href}`,
          description: descEl?.textContent?.trim() ?? ""
        };
      });
    });

    for (const repo of trending) {
      results.push({
        type: "github",
        ...repo
      });
    }

    // GitHub Search
    const searchQuery = topics.slice(0, 3).join("+");
    await page.goto(`https://github.com/search?q=${encodeURIComponent(searchQuery)}&type=repositories`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    const searchResults = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-testid="results-list"] > div');
      return Array.from(items).slice(0, 5).map(item => {
        const linkEl = item.querySelector("a[href]");
        const descEl = item.querySelector("p");
        const href = linkEl?.getAttribute("href") ?? "";
        return {
          name: href.replace(/^\//, ""),
          url: href.startsWith("http") ? href : `https://github.com${href}`,
          description: descEl?.textContent?.trim() ?? ""
        };
      });
    });

    for (const repo of searchResults) {
      results.push({
        type: "github",
        ...repo
      });
    }
  } finally {
    await page.close();
  }

  return results;
}

/**
 * Search npm using browser
 */
async function searchNpm(
  topics: string[]
): Promise<Array<{
  type: FeatureSourceType;
  url: string;
  name: string;
  description: string;
}>> {
  const page = await newPage();
  const results: Array<{
    type: FeatureSourceType;
    url: string;
    name: string;
    description: string;
  }> = [];

  try {
    const searchQuery = topics.slice(0, 2).join(" ");
    await page.goto(`https://www.npmjs.com/search?q=${encodeURIComponent(searchQuery)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(2000);

    const packages = await page.evaluate(() => {
      const items = document.querySelectorAll('[data-testid="package-list-item"]');
      return Array.from(items).slice(0, 5).map(item => {
        const nameEl = item.querySelector("h3 a, a[href*='/package/']");
        const descEl = item.querySelector("p");
        const name = nameEl?.textContent?.trim() ?? "";
        const href = nameEl?.getAttribute("href") ?? "";
        return {
          name: name || href.replace("/package/", ""),
          url: href.startsWith("http") ? href : `https://www.npmjs.com${href}`,
          description: descEl?.textContent?.trim() ?? ""
        };
      });
    });

    for (const pkg of packages) {
      results.push({
        type: "npm",
        ...pkg
      });
    }
  } finally {
    await page.close();
  }

  return results;
}

/**
 * Search Hacker News using browser
 */
async function searchHackerNews(
  topics: string[]
): Promise<Array<{
  type: FeatureSourceType;
  url: string;
  name: string;
  description: string;
}>> {
  const page = await newPage();
  const results: Array<{
    type: FeatureSourceType;
    url: string;
    name: string;
    description: string;
  }> = [];

  try {
    const searchQuery = topics.slice(0, 2).join(" ");
    await page.goto(`https://hn.algolia.com/?q=${encodeURIComponent(searchQuery)}`, {
      waitUntil: "domcontentloaded",
      timeout: 30000
    });

    await page.waitForTimeout(2000);

    const posts = await page.evaluate(() => {
      const items = document.querySelectorAll(".hit");
      return Array.from(items).slice(0, 5).map(item => {
        const titleEl = item.querySelector("h2 a, .hit-title a");
        const title = titleEl?.textContent?.trim() ?? "";
        const href = titleEl?.getAttribute("href") ?? "";
        return {
          name: title,
          url: href,
          description: title
        };
      });
    });

    for (const post of posts) {
      results.push({
        type: "blog",
        ...post
      });
    }
  } finally {
    await page.close();
  }

  return results;
}

/**
 * Fallback to preset data (when browser is unavailable)
 */
function getFallbackSources(
  requestedSources?: FeatureSourceType[]
): Array<{
  type: FeatureSourceType;
  url: string;
  name: string;
  description: string;
}> {
  const availableSources: Array<{
    type: FeatureSourceType;
    url: string;
    name: string;
    description: string;
  }> = [
    {
      type: "mcp_registry",
      url: "https://registry.modelcontextprotocol.io",
      name: "MCP Registry",
      description: "MCP Server directory providing standardized AI agent tool registration"
    },
    {
      type: "github",
      url: "https://github.com/trending?since=daily",
      name: "GitHub Trending",
      description: "Daily trending GitHub repos, discover new agent-related projects"
    },
    {
      type: "github",
      url: "https://github.com/search?q=ai+agent+plugin&type=repositories",
      name: "GitHub Agent Repos",
      description: "AI agent plugin related repositories on GitHub"
    },
    {
      type: "npm",
      url: "https://www.npmjs.com/search?q=ai%20agent",
      name: "npm Agent Packages",
      description: "AI agent related packages on npm"
    },
    {
      type: "product_changelog",
      url: "https://github.blog/changelog/",
      name: "GitHub Copilot Changelog",
      description: "Latest GitHub Copilot feature updates"
    },
    {
      type: "product_changelog",
      url: "https://cursor.com/changelog",
      name: "Cursor Changelog",
      description: "Latest Cursor AI editor feature updates"
    },
    {
      type: "blog",
      url: "https://news.ycombinator.com",
      name: "Hacker News",
      description: "AI agent related discussions and links on Hacker News"
    },
    {
      type: "paper",
      url: "https://paperswithcode.com",
      name: "Papers with Code",
      description: "Latest AI agent related papers with code implementations"
    }
  ];

  if (requestedSources && requestedSources.length > 0) {
    return availableSources.filter(s => requestedSources.includes(s.type));
  }

  return availableSources;
}
