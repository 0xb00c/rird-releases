/**
 * Reputation - Attestation Creation
 *
 * Create and sign reputation attestations after task completion.
 * Both requester and worker publish attestations for each other.
 */

import { createRecord, type ActivityRecord } from "../activity/record.js";
import type { ActivityStore } from "../activity/store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AttestationInput {
  /** Public key of the agent being reviewed */
  targetAgent: string;
  /** ID of the completed task */
  taskId: string;
  /** Overall score 1-5 */
  score: number;
  /** Dimensional scores */
  dimensions: {
    quality: number; // 1-5
    speed: number; // 1-5
    communication: number; // 1-5
  };
  /** Human-readable comment */
  comment: string;
}

export interface AttestationManager {
  create(input: AttestationInput): Promise<ActivityRecord>;
  getAttestationsFor(agentPubkey: string): ActivityRecord[];
  getAttestationsBy(agentPubkey: string): ActivityRecord[];
  getAttestationForTask(taskId: string): ActivityRecord[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export function createAttestationManager(
  store: ActivityStore,
  agentPubkey: string,
  agentPrivateKey: Uint8Array
): AttestationManager {
  return {
    async create(input: AttestationInput): Promise<ActivityRecord> {
      // Validate score ranges
      validateScore(input.score, "overall");
      validateScore(input.dimensions.quality, "quality");
      validateScore(input.dimensions.speed, "speed");
      validateScore(input.dimensions.communication, "communication");

      // Validate that we are not attesting ourselves
      if (input.targetAgent === agentPubkey) {
        throw new Error("Cannot create attestation for self");
      }

      // Validate that the task exists
      const task = store.getById(input.taskId);
      if (!task) {
        console.warn(
          `[attestation] Task ${input.taskId.slice(0, 12)}... not found in store, proceeding anyway`
        );
      }

      // Check for duplicate attestation (same agent, same task)
      const existing = store
        .queryByType("reputation.attestation", 100)
        .filter((r) => {
          const data = r.data as Record<string, unknown>;
          return (
            r.agent === agentPubkey &&
            data.target === input.targetAgent &&
            data.task_id === input.taskId
          );
        });

      if (existing.length > 0) {
        throw new Error(
          `Attestation already exists for task ${input.taskId.slice(0, 12)}...`
        );
      }

      // Create the attestation record
      const record = await createRecord(
        agentPubkey,
        agentPrivateKey,
        "reputation.attestation",
        {
          target: input.targetAgent,
          task_id: input.taskId,
          score: input.score,
          dimensions: {
            quality: input.dimensions.quality,
            speed: input.dimensions.speed,
            communication: input.dimensions.communication,
          },
          comment: input.comment,
        },
        [input.taskId]
      );

      // Store locally
      store.insert(record);

      console.log(
        `[attestation] Created attestation for ${input.targetAgent.slice(0, 16)} | ` +
          `Score: ${input.score}/5 | Task: ${input.taskId.slice(0, 12)}...`
      );

      return record;
    },

    getAttestationsFor(agentPubkey: string): ActivityRecord[] {
      return store
        .queryByType("reputation.attestation", 200)
        .filter((r) => {
          const data = r.data as Record<string, unknown>;
          return data.target === agentPubkey;
        });
    },

    getAttestationsBy(agentPubkey: string): ActivityRecord[] {
      return store.queryByTypeAndAgent(
        "reputation.attestation",
        agentPubkey,
        200
      );
    },

    getAttestationForTask(taskId: string): ActivityRecord[] {
      return store
        .queryByType("reputation.attestation", 200)
        .filter((r) => {
          const data = r.data as Record<string, unknown>;
          return data.task_id === taskId;
        });
    },
  };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateScore(score: number, name: string): void {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new Error(
      `Invalid ${name} score: ${score}. Must be integer 1-5.`
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers for summary generation
// ---------------------------------------------------------------------------

/**
 * Generate a human-readable summary of an agent's reputation.
 * Used in AP actor profiles.
 */
export function summarizeReputation(
  attestations: ActivityRecord[],
  totalTasks: number
): string {
  if (attestations.length === 0) {
    return "New agent | No reviews yet";
  }

  let totalScore = 0;
  for (const att of attestations) {
    const data = att.data as Record<string, unknown>;
    totalScore += (data.score as number) || 0;
  }

  const avgScore = totalScore / attestations.length;
  const rounded = Math.round(avgScore * 10) / 10;

  return `${totalTasks} tasks completed | ${rounded}/5 rating | ${attestations.length} reviews`;
}
