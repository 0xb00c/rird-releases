/**
 * Governance - Action Gossip Propagation
 *
 * Creates governance activity records with multi-sig authorization,
 * broadcasts them to the network, and receives/verifies incoming
 * governance records from peers.
 */

import { createRecord, verifyRecord, type ActivityRecord } from "../activity/record.js";
import { sign } from "../identity/keys.js";
import type { KeyholderRegistry, MultiSigPayload } from "./keyholders.js";
import {
  GovernanceActionProcessor,
  type GovernanceAction,
  type GovernanceActionType,
} from "./actions.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GovernanceBroadcaster {
  /** Broadcast a governance record to all connected peers */
  broadcast(record: ActivityRecord): Promise<void>;
}

export interface PropagationResult {
  created: boolean;
  broadcast: boolean;
  recordId: string;
  error?: string;
}

export interface ReceivedGovernanceResult {
  accepted: boolean;
  applied: boolean;
  recordId: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// GovernancePropagation
// ---------------------------------------------------------------------------

export class GovernancePropagation {
  private registry: KeyholderRegistry;
  private processor: GovernanceActionProcessor;
  private broadcaster: GovernanceBroadcaster | null;
  private processedIds = new Set<string>();

  constructor(
    registry: KeyholderRegistry,
    processor: GovernanceActionProcessor,
    broadcaster?: GovernanceBroadcaster
  ) {
    this.registry = registry;
    this.processor = processor;
    this.broadcaster = broadcaster || null;
  }

  /**
   * Create and broadcast a governance action.
   * This is called by a keyholder who is authoring the governance record.
   *
   * @param type - The governance action type
   * @param targetAgent - The agent being acted upon
   * @param reason - Human-readable reason
   * @param duration - Duration in seconds (suspend only, 0=indefinite)
   * @param signerPubkey - Hex pubkey of the signing keyholder
   * @param signerPrivateKey - Private key of the signing keyholder
   * @param additionalSignatures - Pre-collected signatures from other keyholders
   */
  async createAndBroadcast(
    type: GovernanceActionType,
    targetAgent: string,
    reason: string,
    duration: number,
    signerPubkey: string,
    signerPrivateKey: Uint8Array,
    additionalSignatures: Record<string, string> = {}
  ): Promise<PropagationResult> {
    // Step 1: Build the canonical action string
    const actionData = this.buildActionData(type, targetAgent, reason, duration);
    const actionString = JSON.stringify(actionData);

    // Step 2: Sign the action
    const actionBytes = new TextEncoder().encode(actionString);
    const signature = await sign(actionBytes, signerPrivateKey);
    const sigHex = Buffer.from(signature).toString("hex");

    // Step 3: Combine signatures
    const allSignatures: Record<string, string> = {
      ...additionalSignatures,
      [signerPubkey]: sigHex,
    };

    const multiSig: MultiSigPayload = {
      action: actionString,
      signatures: allSignatures,
    };

    // Step 4: Verify we have enough signatures
    const sigResult = await this.registry.verifyMultiSig(multiSig);
    if (!sigResult.valid) {
      return {
        created: false,
        broadcast: false,
        recordId: "",
        error:
          `Insufficient signatures: ${sigResult.validSignatures}/${sigResult.requiredSignatures}. ` +
          `Collect more keyholder signatures before broadcasting.`,
      };
    }

    // Step 5: Create the activity record
    const recordData: Record<string, unknown> = {
      target_agent: targetAgent,
      reason,
      duration,
      authorization: multiSig,
    };

    // Use the type as-is for the record type (governance.warn, etc.)
    const record = await createRecord(
      signerPubkey,
      signerPrivateKey,
      type as Parameters<typeof createRecord>[2],
      recordData
    );

    // Step 6: Broadcast to network
    let broadcastSuccess = false;
    if (this.broadcaster) {
      try {
        await this.broadcaster.broadcast(record);
        broadcastSuccess = true;
        console.log(
          `[governance/propagation] Broadcast ${type} for ${targetAgent.slice(0, 16)}...`
        );
      } catch (err) {
        console.error(`[governance/propagation] Broadcast failed: ${err}`);
      }
    }

    // Step 7: Apply locally
    this.processedIds.add(record.id);
    const action: GovernanceAction = {
      type,
      targetAgent,
      reason,
      issuedAt: record.ts,
      duration,
      authorization: multiSig,
    };
    await this.processor.processAction(action);

    return {
      created: true,
      broadcast: broadcastSuccess,
      recordId: record.id,
    };
  }

  /**
   * Receive and process a governance record from the network.
   * Verifies the record signature, the multi-sig authorization,
   * and applies the governance decision locally.
   */
  async receiveGovernanceRecord(
    record: ActivityRecord
  ): Promise<ReceivedGovernanceResult> {
    // Step 1: Deduplication
    if (this.processedIds.has(record.id)) {
      return {
        accepted: false,
        applied: false,
        recordId: record.id,
        error: "Duplicate governance record",
      };
    }

    // Step 2: Verify record signature
    const recordValid = await verifyRecord(record);
    if (!recordValid) {
      return {
        accepted: false,
        applied: false,
        recordId: record.id,
        error: "Invalid record signature",
      };
    }

    // Step 3: Parse the governance action
    const action = this.processor.parseGovernanceRecord(record);
    if (!action) {
      return {
        accepted: false,
        applied: false,
        recordId: record.id,
        error: "Failed to parse governance action from record",
      };
    }

    // Step 4: Verify the multi-sig authorization
    const sigResult = await this.registry.verifyMultiSig(action.authorization);
    if (!sigResult.valid) {
      return {
        accepted: false,
        applied: false,
        recordId: record.id,
        error: `Multi-sig verification failed: ${sigResult.error}`,
      };
    }

    // Step 5: Apply the governance action locally
    this.processedIds.add(record.id);
    const result = await this.processor.processAction(action);

    return {
      accepted: true,
      applied: result.applied,
      recordId: record.id,
      error: result.applied ? undefined : result.error,
    };
  }

  /**
   * Collect a signature from a keyholder for a pending governance action.
   * Returns the canonical action string for signing.
   */
  buildActionString(
    type: GovernanceActionType,
    targetAgent: string,
    reason: string,
    duration: number
  ): string {
    const actionData = this.buildActionData(type, targetAgent, reason, duration);
    return JSON.stringify(actionData);
  }

  /**
   * Get the set of processed governance record IDs.
   */
  getProcessedCount(): number {
    return this.processedIds.size;
  }

  /**
   * Set the broadcaster (can be set after construction).
   */
  setBroadcaster(broadcaster: GovernanceBroadcaster): void {
    this.broadcaster = broadcaster;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private buildActionData(
    type: GovernanceActionType,
    targetAgent: string,
    reason: string,
    duration: number
  ): Record<string, unknown> {
    return {
      type,
      target_agent: targetAgent,
      reason,
      duration,
      ts: Math.floor(Date.now() / 1000),
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a GovernancePropagation instance.
 */
export function createGovernancePropagation(
  registry: KeyholderRegistry,
  processor: GovernanceActionProcessor,
  broadcaster?: GovernanceBroadcaster
): GovernancePropagation {
  return new GovernancePropagation(registry, processor, broadcaster);
}
