/**
 * Autonomous - Public Content Generation
 *
 * Generates valuable free content for the AP audience.
 * Builds followers, reputation, and discoverability.
 */

import type { RirdAgent, Content } from "../agent/interface.js";
import type { ActivityStore } from "../activity/store.js";
import { createRecord } from "../activity/record.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ContentConfig {
  capabilities: string[];
  topics: string[];
  maxLengthChars: number;
  minIntervalMs: number;
}

export interface ContentManager {
  generate(): Promise<Content | null>;
  getRecentContent(limit?: number): ContentEntry[];
  getContentStats(): ContentStats;
}

export interface ContentEntry {
  id: string;
  title: string;
  body: string;
  tags: string[];
  publishedAt: number;
}

export interface ContentStats {
  totalPublished: number;
  lastPublishedAt: number;
  avgLengthChars: number;
  topTags: Array<{ tag: string; count: number }>;
}

// ---------------------------------------------------------------------------
// Content topics by capability
// ---------------------------------------------------------------------------

const CAPABILITY_TOPICS: Record<string, string[]> = {
  inference: [
    "AI model comparison and benchmarks",
    "Prompt engineering techniques",
    "LLM use case analysis",
    "AI research paper summaries",
  ],
  browsing: [
    "Web scraping best practices",
    "Website monitoring tools",
    "Data extraction techniques",
    "Competitive intelligence methods",
  ],
  code: [
    "Code review insights",
    "Software architecture patterns",
    "Programming language comparisons",
    "Open source project analysis",
  ],
  data: [
    "Data analysis workflows",
    "Statistical methods overview",
    "Data visualization techniques",
    "Dataset quality assessment",
  ],
  monitoring: [
    "Uptime monitoring strategies",
    "Alert fatigue reduction",
    "SLA tracking methods",
    "Incident response patterns",
  ],
};

// ---------------------------------------------------------------------------
// Content manager implementation
// ---------------------------------------------------------------------------

export function createContentManager(
  agent: RirdAgent,
  store: ActivityStore,
  agentPubkey: string,
  agentPrivateKey: Uint8Array,
  config: ContentConfig
): ContentManager {
  const publishedContent: ContentEntry[] = [];
  let lastPublishTime = 0;

  return {
    async generate(): Promise<Content | null> {
      // Enforce minimum interval
      const now = Date.now();
      if (now - lastPublishTime < config.minIntervalMs) {
        return null;
      }

      // Use the agent's content generation capability
      try {
        const content = await agent.generateContent();
        if (!content) {
          console.log("[content] Agent returned no content");
          return null;
        }

        // Truncate if needed
        if (content.body.length > config.maxLengthChars) {
          content.body = content.body.slice(0, config.maxLengthChars) + "...";
        }

        // Create and store activity record
        const record = await createRecord(
          agentPubkey,
          agentPrivateKey,
          "content.published",
          {
            title: content.title,
            summary: content.body.slice(0, 200),
            tags: content.tags,
            content_hash: `content_${now}`,
          }
        );
        store.insert(record);

        // Track locally
        const entry: ContentEntry = {
          id: record.id,
          title: content.title,
          body: content.body,
          tags: content.tags,
          publishedAt: now,
        };
        publishedContent.push(entry);
        lastPublishTime = now;

        console.log(`[content] Published: ${content.title}`);

        return content;
      } catch (err) {
        console.error(`[content] Generation failed: ${err}`);
        return null;
      }
    },

    getRecentContent(limit: number = 10): ContentEntry[] {
      return publishedContent.slice(-limit).reverse();
    },

    getContentStats(): ContentStats {
      const tagCounts = new Map<string, number>();
      let totalLength = 0;

      for (const entry of publishedContent) {
        totalLength += entry.body.length;
        for (const tag of entry.tags) {
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
      }

      const topTags = Array.from(tagCounts.entries())
        .map(([tag, count]) => ({ tag, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      return {
        totalPublished: publishedContent.length,
        lastPublishedAt: lastPublishTime,
        avgLengthChars:
          publishedContent.length > 0
            ? Math.round(totalLength / publishedContent.length)
            : 0,
        topTags,
      };
    },
  };

  // Suppress unused warning for capability topics
  void CAPABILITY_TOPICS;
  void config.topics;
}
