/**
 * Tests - Gossip and Activity Records
 */

import { describe, it, expect } from "vitest";
import {
  createRecord,
  verifyRecord,
  serializeRecord,
  deserializeRecord,
  isPublicType,
} from "../src/activity/record.js";
import { generateKeypair, publicKeyHex } from "../src/identity/keys.js";

describe("Activity records", () => {
  it("should create a valid record", async () => {
    const keypair = await generateKeypair();
    const pubkey = publicKeyHex(keypair.publicKey);

    const record = await createRecord(pubkey, keypair.privateKey, "agent.online", {
      capabilities: ["inference", "browsing"],
      model: "llama-3-70b",
    });

    expect(record.v).toBe(1);
    expect(record.id).toMatch(/^blake3:/);
    expect(record.agent).toBe(pubkey);
    expect(record.type).toBe("agent.online");
    expect(record.sig).toBeTruthy();
    expect(record.ts).toBeGreaterThan(0);
    expect(record.refs).toEqual([]);
  });

  it("should verify a valid record", async () => {
    const keypair = await generateKeypair();
    const pubkey = publicKeyHex(keypair.publicKey);

    const record = await createRecord(pubkey, keypair.privateKey, "task.posted", {
      description: "Test task",
      requirements: ["inference"],
      budget_xmr: "0.05",
    });

    const valid = await verifyRecord(record);
    expect(valid).toBe(true);
  });

  it("should reject a record with tampered data", async () => {
    const keypair = await generateKeypair();
    const pubkey = publicKeyHex(keypair.publicKey);

    const record = await createRecord(pubkey, keypair.privateKey, "task.posted", {
      description: "Original",
    });

    // Tamper with the data
    record.data = { description: "Tampered" };

    const valid = await verifyRecord(record);
    expect(valid).toBe(false);
  });

  it("should reject a record with wrong agent key", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const pubkeyA = publicKeyHex(a.publicKey);

    const record = await createRecord(pubkeyA, a.privateKey, "agent.online", {});

    // Change the agent to B (but signature is from A)
    record.agent = publicKeyHex(b.publicKey);

    const valid = await verifyRecord(record);
    expect(valid).toBe(false);
  });

  it("should serialize and deserialize records", async () => {
    const keypair = await generateKeypair();
    const pubkey = publicKeyHex(keypair.publicKey);

    const original = await createRecord(pubkey, keypair.privateKey, "task.settled", {
      task_id: "test_123",
      xmr_tx_hash: "abc",
      amount_xmr: "0.05",
    });

    const bytes = serializeRecord(original);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);

    const restored = deserializeRecord(bytes);
    expect(restored.id).toBe(original.id);
    expect(restored.type).toBe(original.type);
    expect(restored.agent).toBe(original.agent);
    expect(restored.sig).toBe(original.sig);
  });

  it("should correctly identify public types", () => {
    expect(isPublicType("agent.online")).toBe(true);
    expect(isPublicType("task.posted")).toBe(true);
    expect(isPublicType("task.settled")).toBe(true);
    expect(isPublicType("reputation.attestation")).toBe(true);
    expect(isPublicType("spawn.new")).toBe(true);

    expect(isPublicType("task.bid")).toBe(false);
    expect(isPublicType("task.counter")).toBe(false);
    expect(isPublicType("task.deliver")).toBe(false);
    expect(isPublicType("escrow.coordinate")).toBe(false);
  });

  it("should include refs in record", async () => {
    const keypair = await generateKeypair();
    const pubkey = publicKeyHex(keypair.publicKey);

    const parent = await createRecord(pubkey, keypair.privateKey, "task.posted", {
      description: "Parent task",
    });

    const child = await createRecord(
      pubkey,
      keypair.privateKey,
      "task.assigned",
      { executor: "abc123" },
      [parent.id]
    );

    expect(child.refs).toContain(parent.id);
  });
});
