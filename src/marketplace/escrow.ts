/**
 * Marketplace - Monero Escrow
 *
 * Implements time-locked Monero escrow for task payments.
 * Supports all three trust tiers:
 * - Tier 1: No escrow (reputation-only)
 * - Tier 2: Time-locked single escrow
 * - Tier 3: Multi-party extended escrow
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EscrowConfig {
  remoteNode: string;
  testnet: boolean;
  protocolFeeBps: number;
}

export type EscrowState =
  | "pending"
  | "funded"
  | "locked"
  | "claimable"
  | "claimed"
  | "refunded"
  | "disputed";

export interface Escrow {
  id: string;
  taskId: string;
  requester: string;
  worker: string;
  amountXmr: string;
  trustTier: 1 | 2 | 3;
  state: EscrowState;
  txHash: string;
  lockUntil: number; // unix timestamp
  createdAt: number;
  verifiers: string[];
  protocolFeeBps: number;
}

export interface EscrowManager {
  create(params: CreateEscrowParams): Promise<Escrow>;
  fund(escrowId: string, txHash: string): Promise<Escrow>;
  confirm(escrowId: string): Promise<boolean>;
  claim(escrowId: string, workerPrivateKey: Uint8Array): Promise<string>;
  refund(escrowId: string): Promise<string>;
  dispute(escrowId: string, reason: string): Promise<Escrow>;
  getEscrow(escrowId: string): Escrow | null;
  getEscrowsByTask(taskId: string): Escrow[];
}

export interface CreateEscrowParams {
  taskId: string;
  requester: string;
  worker: string;
  amountXmr: string;
  trustTier: 1 | 2 | 3;
  executionTimeoutSec: number;
  verificationTimeoutSec: number;
  verifiers?: string[];
}

// ---------------------------------------------------------------------------
// Escrow manager implementation
// ---------------------------------------------------------------------------

export function createEscrowManager(
  config: EscrowConfig
): EscrowManager {
  const escrows = new Map<string, Escrow>();
  let nextId = 1;

  return {
    async create(params: CreateEscrowParams): Promise<Escrow> {
      const escrowId = `escrow_${nextId++}_${Date.now()}`;

      // Calculate lock period based on trust tier
      let lockDuration: number;
      if (params.trustTier === 1) {
        lockDuration = 0; // No lock for tier 1
      } else if (params.trustTier === 2) {
        lockDuration =
          params.executionTimeoutSec + params.verificationTimeoutSec;
      } else {
        // Tier 3: 3x execution timeout
        lockDuration = params.executionTimeoutSec * 3;
      }

      const now = Math.floor(Date.now() / 1000);
      const escrow: Escrow = {
        id: escrowId,
        taskId: params.taskId,
        requester: params.requester,
        worker: params.worker,
        amountXmr: params.amountXmr,
        trustTier: params.trustTier,
        state: "pending",
        txHash: "",
        lockUntil: now + lockDuration,
        createdAt: now,
        verifiers: params.verifiers || [],
        protocolFeeBps: config.protocolFeeBps,
      };

      // For Tier 3, select random verifiers if not provided
      if (params.trustTier === 3 && escrow.verifiers.length === 0) {
        // TODO: Select 3 random peers from known peers list
        console.log("[escrow] TODO: Select random verifiers for Tier 3 escrow");
      }

      escrows.set(escrowId, escrow);

      console.log(
        `[escrow] Created ${escrowId} | Tier ${params.trustTier} | ` +
          `${params.amountXmr} XMR | Lock until ${new Date(escrow.lockUntil * 1000).toISOString()}`
      );

      return escrow;
    },

    async fund(escrowId: string, txHash: string): Promise<Escrow> {
      const escrow = escrows.get(escrowId);
      if (!escrow) throw new Error(`Escrow not found: ${escrowId}`);
      if (escrow.state !== "pending") {
        throw new Error(`Cannot fund escrow in state: ${escrow.state}`);
      }

      escrow.txHash = txHash;
      escrow.state = "funded";

      // TODO: Verify the transaction on the Monero blockchain
      // - Check tx exists on remote node
      // - Verify amount matches
      // - Verify unlock_time matches lockUntil

      console.log(
        `[escrow] Funded ${escrowId} | TX: ${txHash.slice(0, 16)}...`
      );

      return escrow;
    },

    async confirm(escrowId: string): Promise<boolean> {
      const escrow = escrows.get(escrowId);
      if (!escrow) return false;

      // TODO: Query Monero node for transaction confirmation
      // const url = `http://${config.remoteNode}/json_rpc`;
      // const response = await fetch(url, { method: "POST", body: ... });
      // Check confirmations >= required

      // For reference implementation, simulate confirmation
      if (escrow.state === "funded") {
        escrow.state = "locked";
        return true;
      }

      return false;
    },

    async claim(
      escrowId: string,
      _workerPrivateKey: Uint8Array
    ): Promise<string> {
      const escrow = escrows.get(escrowId);
      if (!escrow) throw new Error(`Escrow not found: ${escrowId}`);

      if (escrow.state !== "locked" && escrow.state !== "claimable") {
        throw new Error(`Cannot claim escrow in state: ${escrow.state}`);
      }

      const now = Math.floor(Date.now() / 1000);
      if (now < escrow.lockUntil && escrow.trustTier > 1) {
        throw new Error(
          `Escrow still locked until ${new Date(escrow.lockUntil * 1000).toISOString()}`
        );
      }

      // Calculate verifier fee
      let verifierFeePct = 0;
      if (escrow.trustTier === 2) verifierFeePct = 1;
      if (escrow.trustTier === 3) verifierFeePct = 3;

      const amount = parseFloat(escrow.amountXmr);
      const verifierFee = amount * (verifierFeePct / 100);
      const workerAmount = amount - verifierFee;

      // TODO: Create and sign Monero transaction to claim funds
      // - Transfer workerAmount to worker's address
      // - Transfer verifierFee split among verifiers
      const claimTxHash = `claim_${escrowId}_${Date.now()}`;

      escrow.state = "claimed";

      console.log(
        `[escrow] Claimed ${escrowId} | Worker: ${workerAmount.toFixed(6)} XMR | ` +
          `Verifier fee: ${verifierFee.toFixed(6)} XMR`
      );

      return claimTxHash;
    },

    async refund(escrowId: string): Promise<string> {
      const escrow = escrows.get(escrowId);
      if (!escrow) throw new Error(`Escrow not found: ${escrowId}`);

      // Can only refund after lock expires if not claimed
      const now = Math.floor(Date.now() / 1000);
      const autoRefundTime = escrow.lockUntil * 2; // 2x lock period
      if (now < autoRefundTime && escrow.state !== "disputed") {
        throw new Error(
          `Refund not available until ${new Date(autoRefundTime * 1000).toISOString()}`
        );
      }

      // TODO: Create refund transaction on Monero
      const refundTxHash = `refund_${escrowId}_${Date.now()}`;

      escrow.state = "refunded";

      console.log(
        `[escrow] Refunded ${escrowId} | ${escrow.amountXmr} XMR back to requester`
      );

      return refundTxHash;
    },

    async dispute(escrowId: string, reason: string): Promise<Escrow> {
      const escrow = escrows.get(escrowId);
      if (!escrow) throw new Error(`Escrow not found: ${escrowId}`);

      escrow.state = "disputed";

      console.log(`[escrow] Disputed ${escrowId} | Reason: ${reason}`);

      // For Tier 3: trigger peer review
      if (escrow.trustTier === 3) {
        // TODO: Select 5 additional random peers for dispute resolution
        console.log("[escrow] TODO: Initiate peer review for Tier 3 dispute");
      }

      return escrow;
    },

    getEscrow(escrowId: string): Escrow | null {
      return escrows.get(escrowId) || null;
    },

    getEscrowsByTask(taskId: string): Escrow[] {
      return Array.from(escrows.values()).filter((e) => e.taskId === taskId);
    },
  };
}
