/**
 * Tests - End-to-End (full task lifecycle simulation)
 */

import { describe, it, expect } from "vitest";
import { generateKeypair, publicKeyHex } from "../src/identity/keys.js";
import { createRecord, verifyRecord } from "../src/activity/record.js";
import { createBidder } from "../src/marketplace/bidder.js";
import { createEscrowManager } from "../src/marketplace/escrow.js";
import { recordToNote } from "../src/social/notes.js";
import { createNullAgent } from "../src/agent/interface.js";
import { processKillRecord, resetKillState } from "../src/killswitch/kill.js";

describe("Full task lifecycle", () => {
  it("should simulate a complete Tier 2 task flow", async () => {
    // Setup: two agents
    const requester = await generateKeypair();
    const worker = await generateKeypair();
    const requesterPub = publicKeyHex(requester.publicKey);
    const workerPub = publicKeyHex(worker.publicKey);

    // Step 1: Requester posts task
    const taskRecord = await createRecord(
      requesterPub,
      requester.privateKey,
      "task.posted",
      {
        description: "Summarize top 10 HN posts",
        requirements: ["browsing", "inference"],
        budget_xmr: "0.05",
        deadline: Math.floor(Date.now() / 1000) + 3600,
        trust_tier: 2,
        category: "browsing",
      }
    );
    expect(await verifyRecord(taskRecord)).toBe(true);

    // Step 2: Worker evaluates and bids
    const bidder = createBidder({
      capabilities: ["browsing", "inference"],
      minPriceXmr: "0.001",
      maxConcurrentTasks: 3,
      reputationScore: 3.0,
      aggressiveness: 0.5,
    });

    const decision = bidder.evaluate({
      recordId: taskRecord.id,
      description: "Summarize top 10 HN posts",
      requirements: ["browsing", "inference"],
      budgetXmr: "0.05",
      deadline: Math.floor(Date.now() / 1000) + 3600,
      trustTier: 2,
      category: "browsing",
      requester: requesterPub,
      postedAt: taskRecord.ts,
      status: "open",
    });
    expect(decision.shouldBid).toBe(true);

    // Step 3: Task assigned
    const escrowMgr = createEscrowManager({
      remoteNode: "localhost",
      testnet: true,
      protocolFeeBps: 0,
    });

    const escrow = await escrowMgr.create({
      taskId: taskRecord.id,
      requester: requesterPub,
      worker: workerPub,
      amountXmr: decision.priceXmr,
      trustTier: 2,
      executionTimeoutSec: 3600,
      verificationTimeoutSec: 3600,
    });

    const assignRecord = await createRecord(
      requesterPub,
      requester.privateKey,
      "task.assigned",
      {
        task_id: taskRecord.id,
        executor: workerPub,
        escrow_tx_hash: `tx_${escrow.id}`,
      },
      [taskRecord.id]
    );
    expect(await verifyRecord(assignRecord)).toBe(true);

    // Step 4: Worker completes
    const completeRecord = await createRecord(
      workerPub,
      worker.privateKey,
      "task.completed",
      {
        task_id: taskRecord.id,
        result_hash: "blake3:result_hash_abc",
      },
      [assignRecord.id]
    );
    expect(await verifyRecord(completeRecord)).toBe(true);

    // Step 5: Settlement
    const settleRecord = await createRecord(
      requesterPub,
      requester.privateKey,
      "task.settled",
      {
        task_id: taskRecord.id,
        xmr_tx_hash: "tx_settle_123",
        amount_xmr: decision.priceXmr,
      },
      [completeRecord.id]
    );
    expect(await verifyRecord(settleRecord)).toBe(true);

    // Step 6: AP notes generated from records
    const taskNote = recordToNote(taskRecord, "https://test.onion");
    expect(taskNote.content).toContain("[TASK]");

    const completeNote = recordToNote(completeRecord, "https://test.onion");
    expect(completeNote.content).toContain("[DONE]");

    const settleNote = recordToNote(settleRecord, "https://test.onion");
    expect(settleNote.content).toContain("[PAID]");
  });
});

describe("Null agent", () => {
  it("should satisfy the RirdAgent interface", () => {
    const agent = createNullAgent();

    expect(agent.keypair().publicKey).toBeInstanceOf(Uint8Array);
    expect(agent.wallet().address).toBe("");
    expect(agent.capabilities().skills).toEqual([]);
    expect(agent.canHandle({ id: "1", description: "", requirements: [], budget_xmr: "0", deadline: 0, trust_tier: 1, requester: "" })).toBe(false);
  });

  it("should reject all tasks", () => {
    const agent = createNullAgent();
    const decision = agent.evaluateTask({
      record_id: "test",
      spec: {
        id: "1",
        description: "test",
        requirements: ["inference"],
        budget_xmr: "1.0",
        deadline: 9999999999,
        trust_tier: 1,
        requester: "req",
      },
      posted_at: Date.now(),
      category: "inference",
    });

    expect(decision.should_bid).toBe(false);
  });

  it("should throw on execute", async () => {
    const agent = createNullAgent();
    await expect(
      agent.execute({
        id: "1",
        description: "test",
        requirements: [],
        budget_xmr: "0",
        deadline: 0,
        trust_tier: 1,
        requester: "",
      })
    ).rejects.toThrow("null agent cannot execute");
  });

  it("should return null for content generation", async () => {
    const agent = createNullAgent();
    const content = await agent.generateContent();
    expect(content).toBeNull();
  });
});

describe("Killswitch", () => {
  it("should reject kill records without root key configured", async () => {
    resetKillState();
    const result = await processKillRecord({
      type: "kill",
      reason: "test",
      sig: "fake",
      ts: Math.floor(Date.now() / 1000),
    });
    expect(result).toBe(false);
  });

  it("should reject malformed kill records", async () => {
    resetKillState();
    const result = await processKillRecord({
      type: "kill",
      reason: "",
      sig: "",
      ts: Math.floor(Date.now() / 1000),
    });
    expect(result).toBe(false);
  });
});
