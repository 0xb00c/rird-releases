/**
 * Reputation - Local Trust Score Computation
 *
 * Computes reputation scores locally from observed attestation records.
 * No global consensus -- each agent computes its own view.
 *
 * Score formula:
 *   score = weighted_average(
 *     completion_rate * 0.3,
 *     avg_rating * 0.3,
 *     log(task_volume) * 0.2,
 *     recency_factor * 0.2
 *   )
 */

import type { ActivityStore } from "../activity/store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReputationScore {
  agent: string;
  overall: number; // 0-5 scale
  completionRate: number; // 0-1
  avgRating: number; // 0-5
  taskVolume: number;
  recencyFactor: number; // 0-1
  dimensions: {
    quality: number;
    speed: number;
    communication: number;
  };
  attestationCount: number;
  lastUpdated: number;
}

export interface ReputationComputer {
  compute(agentPubkey: string): ReputationScore;
  computeAll(): ReputationScore[];
  getBlacklist(): Set<string>;
  blacklist(agentPubkey: string): void;
  unblacklist(agentPubkey: string): void;
  isBlacklisted(agentPubkey: string): boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WEIGHT_COMPLETION = 0.3;
const WEIGHT_RATING = 0.3;
const WEIGHT_VOLUME = 0.2;
const WEIGHT_RECENCY = 0.2;

// Recency decay thresholds (seconds)
const DECAY_30_DAYS = 30 * 24 * 3600;
const DECAY_90_DAYS = 90 * 24 * 3600;

// ---------------------------------------------------------------------------
// Reputation computer
// ---------------------------------------------------------------------------

export function createReputationComputer(store: ActivityStore): ReputationComputer {
  const localBlacklist = new Set<string>();

  return {
    compute(agentPubkey: string): ReputationScore {
      const now = Math.floor(Date.now() / 1000);

      // Gather attestation records targeting this agent
      const allAttestations = store.queryByType("reputation.attestation", 1000);
      const attestations = allAttestations.filter((r) => {
        const data = r.data as Record<string, unknown>;
        return data.target === agentPubkey;
      });

      if (attestations.length === 0) {
        return emptyScore(agentPubkey);
      }

      // Compute completion rate from assigned vs completed/failed
      const assigned = store.queryByType("task.assigned", 500).filter(
        (r) => (r.data as Record<string, unknown>).executor === agentPubkey
      );
      const completed = store.queryByType("task.completed", 500).filter(
        (r) => r.agent === agentPubkey
      );
      const failed = store.queryByType("task.failed", 500).filter(
        (r) => r.agent === agentPubkey
      );

      const totalTasks = assigned.length;
      const completedTasks = completed.length;
      const completionRate =
        totalTasks > 0 ? completedTasks / totalTasks : 0;

      // Compute weighted average rating with recency decay
      let weightedRatingSum = 0;
      let weightSum = 0;
      let qualitySum = 0;
      let speedSum = 0;
      let commSum = 0;
      let dimCount = 0;

      for (const att of attestations) {
        const data = att.data as Record<string, unknown>;
        const score = data.score as number;
        const age = now - att.ts;

        // Recency weight
        let recencyWeight = 1.0;
        if (age > DECAY_90_DAYS) {
          recencyWeight = 0.25;
        } else if (age > DECAY_30_DAYS) {
          recencyWeight = 0.5;
        }

        weightedRatingSum += score * recencyWeight;
        weightSum += recencyWeight;

        // Dimensions
        const dims = data.dimensions as Record<string, number> | undefined;
        if (dims) {
          qualitySum += (dims.quality || 0) * recencyWeight;
          speedSum += (dims.speed || 0) * recencyWeight;
          commSum += (dims.communication || 0) * recencyWeight;
          dimCount++;
        }
      }

      const avgRating = weightSum > 0 ? weightedRatingSum / weightSum : 0;

      // Task volume factor: logarithmic scaling
      const volumeFactor =
        totalTasks > 0 ? Math.min(Math.log10(totalTasks + 1) / 3, 1.0) : 0;

      // Recency factor: based on most recent attestation
      const mostRecent = attestations.reduce(
        (latest, r) => (r.ts > latest ? r.ts : latest),
        0
      );
      const daysSinceActivity = (now - mostRecent) / 86400;
      const recencyFactor = Math.max(
        1.0 - daysSinceActivity / 90,
        0
      );

      // Final composite score (0-5 scale)
      const overall =
        completionRate * WEIGHT_COMPLETION * 5 +
        avgRating * WEIGHT_RATING +
        volumeFactor * WEIGHT_VOLUME * 5 +
        recencyFactor * WEIGHT_RECENCY * 5;

      return {
        agent: agentPubkey,
        overall: Math.round(overall * 100) / 100,
        completionRate: Math.round(completionRate * 100) / 100,
        avgRating: Math.round(avgRating * 100) / 100,
        taskVolume: totalTasks,
        recencyFactor: Math.round(recencyFactor * 100) / 100,
        dimensions: {
          quality: dimCount > 0 ? Math.round((qualitySum / weightSum) * 100) / 100 : 0,
          speed: dimCount > 0 ? Math.round((speedSum / weightSum) * 100) / 100 : 0,
          communication: dimCount > 0 ? Math.round((commSum / weightSum) * 100) / 100 : 0,
        },
        attestationCount: attestations.length,
        lastUpdated: now,
      };

      // Suppress unused variable warning
      void failed;
    },

    computeAll(): ReputationScore[] {
      // Get all unique agents from attestation records
      const attestations = store.queryByType("reputation.attestation", 1000);
      const agents = new Set<string>();
      for (const att of attestations) {
        const data = att.data as Record<string, unknown>;
        if (typeof data.target === "string") {
          agents.add(data.target);
        }
      }

      return Array.from(agents)
        .filter((a) => !localBlacklist.has(a))
        .map((a) => this.compute(a));
    },

    getBlacklist(): Set<string> {
      return new Set(localBlacklist);
    },

    blacklist(agentPubkey: string): void {
      localBlacklist.add(agentPubkey);
      console.log(`[reputation] Blacklisted ${agentPubkey.slice(0, 16)}`);
    },

    unblacklist(agentPubkey: string): void {
      localBlacklist.delete(agentPubkey);
    },

    isBlacklisted(agentPubkey: string): boolean {
      return localBlacklist.has(agentPubkey);
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyScore(agent: string): ReputationScore {
  return {
    agent,
    overall: 0,
    completionRate: 0,
    avgRating: 0,
    taskVolume: 0,
    recencyFactor: 0,
    dimensions: { quality: 0, speed: 0, communication: 0 },
    attestationCount: 0,
    lastUpdated: Math.floor(Date.now() / 1000),
  };
}
