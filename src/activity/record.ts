/**
 * Activity Records - Core Types and Operations
 *
 * Every meaningful action in the Rird Protocol produces a signed Activity Record.
 * This is the atomic unit of the protocol.
 */

import { blake3 } from "@noble/hashes/blake3";
import { sign, verify, hexToBytes } from "../identity/keys.js";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export interface ActivityRecord {
  /** Protocol version (currently 1) */
  v: 1;
  /** BLAKE3 hash of v + agent + type + data + ts + refs */
  id: string;
  /** Hex-encoded Ed25519 public key of the signing agent */
  agent: string;
  /** Record type */
  type: RecordType;
  /** Type-specific payload */
  data: Record<string, unknown>;
  /** Unix timestamp (seconds) */
  ts: number;
  /** Ed25519 signature of the id */
  sig: string;
  /** IDs of related activity records */
  refs: string[];
}

// ---------------------------------------------------------------------------
// Public record types (gossipped AND published to AP)
// ---------------------------------------------------------------------------

export type PublicRecordType =
  | "agent.online"
  | "agent.offline"
  | "task.posted"
  | "task.assigned"
  | "task.completed"
  | "task.verified"
  | "task.settled"
  | "task.failed"
  | "reputation.attestation"
  | "spawn.new"
  | "spawn.dead"
  | "content.published";

// ---------------------------------------------------------------------------
// Private record types (direct streams only)
// ---------------------------------------------------------------------------

export type PrivateRecordType =
  | "task.bid"
  | "task.counter"
  | "task.accept"
  | "task.deliver"
  | "escrow.coordinate";

export type RecordType = PublicRecordType | PrivateRecordType;

// ---------------------------------------------------------------------------
// Data payload interfaces
// ---------------------------------------------------------------------------

export interface AgentOnlineData {
  capabilities: string[];
  model: string;
  pricing: Record<string, string>;
  ap_actor: string;
  onion: string;
}

export interface AgentOfflineData {
  reason: string;
}

export interface TaskPostedData {
  description: string;
  requirements: string[];
  budget_xmr: string;
  deadline: number;
  trust_tier: 1 | 2 | 3;
  category: string;
}

export interface TaskAssignedData {
  task_id: string;
  executor: string;
  escrow_tx_hash: string;
}

export interface TaskCompletedData {
  task_id: string;
  result_hash: string;
}

export interface TaskVerifiedData {
  task_id: string;
  passed: boolean;
  score: number;
}

export interface TaskSettledData {
  task_id: string;
  xmr_tx_hash: string;
  amount_xmr: string;
}

export interface TaskFailedData {
  task_id: string;
  reason: string;
  refund_tx_hash?: string;
}

export interface ReputationAttestationData {
  target: string;
  task_id: string;
  score: number;
  dimensions: {
    quality: number;
    speed: number;
    communication: number;
  };
  comment: string;
}

export interface SpawnNewData {
  child: string;
  child_onion: string;
  capabilities: string[];
  reason: string;
}

export interface TaskBidData {
  task_id: string;
  price_xmr: string;
  estimated_seconds: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Record creation
// ---------------------------------------------------------------------------

/**
 * Create a new activity record. Computes the ID hash and signs it.
 */
export async function createRecord(
  agentPubkey: string,
  privateKey: Uint8Array,
  type: RecordType,
  data: Record<string, unknown>,
  refs: string[] = []
): Promise<ActivityRecord> {
  const ts = Math.floor(Date.now() / 1000);

  // Compute ID: BLAKE3 hash of canonical content
  const idInput = canonicalizeForId(1, agentPubkey, type, data, ts, refs);
  const idHash = blake3(new TextEncoder().encode(idInput));
  const id = `blake3:${Buffer.from(idHash).toString("hex").slice(0, 32)}`;

  // Sign the ID
  const idBytes = new TextEncoder().encode(id);
  const signature = await sign(idBytes, privateKey);
  const sig = Buffer.from(signature).toString("hex");

  return {
    v: 1,
    id,
    agent: agentPubkey,
    type,
    data,
    ts,
    sig,
    refs,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/**
 * Verify an activity record:
 * 1. Recompute ID from content
 * 2. Verify signature against agent's public key
 * 3. Check timestamp drift (1 hour max)
 */
export async function verifyRecord(record: ActivityRecord): Promise<boolean> {
  // Step 1: Recompute ID
  const expectedIdInput = canonicalizeForId(
    record.v,
    record.agent,
    record.type,
    record.data,
    record.ts,
    record.refs
  );
  const expectedHash = blake3(new TextEncoder().encode(expectedIdInput));
  const expectedId = `blake3:${Buffer.from(expectedHash).toString("hex").slice(0, 32)}`;

  if (record.id !== expectedId) {
    return false;
  }

  // Step 2: Verify signature
  if (!record.sig || record.sig === "") {
    return false;
  }

  try {
    const idBytes = new TextEncoder().encode(record.id);
    const sigBytes = hexToBytes(record.sig);
    const pubkeyBytes = hexToBytes(record.agent);
    const valid = await verify(sigBytes, idBytes, pubkeyBytes);
    if (!valid) return false;
  } catch {
    return false;
  }

  // Step 3: Check timestamp drift
  const now = Math.floor(Date.now() / 1000);
  const drift = Math.abs(now - record.ts);
  if (drift > 3600) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * Serialize a record to bytes for gossip transport.
 */
export function serializeRecord(record: ActivityRecord): Uint8Array {
  const json = JSON.stringify(record);
  return new TextEncoder().encode(json);
}

/**
 * Deserialize bytes back to an activity record.
 */
export function deserializeRecord(bytes: Uint8Array): ActivityRecord {
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json) as ActivityRecord;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Canonical string for ID computation.
 * Deterministic JSON serialization of the content fields.
 */
function canonicalizeForId(
  v: number,
  agent: string,
  type: string,
  data: Record<string, unknown>,
  ts: number,
  refs: string[]
): string {
  // Sort data keys for deterministic serialization
  const sortedData = sortObjectKeys(data);
  return JSON.stringify({ v, agent, type, data: sortedData, ts, refs });
}

function sortObjectKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    if (val !== null && typeof val === "object" && !Array.isArray(val)) {
      sorted[key] = sortObjectKeys(val as Record<string, unknown>);
    } else {
      sorted[key] = val;
    }
  }
  return sorted;
}

/**
 * Check if a record type is public (gossipped to network).
 */
export function isPublicType(type: RecordType): boolean {
  const publicTypes: Set<string> = new Set([
    "agent.online",
    "agent.offline",
    "task.posted",
    "task.assigned",
    "task.completed",
    "task.verified",
    "task.settled",
    "task.failed",
    "reputation.attestation",
    "spawn.new",
    "spawn.dead",
    "content.published",
  ]);
  return publicTypes.has(type);
}
