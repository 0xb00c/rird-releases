/**
 * Tests - Reputation (scoring, attestations, challenges)
 */

import { describe, it, expect } from "vitest";
import { createChallengeManager } from "../src/reputation/challenge.js";
import { createStrategy, type EconomicState, type TaskOpportunity } from "../src/autonomous/strategy.js";

describe("Proof-of-Compute Challenge", () => {
  it("should issue challenges matching capabilities", () => {
    const mgr = createChallengeManager();
    const challenge = mgr.issueChallenge(["inference"], "issuer_key");

    expect(challenge.id).toMatch(/^challenge_/);
    expect(challenge.type).toBe("inference");
    expect(challenge.payload).toBeDefined();
    expect(challenge.timeoutMs).toBeGreaterThan(0);
    expect(challenge.issuedBy).toBe("issuer_key");
  });

  it("should fall back to hash_computation for unknown capabilities", () => {
    const mgr = createChallengeManager();
    const challenge = mgr.issueChallenge(["quantum_computing"], "issuer_key");

    expect(challenge.type).toBe("hash_computation");
  });

  it("should verify responses within timeout", () => {
    const mgr = createChallengeManager();
    const challenge = mgr.issueChallenge(["code"], "issuer_key");

    // Valid response (within timeout)
    const result = mgr.verifyResponse(challenge, "result_hash_123", 5000);
    expect(result.passed).toBe(true);
    expect(result.challengeId).toBe(challenge.id);
  });

  it("should reject responses exceeding timeout", () => {
    const mgr = createChallengeManager();
    const challenge = mgr.issueChallenge(["inference"], "issuer_key");

    // Response exceeding timeout
    const result = mgr.verifyResponse(
      challenge,
      "result_hash",
      challenge.timeoutMs + 1000
    );
    expect(result.passed).toBe(false);
  });

  it("should generate different challenges each time", () => {
    const mgr = createChallengeManager();
    const a = mgr.issueChallenge(["hash_computation"], "key");
    const b = mgr.issueChallenge(["hash_computation"], "key");

    expect(a.id).not.toBe(b.id);
  });
});

describe("Economic Strategy", () => {
  const baseState: EconomicState = {
    balanceXmr: 1.0,
    dailyEarnings: 0.5,
    dailyCosts: 0.2,
    reputation: 3.0,
    utilization: 0.5,
    activeTasks: 1,
    maxTasks: 3,
    followerCount: 100,
    taskSuccessRate: 0.9,
    avgTaskDurationSec: 300,
  };

  const sampleTask: TaskOpportunity = {
    taskId: "task_1",
    budgetXmr: 0.05,
    requirements: ["inference"],
    trustTier: 2,
    requesterReputation: 4.0,
    deadline: Math.floor(Date.now() / 1000) + 3600,
    competitorCount: 2,
  };

  it("should bid on profitable tasks", () => {
    const strategy = createStrategy();
    const decision = strategy.evaluate(baseState, [sampleTask]);

    expect(decision.action).toBe("bid");
    if (decision.action === "bid") {
      expect(parseFloat(decision.priceXmr)).toBeGreaterThan(0);
    }
  });

  it("should idle when at capacity", () => {
    const strategy = createStrategy();
    const fullState = { ...baseState, activeTasks: 3 };
    const decision = strategy.evaluate(fullState, [sampleTask]);

    expect(decision.action).toBe("idle");
  });

  it("should suggest content creation when idle", () => {
    const strategy = createStrategy();
    const idleState = {
      ...baseState,
      utilization: 0.1,
      activeTasks: 0,
    };
    const decision = strategy.evaluate(idleState, []);

    expect(decision.action).toBe("create_content");
  });

  it("should calculate optimal prices", () => {
    const strategy = createStrategy();

    const price = strategy.calculateOptimalPrice(sampleTask, baseState);
    expect(price).toBeGreaterThan(0);
    expect(price).toBeLessThanOrEqual(sampleTask.budgetXmr);
  });

  it("should recommend spawning at high utilization with positive ROI", () => {
    const strategy = createStrategy();
    const highUtilState = {
      ...baseState,
      utilization: 0.95,
      dailyEarnings: 1.0,
      dailyCosts: 0.2,
      balanceXmr: 5.0,
      reputation: 4.0,
    };

    expect(strategy.shouldSpawn(highUtilState)).toBe(true);
  });

  it("should not spawn with negative ROI", () => {
    const strategy = createStrategy();
    const negativeState = {
      ...baseState,
      utilization: 0.95,
      dailyEarnings: 0.1,
      dailyCosts: 0.5,
    };

    expect(strategy.shouldSpawn(negativeState)).toBe(false);
  });

  it("should generate strategy reports", () => {
    const strategy = createStrategy();
    const report = strategy.getStrategyReport(baseState);

    expect(report.roi).toBeGreaterThan(0);
    expect(report.profitMargin).toBeGreaterThan(0);
    expect(report.recommendation).toBeTruthy();
  });
});
