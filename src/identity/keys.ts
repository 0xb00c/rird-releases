/**
 * Identity - Ed25519 Keypair Management
 *
 * Generates, loads, and manages Ed25519 keypairs using @noble/ed25519.
 * Keys are stored at ~/.rird/identity/keypair.json.
 */

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// Configure ed25519 to use sha512
ed.etc.sha512Sync = (...m: Uint8Array[]) => {
  const h = sha512.create();
  for (const msg of m) h.update(msg);
  return h.digest();
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Keypair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
  createdAt: number;
}

interface SerializedKeypair {
  publicKey: string; // hex
  privateKey: string; // hex
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_KEYPAIR_PATH = join(homedir(), ".rird", "identity", "keypair.json");

// ---------------------------------------------------------------------------
// Key generation
// ---------------------------------------------------------------------------

export async function generateKeypair(): Promise<Keypair> {
  const privateKey = randomBytes(32);
  const publicKey = await ed.getPublicKeyAsync(privateKey);

  return {
    publicKey,
    privateKey: new Uint8Array(privateKey),
    createdAt: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Key persistence
// ---------------------------------------------------------------------------

export async function saveKeypair(
  keypair: Keypair,
  path: string = DEFAULT_KEYPAIR_PATH
): Promise<void> {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true });

  const serialized: SerializedKeypair = {
    publicKey: Buffer.from(keypair.publicKey).toString("hex"),
    privateKey: Buffer.from(keypair.privateKey).toString("hex"),
    createdAt: keypair.createdAt,
  };

  // Write with restrictive permissions
  await writeFile(path, JSON.stringify(serialized, null, 2), {
    mode: 0o600,
  });
}

export async function loadKeypair(
  path: string = DEFAULT_KEYPAIR_PATH
): Promise<Keypair | null> {
  if (!existsSync(path)) {
    return null;
  }

  const raw = await readFile(path, "utf-8");
  const serialized: SerializedKeypair = JSON.parse(raw);

  return {
    publicKey: hexToBytes(serialized.publicKey),
    privateKey: hexToBytes(serialized.privateKey),
    createdAt: serialized.createdAt,
  };
}

export async function loadOrGenerateKeypair(
  path: string = DEFAULT_KEYPAIR_PATH
): Promise<Keypair> {
  const existing = await loadKeypair(path);
  if (existing) {
    return existing;
  }

  console.log("[identity] Generating new Ed25519 keypair...");
  const keypair = await generateKeypair();
  await saveKeypair(keypair, path);

  const pubHex = Buffer.from(keypair.publicKey).toString("hex");
  console.log(`[identity] New keypair generated. Public key: ${pubHex.slice(0, 32)}...`);

  return keypair;
}

// ---------------------------------------------------------------------------
// Signing and verification
// ---------------------------------------------------------------------------

export async function sign(
  message: Uint8Array,
  privateKey: Uint8Array
): Promise<Uint8Array> {
  return ed.signAsync(message, privateKey);
}

export async function verify(
  signature: Uint8Array,
  message: Uint8Array,
  publicKey: Uint8Array
): Promise<boolean> {
  try {
    return await ed.verifyAsync(signature, message, publicKey);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Get the short agent address: rird:<first-16-hex-chars>
 */
export function agentAddress(publicKey: Uint8Array): string {
  const hex = Buffer.from(publicKey).toString("hex");
  return `rird:${hex.slice(0, 16)}`;
}

/**
 * Get full hex-encoded public key
 */
export function publicKeyHex(publicKey: Uint8Array): string {
  return Buffer.from(publicKey).toString("hex");
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

export { hexToBytes };
