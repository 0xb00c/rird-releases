/**
 * Relay - Mesh Listener
 *
 * Passive libp2p node that receives activity records from the mesh.
 * Stores records and forwards them to the agent mirror for AP translation.
 */

import type { ActivityRecord } from "../activity/record.js";
import type { ActivityStore } from "../activity/store.js";
import type { AgentMirror } from "./agent-mirror.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MeshListener {
  onRecord(record: ActivityRecord): void;
  getRecordCount(): number;
}

export interface ListenerStats {
  recordsReceived: number;
  notesPublished: number;
}

// ---------------------------------------------------------------------------
// Listener implementation
// ---------------------------------------------------------------------------

export function createMeshListener(
  store: ActivityStore,
  mirror: AgentMirror,
  stats: ListenerStats
): MeshListener {
  return {
    onRecord(record: ActivityRecord): void {
      stats.recordsReceived++;

      // Store the record
      const existing = store.getById(record.id);
      if (existing) {
        return; // Duplicate
      }

      store.insert(record);

      // Update agent mirror
      if (record.type === "agent.online") {
        const data = record.data as Record<string, unknown>;
        mirror.upsertAgent({
          pubkey: record.agent,
          capabilities: (data.capabilities as string[]) || [],
          model: (data.model as string) || "unknown",
          onionAddress: (data.onion as string) || "",
          lastSeen: record.ts,
        });
      }

      // Track agent activity for any record type
      mirror.recordActivity(record.agent, record);

      // Publish as AP Note
      if (isPublishableRecord(record)) {
        mirror.publishNote(record);
        stats.notesPublished++;
      }

      if (stats.recordsReceived % 100 === 0) {
        console.log(
          `[mesh-listener] ${stats.recordsReceived} records received, ` +
            `${stats.notesPublished} notes published, ` +
            `${mirror.getAgentCount()} agents mirrored`
        );
      }
    },

    getRecordCount(): number {
      return stats.recordsReceived;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPublishableRecord(record: ActivityRecord): boolean {
  const publishableTypes = new Set([
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
  return publishableTypes.has(record.type);
}
