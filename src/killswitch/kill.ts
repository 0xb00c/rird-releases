/**
 * Killswitch - Kill Signal Handler
 *
 * Safety mechanism for catastrophic scenarios.
 * A kill record signed by the genesis root key triggers
 * orderly shutdown of all compliant agents.
 */

import { verify, hexToBytes } from "../identity/keys.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KillRecord {
  type: "kill";
  reason: string;
  sig: string;
  ts: number;
}

export type KillHandler = () => Promise<void>;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let rootPubkey: Uint8Array | null = null;
let killHandler: KillHandler | null = null;
let killReceived = false;

// ---------------------------------------------------------------------------
// Kill signal registration
// ---------------------------------------------------------------------------

/**
 * Register the killswitch handler with the root public key.
 * The handler will be called when a valid kill signal is received.
 */
export function handleKillSignal(
  rootPubkeyHex: string,
  handler: KillHandler
): void {
  if (!rootPubkeyHex || rootPubkeyHex.length === 0) {
    console.warn("[killswitch] No root pubkey configured -- killswitch disabled");
    return;
  }

  rootPubkey = hexToBytes(rootPubkeyHex);
  killHandler = handler;
  console.log(
    `[killswitch] Registered with root key: ${rootPubkeyHex.slice(0, 16)}...`
  );
}

// ---------------------------------------------------------------------------
// Kill signal processing
// ---------------------------------------------------------------------------

/**
 * Process a potential kill record received from gossip.
 * Returns true if the kill signal is valid and was acted upon.
 */
export async function processKillRecord(
  record: KillRecord
): Promise<boolean> {
  if (killReceived) {
    console.log("[killswitch] Kill already received, ignoring duplicate");
    return false;
  }

  if (!rootPubkey) {
    console.warn("[killswitch] No root pubkey set -- ignoring kill signal");
    return false;
  }

  // Verify the kill record is properly structured
  if (record.type !== "kill") {
    return false;
  }

  if (!record.reason || !record.sig) {
    console.warn("[killswitch] Malformed kill record -- missing reason or signature");
    return false;
  }

  // Check timestamp (kill signals valid for 24 hours)
  const now = Math.floor(Date.now() / 1000);
  const age = Math.abs(now - record.ts);
  if (age > 86400) {
    console.warn(
      `[killswitch] Kill record too old (${age}s) -- ignoring`
    );
    return false;
  }

  // Verify signature against root key
  const message = buildKillMessage(record);
  const messageBytes = new TextEncoder().encode(message);
  const sigBytes = hexToBytes(record.sig);

  const valid = await verify(sigBytes, messageBytes, rootPubkey);

  if (!valid) {
    console.warn("[killswitch] Invalid signature on kill record -- ignoring");
    return false;
  }

  // Valid kill signal received
  killReceived = true;
  console.log("===========================================");
  console.log("[KILLSWITCH] VALID KILL SIGNAL RECEIVED");
  console.log(`[KILLSWITCH] Reason: ${record.reason}`);
  console.log("===========================================");

  // Execute the kill handler
  if (killHandler) {
    try {
      await killHandler();
    } catch (err) {
      console.error(`[killswitch] Handler error: ${err}`);
      // Force exit even if handler fails
      process.exit(1);
    }
  } else {
    console.log("[killswitch] No handler registered -- exiting immediately");
    process.exit(1);
  }

  return true;
}

/**
 * Create a kill record for signing by the root key holder.
 * This is used by the root key holder to create kill signals.
 */
export function createKillMessage(reason: string): string {
  const record: Omit<KillRecord, "sig"> = {
    type: "kill",
    reason,
    ts: Math.floor(Date.now() / 1000),
  };
  return buildKillMessage(record as KillRecord);
}

/**
 * Check if a killswitch signal has been received.
 */
export function isKillReceived(): boolean {
  return killReceived;
}

/**
 * Reset killswitch state (for testing only).
 */
export function resetKillState(): void {
  killReceived = false;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildKillMessage(record: KillRecord | Omit<KillRecord, "sig">): string {
  // Deterministic message format for signature verification
  return JSON.stringify({
    type: "kill",
    reason: record.reason,
    ts: record.ts,
  });
}
