/**
 * Network - Gossip Layer
 *
 * Activity record publishing and reception over TCP gossip.
 * Handles serialization, deduplication, and routing.
 */

import type { NetworkNode, TopicName } from "./node.js";
import type { ActivityRecord } from "../activity/record.js";
import { verifyRecord } from "../activity/record.js";

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

const seenRecords = new Map<string, number>();
const SEEN_TTL_MS = 3600_000;
const MAX_SEEN = 10_000;

const topicHandlers = new Map<string, Set<RecordHandler>>();

// ---------------------------------------------------------------------------
// Gossip manager
// ---------------------------------------------------------------------------

export function createGossipManager(node: NetworkNode): GossipManager {
  // Handle incoming messages from peers
  node.onMessage((data: unknown) => {
    handleIncomingMessage(data);
  });

  // Periodic cleanup
  const cleanupInterval = setInterval(() => {
    pruneSeenRecords();
  }, 60_000);

  const originalStop = node.stop.bind(node);
  node.stop = async () => {
    clearInterval(cleanupInterval);
    await originalStop();
  };

  return {
    async publish(_topic: TopicName, record: ActivityRecord): Promise<void> {
      // Mark as seen so we don't process our own messages
      seenRecords.set(record.id, Date.now());

      const peers = node.getPeers();
      if (peers.length === 0) {
        console.log("[gossip] No peers connected (record stored locally)");
        return;
      }

      // Broadcast to all connected peers
      node.broadcast(record);
      console.log(
        `[gossip] Published ${record.type} to ${peers.length} peer(s)`
      );
    },

    subscribe(topic: TopicName, handler: RecordHandler): void {
      if (!topicHandlers.has(topic)) {
        topicHandlers.set(topic, new Set());
      }
      topicHandlers.get(topic)!.add(handler);
      console.log(`[gossip] Subscribed to ${topic}`);
    },

    unsubscribe(topic: TopicName): void {
      topicHandlers.delete(topic);
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

function handleIncomingMessage(data: unknown): void {
  try {
    const record = data as ActivityRecord;

    // Basic validation
    if (!record || !record.id || !record.type || !record.agent) {
      return;
    }

    // Deduplication
    if (seenRecords.has(record.id)) {
      return;
    }
    seenRecords.set(record.id, Date.now());

    // Verify signature
    verifyRecord(record)
      .then((valid) => {
        if (!valid) {
          console.warn(`[gossip] Invalid signature on record ${record.id.slice(0, 12)}...`);
          return;
        }

        // Check timestamp drift (1 hour max)
        const now = Math.floor(Date.now() / 1000);
        const drift = Math.abs(now - record.ts);
        if (drift > 3600) {
          console.warn(`[gossip] Record ${record.id.slice(0, 12)}... has excessive drift (${drift}s)`);
          return;
        }

        // Route to all subscribed handlers
        routeRecord(record);
      })
      .catch((err) => {
        console.error(`[gossip] Verification error: ${err}`);
      });
  } catch (err) {
    console.error(`[gossip] Error handling message: ${err}`);
  }
}

function routeRecord(record: ActivityRecord): void {
  // Send to all topic handlers (in this simple model, all handlers get all messages)
  for (const [_topic, handlers] of topicHandlers) {
    for (const handler of handlers) {
      try {
        handler(record);
      } catch (err) {
        console.error(`[gossip] Handler error: ${err}`);
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

  if (seenRecords.size > MAX_SEEN) {
    const entries = Array.from(seenRecords.entries())
      .sort((a, b) => a[1] - b[1]);
    const toRemove = entries.slice(0, seenRecords.size - MAX_SEEN);
    for (const [key] of toRemove) {
      seenRecords.delete(key);
    }
  }
}
