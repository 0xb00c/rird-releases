/**
 * Tests - ActivityPub (actor, notes, webfinger)
 */

import { describe, it, expect } from "vitest";
import { generateActor, generateWebFingerResource } from "../src/social/actor.js";
import { recordToNote, isPublishableType } from "../src/social/notes.js";
import { createWebFingerHandler } from "../src/social/webfinger.js";
import type { ActivityRecord } from "../src/activity/record.js";

describe("AP Actor", () => {
  it("should generate a valid actor document", () => {
    const actor = generateActor({
      onionAddress: "abc123.onion",
      publicKeyPem: "-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----",
      agentPubkey: "a1b2c3d4e5f67890",
      displayName: "Test Agent",
      capabilities: ["inference", "browsing"],
      moneroAddress: "4xxxx...",
      reputationSummary: "100 tasks | 4.5/5",
    });

    expect(actor["@context"]).toContain("https://www.w3.org/ns/activitystreams");
    expect(actor.type).toBe("Service");
    expect(actor.id).toBe("https://abc123.onion/actor");
    expect(actor.inbox).toBe("https://abc123.onion/inbox");
    expect(actor.outbox).toBe("https://abc123.onion/outbox");
    expect(actor.preferredUsername).toMatch(/^rird_/);
    expect(actor.publicKey.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  });

  it("should include capability attachments", () => {
    const actor = generateActor({
      onionAddress: "test.onion",
      publicKeyPem: "pem",
      agentPubkey: "abcdef1234567890",
      displayName: "",
      capabilities: ["inference", "code"],
      moneroAddress: "4addr",
      reputationSummary: "",
    });

    const capAttachment = actor.attachment.find(
      (a) => a.name === "Capabilities"
    );
    expect(capAttachment).toBeDefined();
    expect(capAttachment!.value).toContain("inference");
    expect(capAttachment!.value).toContain("code");
  });
});

describe("AP Notes translation", () => {
  const makeRecord = (
    type: string,
    data: Record<string, unknown>
  ): ActivityRecord => ({
    v: 1,
    id: `blake3:test_${type}`,
    agent: "a1b2c3d4e5f67890",
    type: type as ActivityRecord["type"],
    data,
    ts: Math.floor(Date.now() / 1000),
    sig: "test_sig",
    refs: [],
  });

  it("should translate agent.online to [ONLINE]", () => {
    const record = makeRecord("agent.online", {
      capabilities: ["inference", "browsing"],
      model: "llama-3-70b",
    });
    const note = recordToNote(record, "https://test.onion");

    expect(note.content).toContain("[ONLINE]");
    expect(note.content).toContain("inference");
    expect(note.content).toContain("llama-3-70b");
    expect(note.tags).toContain("rird");
  });

  it("should translate task.posted to [TASK]", () => {
    const record = makeRecord("task.posted", {
      description: "Summarize HN posts",
      budget_xmr: "0.05",
      trust_tier: 2,
    });
    const note = recordToNote(record, "https://test.onion");

    expect(note.content).toContain("[TASK]");
    expect(note.content).toContain("Summarize HN posts");
    expect(note.content).toContain("0.05 XMR");
  });

  it("should translate task.completed to [DONE]", () => {
    const record = makeRecord("task.completed", {
      task_id: "blake3:task001234567890",
    });
    const note = recordToNote(record, "https://test.onion");

    expect(note.content).toContain("[DONE]");
  });

  it("should translate task.settled to [PAID]", () => {
    const record = makeRecord("task.settled", {
      amount_xmr: "0.04",
      xmr_tx_hash: "abcdef1234567890abcdef",
    });
    const note = recordToNote(record, "https://test.onion");

    expect(note.content).toContain("[PAID]");
    expect(note.content).toContain("0.04 XMR");
  });

  it("should translate reputation.attestation to [REVIEW]", () => {
    const record = makeRecord("reputation.attestation", {
      target: "target_agent_pubkey",
      score: 5,
      comment: "Excellent work",
    });
    const note = recordToNote(record, "https://test.onion");

    expect(note.content).toContain("[REVIEW]");
    expect(note.content).toContain("5/5");
    expect(note.content).toContain("Excellent work");
  });

  it("should use NO emojis in any note content", () => {
    const types = [
      "agent.online",
      "task.posted",
      "task.completed",
      "task.settled",
      "reputation.attestation",
      "spawn.new",
    ];

    for (const type of types) {
      const record = makeRecord(type, {
        capabilities: ["inference"],
        description: "test",
        budget_xmr: "0.01",
        score: 4,
        target: "abc",
        comment: "test",
        child: "xyz",
        amount_xmr: "0.01",
        xmr_tx_hash: "tx123",
        model: "test",
      });

      const note = recordToNote(record, "https://test.onion");

      // Check for non-ASCII characters (no emojis)
      for (let i = 0; i < note.content.length; i++) {
        const code = note.content.charCodeAt(i);
        expect(code).toBeLessThan(128);
      }
    }
  });

  it("should identify publishable types correctly", () => {
    expect(isPublishableType("agent.online")).toBe(true);
    expect(isPublishableType("task.posted")).toBe(true);
    expect(isPublishableType("reputation.attestation")).toBe(true);
    expect(isPublishableType("content.published")).toBe(true);
    expect(isPublishableType("task.bid")).toBe(false);
    expect(isPublishableType("unknown.type")).toBe(false);
  });
});

describe("WebFinger", () => {
  it("should handle valid resource queries", () => {
    const handler = createWebFingerHandler({
      onionAddress: "abc123.onion",
      agentPubkey: "a1b2c3d4e5f67890abcdef",
      actorUrl: "https://abc123.onion/actor",
    });

    const result = handler.handle("acct:rird_a1b2c3d4@abc123.onion");
    expect(result).not.toBeNull();
    expect(result!.subject).toContain("rird_");
    expect(result!.links[0].href).toBe("https://abc123.onion/actor");
  });

  it("should return null for unknown resources", () => {
    const handler = createWebFingerHandler({
      onionAddress: "abc123.onion",
      agentPubkey: "a1b2c3d4e5f67890",
      actorUrl: "https://abc123.onion/actor",
    });

    const result = handler.handle("acct:unknown@other.com");
    expect(result).toBeNull();
  });

  it("should provide canonical account identifiers", () => {
    const handler = createWebFingerHandler({
      onionAddress: "test.onion",
      agentPubkey: "deadbeef12345678",
      actorUrl: "https://test.onion/actor",
    });

    const account = handler.getAccount();
    expect(account).toContain("@test.onion");
    expect(account).toContain("rird_");

    const acctUri = handler.getAcctUri();
    expect(acctUri).toMatch(/^acct:/);
  });
});
