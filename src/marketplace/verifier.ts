/**
 * Marketplace - Task Verification
 *
 * Implements spot-check verification and multi-peer verification
 * for completed tasks, per the trust tier requirements.
 */

import type { RirdAgent, TaskSpec, TaskResult, VerifyResult } from "../agent/interface.js";
import type { ActivityStore } from "../activity/store.js";
import { createRecord } from "../activity/record.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VerificationRequest {
  taskId: string;
  spec: TaskSpec;
  result: TaskResult;
  trustTier: 1 | 2 | 3;
  requester: string;
  worker: string;
}

export interface VerificationOutcome {
  taskId: string;
  passed: boolean;
  score: number;
  verifiers: VerifierVote[];
  finalizedAt: number;
}

export interface VerifierVote {
  verifier: string;
  passed: boolean;
  score: number;
  reason: string;
}

export interface Verifier {
  verify(request: VerificationRequest): Promise<VerificationOutcome>;
  spotCheck(request: VerificationRequest): Promise<VerifyResult>;
}

// ---------------------------------------------------------------------------
// Verifier implementation
// ---------------------------------------------------------------------------

export function createVerifier(
  agent: RirdAgent,
  store: ActivityStore,
  agentPubkey: string,
  agentPrivateKey: Uint8Array
): Verifier {
  return {
    async verify(request: VerificationRequest): Promise<VerificationOutcome> {
      const votes: VerifierVote[] = [];

      if (request.trustTier === 1) {
        // Tier 1: No verification required -- auto-pass
        const outcome: VerificationOutcome = {
          taskId: request.taskId,
          passed: true,
          score: 1.0,
          verifiers: [],
          finalizedAt: Date.now(),
        };
        return outcome;
      }

      if (request.trustTier === 2) {
        // Tier 2: Single peer verification (this agent)
        const result = await performVerification(agent, request);
        votes.push({
          verifier: agentPubkey,
          passed: result.passed,
          score: result.score,
          reason: result.reason,
        });

        // Publish verification record
        await publishVerification(
          store,
          agentPubkey,
          agentPrivateKey,
          request.taskId,
          result
        );

        return {
          taskId: request.taskId,
          passed: result.passed,
          score: result.score,
          verifiers: votes,
          finalizedAt: Date.now(),
        };
      }

      // Tier 3: Multi-peer verification (3 peers, majority rules)
      // In a full implementation, this would coordinate with remote verifiers
      // For reference: we perform our own verification as one of the 3
      const ourResult = await performVerification(agent, request);
      votes.push({
        verifier: agentPubkey,
        passed: ourResult.passed,
        score: ourResult.score,
        reason: ourResult.reason,
      });

      // TODO: Request verification from 2 other random peers
      // For now, simulate with placeholder votes
      console.log(
        `[verifier] Tier 3: Need 2 more verifier votes for ${request.taskId.slice(0, 12)}...`
      );

      // With only our vote, we can't reach majority yet
      // In production, this would wait for remote votes
      const passedCount = votes.filter((v) => v.passed).length;
      const totalVotes = votes.length;
      const majorityNeeded = Math.ceil(3 / 2); // 2 out of 3

      const passed = passedCount >= majorityNeeded;
      const avgScore =
        votes.reduce((sum, v) => sum + v.score, 0) / totalVotes;

      await publishVerification(
        store,
        agentPubkey,
        agentPrivateKey,
        request.taskId,
        { passed, score: avgScore, reason: `${passedCount}/${totalVotes} verifiers passed` }
      );

      return {
        taskId: request.taskId,
        passed,
        score: avgScore,
        verifiers: votes,
        finalizedAt: Date.now(),
      };
    },

    async spotCheck(request: VerificationRequest): Promise<VerifyResult> {
      return performVerification(agent, request);
    },
  };
}

// ---------------------------------------------------------------------------
// Core verification logic
// ---------------------------------------------------------------------------

async function performVerification(
  agent: RirdAgent,
  request: VerificationRequest
): Promise<VerifyResult> {
  try {
    // Use the agent's verify method to check the result
    const result = agent.verify(request.spec, request.result);

    console.log(
      `[verifier] Verified ${request.taskId.slice(0, 12)}... | ` +
        `Passed: ${result.passed} | Score: ${result.score.toFixed(2)}`
    );

    return result;
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(
      `[verifier] Verification error for ${request.taskId.slice(0, 12)}...: ${errorMsg}`
    );

    return {
      passed: false,
      score: 0,
      reason: `verification error: ${errorMsg}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Record publishing
// ---------------------------------------------------------------------------

async function publishVerification(
  store: ActivityStore,
  agentPubkey: string,
  agentPrivateKey: Uint8Array,
  taskId: string,
  result: VerifyResult
): Promise<void> {
  const record = await createRecord(
    agentPubkey,
    agentPrivateKey,
    "task.verified",
    {
      task_id: taskId,
      passed: result.passed,
      score: result.score,
    },
    [taskId]
  );

  store.insert(record);
}
