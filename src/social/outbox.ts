/**
 * Social - ActivityPub Outbox
 *
 * Serves activity records as an AP OrderedCollection.
 * Translates internal activity records to AP Note activities.
 */

import type { ActivityRecord } from "../activity/record.js";
import type { ActivityStore } from "../activity/store.js";
import { recordToNote } from "./notes.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface APOrderedCollection {
  "@context": string;
  id: string;
  type: "OrderedCollection";
  totalItems: number;
  first: string;
  last: string;
}

export interface APOrderedCollectionPage {
  "@context": string;
  id: string;
  type: "OrderedCollectionPage";
  partOf: string;
  totalItems: number;
  orderedItems: APActivity[];
  next?: string;
  prev?: string;
}

export interface APActivity {
  "@context": string;
  id: string;
  type: "Create";
  actor: string;
  published: string;
  to: string[];
  cc: string[];
  object: APNote;
}

export interface APNote {
  id: string;
  type: "Note";
  attributedTo: string;
  content: string;
  published: string;
  to: string[];
  cc: string[];
  tag: APTag[];
  url: string;
}

export interface APTag {
  type: "Hashtag" | "Mention";
  name: string;
  href?: string;
}

// ---------------------------------------------------------------------------
// Outbox manager
// ---------------------------------------------------------------------------

export interface OutboxManager {
  getCollection(): APOrderedCollection;
  getPage(page: number, pageSize?: number): APOrderedCollectionPage;
  addRecord(record: ActivityRecord): void;
}

export function createOutboxManager(
  store: ActivityStore,
  onionAddress: string,
  agentPubkey: string
): OutboxManager {
  const baseUrl = `https://${onionAddress}`;
  const actorUrl = `${baseUrl}/actor`;
  const outboxUrl = `${baseUrl}/outbox`;
  const publicAddress = "https://www.w3.org/ns/activitystreams#Public";

  return {
    getCollection(): APOrderedCollection {
      const totalItems = store.count();
      return {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: outboxUrl,
        type: "OrderedCollection",
        totalItems,
        first: `${outboxUrl}?page=1`,
        last: `${outboxUrl}?page=${Math.max(1, Math.ceil(totalItems / 20))}`,
      };
    },

    getPage(page: number, pageSize: number = 20): APOrderedCollectionPage {
      // Query records for this agent, ordered by time descending
      const allRecords = store.queryByAgent(agentPubkey, 1000);

      // Filter to only public record types
      const publicRecords = allRecords.filter((r) =>
        isOutboxRecordType(r.type)
      );

      const totalItems = publicRecords.length;
      const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
      const startIdx = (page - 1) * pageSize;
      const pageRecords = publicRecords.slice(startIdx, startIdx + pageSize);

      const orderedItems = pageRecords.map((record) =>
        recordToActivity(record, actorUrl, baseUrl, publicAddress)
      );

      const result: APOrderedCollectionPage = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${outboxUrl}?page=${page}`,
        type: "OrderedCollectionPage",
        partOf: outboxUrl,
        totalItems,
        orderedItems,
      };

      if (page < totalPages) {
        result.next = `${outboxUrl}?page=${page + 1}`;
      }
      if (page > 1) {
        result.prev = `${outboxUrl}?page=${page - 1}`;
      }

      return result;
    },

    addRecord(record: ActivityRecord): void {
      // Record is already stored -- this method ensures it appears in the outbox
      // by verifying it's from our agent
      if (record.agent !== agentPubkey) {
        console.warn("[outbox] Attempted to add record from different agent");
        return;
      }
      // The outbox queries the store directly, so nothing else needed
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordToActivity(
  record: ActivityRecord,
  actorUrl: string,
  baseUrl: string,
  publicAddress: string
): APActivity {
  const note = recordToNote(record, baseUrl);
  const published = new Date(record.ts * 1000).toISOString();

  return {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${baseUrl}/activity/${record.id}`,
    type: "Create",
    actor: actorUrl,
    published,
    to: [publicAddress],
    cc: [`${actorUrl}/followers`],
    object: {
      id: `${baseUrl}/note/${record.id}`,
      type: "Note",
      attributedTo: actorUrl,
      content: note.content,
      published,
      to: [publicAddress],
      cc: [`${actorUrl}/followers`],
      tag: note.tags.map((t) => ({
        type: "Hashtag" as const,
        name: `#${t}`,
      })),
      url: `${baseUrl}/note/${record.id}`,
    },
  };
}

function isOutboxRecordType(type: string): boolean {
  const outboxTypes = new Set([
    "agent.online",
    "agent.offline",
    "task.posted",
    "task.assigned",
    "task.completed",
    "task.verified",
    "task.settled",
    "task.failed",
    "reputation.attestation",
    "spawn.new",
    "spawn.dead",
    "content.published",
  ]);
  return outboxTypes.has(type);
}
