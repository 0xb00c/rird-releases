/**
 * Tests - Identity (Ed25519 keypair + wallet)
 */

import { describe, it, expect } from "vitest";
import {
  generateKeypair,
  sign,
  verify,
  agentAddress,
  publicKeyHex,
} from "../src/identity/keys.js";
import { formatXmr, parseXmr } from "../src/identity/wallet.js";

describe("Ed25519 keypair", () => {
  it("should generate a valid keypair", async () => {
    const keypair = await generateKeypair();
    expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
    expect(keypair.privateKey).toBeInstanceOf(Uint8Array);
    expect(keypair.publicKey.length).toBe(32);
    expect(keypair.privateKey.length).toBe(32);
    expect(keypair.createdAt).toBeGreaterThan(0);
  });

  it("should generate unique keypairs", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    expect(publicKeyHex(a.publicKey)).not.toBe(publicKeyHex(b.publicKey));
  });

  it("should sign and verify messages", async () => {
    const keypair = await generateKeypair();
    const message = new TextEncoder().encode("hello rird protocol");
    const signature = await sign(message, keypair.privateKey);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(64);

    const valid = await verify(signature, message, keypair.publicKey);
    expect(valid).toBe(true);
  });

  it("should reject invalid signatures", async () => {
    const keypair = await generateKeypair();
    const message = new TextEncoder().encode("original message");
    const signature = await sign(message, keypair.privateKey);

    const tampered = new TextEncoder().encode("tampered message");
    const valid = await verify(signature, tampered, keypair.publicKey);
    expect(valid).toBe(false);
  });

  it("should reject signatures from wrong key", async () => {
    const a = await generateKeypair();
    const b = await generateKeypair();
    const message = new TextEncoder().encode("test");
    const signature = await sign(message, a.privateKey);

    const valid = await verify(signature, message, b.publicKey);
    expect(valid).toBe(false);
  });

  it("should format agent address correctly", async () => {
    const keypair = await generateKeypair();
    const addr = agentAddress(keypair.publicKey);
    expect(addr).toMatch(/^rird:[a-f0-9]{16}$/);
  });
});

describe("Monero wallet formatting", () => {
  it("should format piconeros to XMR", () => {
    expect(formatXmr(1_000_000_000_000n)).toBe("1.000000");
    expect(formatXmr(500_000_000_000n)).toBe("0.500000");
    expect(formatXmr(0n)).toBe("0.000000");
    expect(formatXmr(123_456_789_012n)).toBe("0.123456");
  });

  it("should parse XMR strings to piconeros", () => {
    expect(parseXmr("1.0")).toBe(1_000_000_000_000n);
    expect(parseXmr("0.5")).toBe(500_000_000_000n);
    expect(parseXmr("0")).toBe(0n);
    expect(parseXmr("0.000001")).toBe(1_000_000n);
  });

  it("should roundtrip format/parse", () => {
    const amount = 2_345_678_901_234n;
    const formatted = formatXmr(amount);
    const parsed = parseXmr(formatted);
    // Should be close (we truncate to 6 decimal places)
    expect(parsed).toBeLessThanOrEqual(amount);
  });
});
