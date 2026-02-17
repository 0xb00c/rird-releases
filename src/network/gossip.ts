/**
 * Network - Gossip Pub/Sub
 *
 * Activity record publishing and subscription over gossipsub.
 * Handles message serialization, deduplication, and routing.
 */

import type { NetworkNode, TopicName } from "./node.js";
import type { ActivityRecord } from "../activity/record.js";
import { verifyRecord, serializeRecord } from "../activity/record.js";
import { TOPICS } from "./node.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordHandler = (record: ActivityRecord) => void;

interface GossipManager {
  publish(topic: TopicName, record: ActivityRecord): Promise<void>;
  subscribe(topic: TopicName, handler: RecordHandler): void;
  unsubscribe(topic: TopicName): void;
  getSubscriptions(): TopicName[];
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

// Deduplication: track recently seen record IDs
const seenRecords = new Map<string, number>();
const SEEN_TTL_MS = 3600_000; // 1 hour
const MAX_SEEN = 10_000;

// Handlers per topic
const topicHandlers = new Map<string, Set<RecordHandler>>();

// ---------------------------------------------------------------------------
// Gossip manager
// ---------------------------------------------------------------------------

export function createGossipManager(node: NetworkNode): GossipManager {
  const pubsub = node.libp2p.services.pubsub as Record<string, unknown> | undefined;

  // Set up incoming message handler
  if (pubsub && "addEventListener" in pubsub) {
    const ps = pubsub as {
      addEventListener(event: string, handler: (evt: unknown) => void): void;
    };
    ps.addEventListener("message", (evt: unknown) => {
      handleIncomingMessage(evt);
    });
  }

  // Periodic cleanup of seen records
  const cleanupInterval = setInterval(() => {
    pruneSeenRecords();
  }, 60_000);

  // Return cleanup handle so it can be stopped
  const originalStop = node.stop.bind(node);
  node.stop = async () => {
    clearInterval(cleanupInterval);
    await originalStop();
  };

  return {
    async publish(topic: TopicName, record: ActivityRecord): Promise<void> {
      const bytes = serializeRecord(record);

      // Mark as seen so we don't process our own messages
      seenRecords.set(record.id, Date.now());

      if (pubsub && "publish" in pubsub) {
        const ps = pubsub as {
          publish(topic: string, data: Uint8Array): Promise<void>;
        };
        await ps.publish(topic, bytes);
        console.log(
          `[gossip] Published ${record.type} to ${topic} (${bytes.length} bytes)`
        );
      } else {
        console.warn("[gossip] Pubsub not available, record not published");
      }
    },

    subscribe(topic: TopicName, handler: RecordHandler): void {
      if (!topicHandlers.has(topic)) {
        topicHandlers.set(topic, new Set());
      }
      topicHandlers.get(topic)!.add(handler);

      // Subscribe on the pubsub layer if not already
      if (pubsub && "subscribe" in pubsub) {
        const ps = pubsub as { subscribe(topic: string): void };
        ps.subscribe(topic);
      }

      console.log(`[gossip] Subscribed handler to ${topic}`);
    },

    unsubscribe(topic: TopicName): void {
      topicHandlers.delete(topic);

      if (pubsub && "unsubscribe" in pubsub) {
        const ps = pubsub as { unsubscribe(topic: string): void };
        ps.unsubscribe(topic);
      }

      console.log(`[gossip] Unsubscribed from ${topic}`);
    },

    getSubscriptions(): TopicName[] {
      return Array.from(topicHandlers.keys()) as TopicName[];
    },
  };
}

// ---------------------------------------------------------------------------
// Incoming message processing
// ---------------------------------------------------------------------------

function handleIncomingMessage(evt: unknown): void {
  try {
    const event = evt as {
      detail?: { topic: string; data: Uint8Array };
    };
    if (!event.detail) return;

    const { topic, data } = event.detail;

    // Deserialize the activity record
    let record: ActivityRecord;
    try {
      const text = new TextDecoder().decode(data);
      record = JSON.parse(text) as ActivityRecord;
    } catch {
      console.warn("[gossip] Failed to deserialize incoming message");
      return;
    }

    // Deduplication check
    if (seenRecords.has(record.id)) {
      return;
    }
    seenRecords.set(record.id, Date.now());

    // Verify signature
    verifyRecord(record)
      .then((valid) => {
        if (!valid) {
          console.warn(
            `[gossip] Invalid signature on record ${record.id.slice(0, 12)}...`
          );
          return;
        }

        // Check timestamp drift (1 hour max)
        const now = Math.floor(Date.now() / 1000);
        const drift = Math.abs(now - record.ts);
        if (drift > 3600) {
          console.warn(
            `[gossip] Record ${record.id.slice(0, 12)}... has excessive timestamp drift (${drift}s)`
          );
          return;
        }

        // Route to handlers
        routeRecord(topic, record);
      })
      .catch((err) => {
        console.error(`[gossip] Verification error: ${err}`);
      });
  } catch (err) {
    console.error(`[gossip] Error handling incoming message: ${err}`);
  }
}

function routeRecord(topic: string, record: ActivityRecord): void {
  // Route to topic-specific handlers
  const handlers = topicHandlers.get(topic);
  if (handlers) {
    for (const handler of handlers) {
      try {
        handler(record);
      } catch (err) {
        console.error(`[gossip] Handler error on ${topic}: ${err}`);
      }
    }
  }

  // Also route to the activity feed handlers if it's a different topic
  if (topic !== TOPICS.ACTIVITY) {
    const activityHandlers = topicHandlers.get(TOPICS.ACTIVITY);
    if (activityHandlers) {
      for (const handler of activityHandlers) {
        try {
          handler(record);
        } catch (err) {
          console.error(`[gossip] Activity handler error: ${err}`);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Deduplication maintenance
// ---------------------------------------------------------------------------

function pruneSeenRecords(): void {
  const now = Date.now();
  const expiredKeys: string[] = [];

  for (const [id, timestamp] of seenRecords) {
    if (now - timestamp > SEEN_TTL_MS) {
      expiredKeys.push(id);
    }
  }

  for (const key of expiredKeys) {
    seenRecords.delete(key);
  }

  // If still too large, remove oldest entries
  if (seenRecords.size > MAX_SEEN) {
    const entries = Array.from(seenRecords.entries())
      .sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, seenRecords.size - MAX_SEEN);
    for (const [key] of toRemove) {
      seenRecords.delete(key);
    }
  }
}
