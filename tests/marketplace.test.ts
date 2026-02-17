/**
 * Tests - Marketplace (bidder, escrow)
 */

import { describe, it, expect } from "vitest";
import { createBidder, type BidConfig } from "../src/marketplace/bidder.js";
import { createEscrowManager } from "../src/marketplace/escrow.js";
import type { TaskListing } from "../src/marketplace/board.js";

describe("Bidder", () => {
  const defaultConfig: BidConfig = {
    capabilities: ["inference", "browsing"],
    minPriceXmr: "0.001",
    maxConcurrentTasks: 3,
    reputationScore: 3.0,
    aggressiveness: 0.5,
  };

  const sampleTask: TaskListing = {
    recordId: "test_task_1",
    description: "Summarize 10 articles",
    requirements: ["inference"],
    budgetXmr: "0.05",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    trustTier: 2,
    category: "inference",
    requester: "requester_pubkey_1234",
    postedAt: Math.floor(Date.now() / 1000),
    status: "open",
  };

  it("should bid on matching tasks", () => {
    const bidder = createBidder(defaultConfig);
    const decision = bidder.evaluate(sampleTask);

    expect(decision.shouldBid).toBe(true);
    expect(parseFloat(decision.priceXmr)).toBeGreaterThan(0);
    expect(decision.confidence).toBeGreaterThan(0);
  });

  it("should reject tasks with missing capabilities", () => {
    const bidder = createBidder(defaultConfig);
    const task = { ...sampleTask, requirements: ["inference", "quantum"] };
    const decision = bidder.evaluate(task);

    expect(decision.shouldBid).toBe(false);
    expect(decision.reason).toContain("missing capabilities");
  });

  it("should reject tasks below minimum price", () => {
    const bidder = createBidder({ ...defaultConfig, minPriceXmr: "1.0" });
    const decision = bidder.evaluate(sampleTask);

    expect(decision.shouldBid).toBe(false);
    expect(decision.reason).toContain("below minimum");
  });

  it("should reject tasks with expired deadlines", () => {
    const bidder = createBidder(defaultConfig);
    const task = {
      ...sampleTask,
      deadline: Math.floor(Date.now() / 1000) - 60,
    };
    const decision = bidder.evaluate(task);

    expect(decision.shouldBid).toBe(false);
    expect(decision.reason).toContain("deadline");
  });

  it("should reject when at capacity", () => {
    const bidder = createBidder({ ...defaultConfig, maxConcurrentTasks: 0 });
    const decision = bidder.evaluate(sampleTask);

    expect(decision.shouldBid).toBe(false);
    expect(decision.reason).toContain("capacity");
  });

  it("should track negotiations", () => {
    const bidder = createBidder(defaultConfig);
    const neg = bidder.startNegotiation("task_1", "peer_1", "0.04");

    expect(neg.state).toBe("bid_sent");
    expect(neg.taskId).toBe("task_1");
    expect(neg.ourBid).toBe("0.04");
    expect(neg.rounds).toBe(1);
  });

  it("should handle counter-offers", () => {
    const bidder = createBidder(defaultConfig);
    bidder.startNegotiation("task_1", "peer_1", "0.04");

    const result = bidder.handleCounter("task_1", "0.03");
    // 0.03 is above min (0.001), so should accept
    expect(result.action).toBe("accept");
  });
});

describe("Escrow", () => {
  const escrowManager = createEscrowManager({
    remoteNode: "localhost:18089",
    testnet: true,
    protocolFeeBps: 0,
  });

  it("should create an escrow", async () => {
    const escrow = await escrowManager.create({
      taskId: "task_1",
      requester: "requester_key",
      worker: "worker_key",
      amountXmr: "0.05",
      trustTier: 2,
      executionTimeoutSec: 3600,
      verificationTimeoutSec: 3600,
    });

    expect(escrow.id).toBeTruthy();
    expect(escrow.state).toBe("pending");
    expect(escrow.amountXmr).toBe("0.05");
    expect(escrow.trustTier).toBe(2);
    expect(escrow.protocolFeeBps).toBe(0);
  });

  it("should fund an escrow", async () => {
    const escrow = await escrowManager.create({
      taskId: "task_2",
      requester: "req",
      worker: "wkr",
      amountXmr: "0.1",
      trustTier: 2,
      executionTimeoutSec: 3600,
      verificationTimeoutSec: 3600,
    });

    const funded = await escrowManager.fund(escrow.id, "tx_hash_123");
    expect(funded.state).toBe("funded");
    expect(funded.txHash).toBe("tx_hash_123");
  });

  it("should not fund an already funded escrow", async () => {
    const escrow = await escrowManager.create({
      taskId: "task_3",
      requester: "req",
      worker: "wkr",
      amountXmr: "0.1",
      trustTier: 2,
      executionTimeoutSec: 3600,
      verificationTimeoutSec: 3600,
    });

    await escrowManager.fund(escrow.id, "tx_1");
    await expect(
      escrowManager.fund(escrow.id, "tx_2")
    ).rejects.toThrow("Cannot fund escrow in state");
  });

  it("should create tier 1 escrow with no lock", async () => {
    const escrow = await escrowManager.create({
      taskId: "task_4",
      requester: "req",
      worker: "wkr",
      amountXmr: "0.005",
      trustTier: 1,
      executionTimeoutSec: 3600,
      verificationTimeoutSec: 3600,
    });

    const now = Math.floor(Date.now() / 1000);
    // Tier 1: lockUntil should be approximately now (0 lock duration)
    expect(escrow.lockUntil).toBeLessThanOrEqual(now + 1);
  });

  it("should handle disputes", async () => {
    const escrow = await escrowManager.create({
      taskId: "task_5",
      requester: "req",
      worker: "wkr",
      amountXmr: "0.5",
      trustTier: 3,
      executionTimeoutSec: 3600,
      verificationTimeoutSec: 3600,
      verifiers: ["v1", "v2", "v3"],
    });

    const disputed = await escrowManager.dispute(escrow.id, "result is wrong");
    expect(disputed.state).toBe("disputed");
  });
});
