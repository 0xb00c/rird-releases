/**
 * Identity - Operator Commitment Hashing
 *
 * Generates and verifies operator commitment hashes.
 * A commitment is a one-way hash of an identity string + random salt,
 * allowing operators to prove identity without revealing it publicly.
 *
 * Format: SHA-256(identity + ":" + salt) encoded as hex.
 */

import { createHash, randomBytes } from "node:crypto";
import { loadIdentitySeal, type IdentitySeal } from "./verification.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Commitment {
  /** The hex-encoded commitment hash */
  hash: string;
  /** The salt used (must be kept secret alongside the identity) */
  salt: string;
  /** Unix timestamp of creation */
  createdAt: number;
}

export interface CommitmentVerification {
  /** Whether the commitment matches */
  valid: boolean;
  /** The method used to verify */
  method: "direct" | "sealed";
  /** Error message if invalid */
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMMITMENT_PREFIX = "rird-commit-v1:";
const SALT_LENGTH_BYTES = 32;

// ---------------------------------------------------------------------------
// Commitment generation
// ---------------------------------------------------------------------------

/**
 * Generate a new commitment from an identity string.
 * Returns the commitment hash and the salt (which must be stored securely).
 */
export function generateCommitment(identity: string): Commitment {
  if (!identity || identity.trim().length === 0) {
    throw new Error("Identity string cannot be empty");
  }

  const salt = randomBytes(SALT_LENGTH_BYTES).toString("hex");
  const hash = computeCommitmentHash(identity, salt);

  return {
    hash,
    salt,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Generate a commitment from an identity and a specific salt.
 * Used when reconstructing a commitment for verification.
 */
export function generateCommitmentWithSalt(identity: string, salt: string): Commitment {
  if (!identity || identity.trim().length === 0) {
    throw new Error("Identity string cannot be empty");
  }
  if (!salt || salt.length === 0) {
    throw new Error("Salt cannot be empty");
  }

  const hash = computeCommitmentHash(identity, salt);

  return {
    hash,
    salt,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

// ---------------------------------------------------------------------------
// Commitment verification
// ---------------------------------------------------------------------------

/**
 * Verify a commitment by recomputing the hash from identity + salt.
 */
export function verifyCommitment(
  commitmentHash: string,
  identity: string,
  salt: string
): CommitmentVerification {
  if (!commitmentHash || !identity || !salt) {
    return {
      valid: false,
      method: "direct",
      error: "Missing required parameters (hash, identity, or salt)",
    };
  }

  const expected = computeCommitmentHash(identity, salt);

  if (expected === commitmentHash) {
    return { valid: true, method: "direct" };
  }

  return {
    valid: false,
    method: "direct",
    error: "Commitment hash does not match",
  };
}

/**
 * Verify a commitment against the locally stored identity seal.
 * This checks whether the given commitment hash matches the sealed identity.
 */
export async function verifyAgainstSeal(
  commitmentHash: string
): Promise<CommitmentVerification> {
  const seal = await loadIdentitySeal();

  if (!seal) {
    return {
      valid: false,
      method: "sealed",
      error: "No identity seal found at ~/.rird/identity_seal",
    };
  }

  if (seal.commitment === commitmentHash) {
    return { valid: true, method: "sealed" };
  }

  return {
    valid: false,
    method: "sealed",
    error: "Commitment does not match sealed identity",
  };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

/**
 * Format a commitment hash with the protocol prefix.
 * Output: "rird-commit-v1:<hex-hash>"
 */
export function formatCommitment(hash: string): string {
  if (hash.startsWith(COMMITMENT_PREFIX)) {
    return hash;
  }
  return `${COMMITMENT_PREFIX}${hash}`;
}

/**
 * Parse a formatted commitment string back to just the hash.
 */
export function parseCommitment(formatted: string): string {
  if (formatted.startsWith(COMMITMENT_PREFIX)) {
    return formatted.slice(COMMITMENT_PREFIX.length);
  }
  return formatted;
}

/**
 * Check if a string looks like a valid commitment hash.
 * Must be a 64-character hex string (SHA-256 output).
 */
export function isValidCommitmentHash(hash: string): boolean {
  const raw = parseCommitment(hash);
  return /^[0-9a-f]{64}$/.test(raw);
}

/**
 * Get a shortened display version of a commitment hash.
 */
export function shortCommitment(hash: string): string {
  const raw = parseCommitment(hash);
  if (raw.length < 16) return raw;
  return `${raw.slice(0, 8)}...${raw.slice(-8)}`;
}

// ---------------------------------------------------------------------------
// Seal-based helpers
// ---------------------------------------------------------------------------

/**
 * Get the commitment from the local identity seal, if one exists.
 */
export async function getLocalCommitment(): Promise<string | null> {
  const seal = await loadIdentitySeal();
  return seal ? seal.commitment : null;
}

/**
 * Get the full identity seal.
 */
export async function getIdentitySeal(): Promise<IdentitySeal | null> {
  return loadIdentitySeal();
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

/**
 * Compute the commitment hash: SHA-256(identity + ":" + salt)
 */
function computeCommitmentHash(identity: string, salt: string): string {
  const input = `${identity}:${salt}`;
  return createHash("sha256").update(input).digest("hex");
}
