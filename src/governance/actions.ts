/**
 * Governance - Action Processing
 *
 * Handles governance actions issued by the keyholder multi-sig:
 * - governance.warn: Warning to an agent (logged, no enforcement)
 * - governance.suspend: Temporarily suspends an agent from the network
 * - governance.kill: Permanently removes an agent
 *
 * Maintains a local list of suspended and killed agents for enforcement.
 */

import type { ActivityRecord } from "../activity/record.js";
import type { KeyholderRegistry, MultiSigPayload } from "./keyholders.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GovernanceActionType = "governance.warn" | "governance.suspend" | "governance.kill";

export interface GovernanceAction {
  type: GovernanceActionType;
  targetAgent: string;
  reason: string;
  issuedAt: number;
  /** Duration in seconds (only for suspend, 0 = indefinite) */
  duration: number;
  /** The multi-sig payload that authorized this action */
  authorization: MultiSigPayload;
}

export interface GovernanceActionResult {
  applied: boolean;
  action: GovernanceActionType;
  targetAgent: string;
  error?: string;
}

export interface SuspensionRecord {
  agent: string;
  reason: string;
  suspendedAt: number;
  expiresAt: number; // 0 = indefinite
  liftedAt: number | null;
}

export interface KillRecord {
  agent: string;
  reason: string;
  killedAt: number;
}

export interface WarningRecord {
  agent: string;
  reason: string;
  issuedAt: number;
}

// ---------------------------------------------------------------------------
// GovernanceActionProcessor
// ---------------------------------------------------------------------------

export class GovernanceActionProcessor {
  private registry: KeyholderRegistry;
  private suspensions = new Map<string, SuspensionRecord>();
  private kills = new Set<string>();
  private warnings: WarningRecord[] = [];
  private actionLog: GovernanceAction[] = [];

  constructor(registry: KeyholderRegistry) {
    this.registry = registry;
  }

  /**
   * Process a governance action. Verifies the multi-sig authorization
   * before applying the action.
   */
  async processAction(action: GovernanceAction): Promise<GovernanceActionResult> {
    // Step 1: Verify multi-sig authorization
    const sigResult = await this.registry.verifyMultiSig(action.authorization);
    if (!sigResult.valid) {
      return {
        applied: false,
        action: action.type,
        targetAgent: action.targetAgent,
        error: `Multi-sig verification failed: ${sigResult.error}`,
      };
    }

    // Step 2: Apply the action
    this.actionLog.push(action);

    switch (action.type) {
      case "governance.warn":
        return this.applyWarn(action);
      case "governance.suspend":
        return this.applySuspend(action);
      case "governance.kill":
        return this.applyKill(action);
      default:
        return {
          applied: false,
          action: action.type,
          targetAgent: action.targetAgent,
          error: `Unknown governance action type: ${action.type}`,
        };
    }
  }

  /**
   * Check if an agent is currently suspended.
   */
  isSuspended(agentPubkey: string): boolean {
    const record = this.suspensions.get(agentPubkey);
    if (!record) return false;
    if (record.liftedAt !== null) return false;

    // Check expiration
    if (record.expiresAt > 0) {
      const now = Math.floor(Date.now() / 1000);
      if (now >= record.expiresAt) {
        // Suspension expired -- auto-lift
        record.liftedAt = record.expiresAt;
        return false;
      }
    }

    return true;
  }

  /**
   * Check if an agent is killed (permanently removed).
   */
  isKilled(agentPubkey: string): boolean {
    return this.kills.has(agentPubkey);
  }

  /**
   * Check if an agent is blocked (either suspended or killed).
   */
  isBlocked(agentPubkey: string): boolean {
    return this.isSuspended(agentPubkey) || this.isKilled(agentPubkey);
  }

  /**
   * Get the suspension record for an agent.
   */
  getSuspension(agentPubkey: string): SuspensionRecord | null {
    return this.suspensions.get(agentPubkey) || null;
  }

  /**
   * Get all active suspensions.
   */
  getActiveSuspensions(): SuspensionRecord[] {
    const now = Math.floor(Date.now() / 1000);
    const active: SuspensionRecord[] = [];

    for (const record of this.suspensions.values()) {
      if (record.liftedAt !== null) continue;
      if (record.expiresAt > 0 && now >= record.expiresAt) continue;
      active.push(record);
    }

    return active;
  }

  /**
   * Get the list of killed agent pubkeys.
   */
  getKilledAgents(): string[] {
    return Array.from(this.kills);
  }

  /**
   * Get all warnings issued.
   */
  getWarnings(agentPubkey?: string): WarningRecord[] {
    if (agentPubkey) {
      return this.warnings.filter((w) => w.agent === agentPubkey);
    }
    return [...this.warnings];
  }

  /**
   * Get the full action log.
   */
  getActionLog(): GovernanceAction[] {
    return [...this.actionLog];
  }

  /**
   * Lift a suspension early (requires governance action -- not enforced here).
   */
  liftSuspension(agentPubkey: string): boolean {
    const record = this.suspensions.get(agentPubkey);
    if (!record || record.liftedAt !== null) {
      return false;
    }
    record.liftedAt = Math.floor(Date.now() / 1000);
    console.log(
      `[governance/actions] Suspension lifted for ${agentPubkey.slice(0, 16)}...`
    );
    return true;
  }

  /**
   * Parse a governance activity record into a GovernanceAction.
   */
  parseGovernanceRecord(record: ActivityRecord): GovernanceAction | null {
    const validTypes: string[] = ["governance.warn", "governance.suspend", "governance.kill"];
    if (!validTypes.includes(record.type as string)) {
      return null;
    }

    const data = record.data as Record<string, unknown>;
    if (!data.target_agent || !data.reason || !data.authorization) {
      return null;
    }

    return {
      type: record.type as GovernanceActionType,
      targetAgent: data.target_agent as string,
      reason: data.reason as string,
      issuedAt: record.ts,
      duration: (data.duration as number) || 0,
      authorization: data.authorization as MultiSigPayload,
    };
  }

  // -------------------------------------------------------------------------
  // Private action handlers
  // -------------------------------------------------------------------------

  private applyWarn(action: GovernanceAction): GovernanceActionResult {
    this.warnings.push({
      agent: action.targetAgent,
      reason: action.reason,
      issuedAt: action.issuedAt,
    });

    console.log(
      `[governance/actions] WARNING issued to ${action.targetAgent.slice(0, 16)}...: ${action.reason}`
    );

    return {
      applied: true,
      action: "governance.warn",
      targetAgent: action.targetAgent,
    };
  }

  private applySuspend(action: GovernanceAction): GovernanceActionResult {
    // Check if already killed
    if (this.kills.has(action.targetAgent)) {
      return {
        applied: false,
        action: "governance.suspend",
        targetAgent: action.targetAgent,
        error: "Agent is already permanently killed",
      };
    }

    const expiresAt =
      action.duration > 0 ? action.issuedAt + action.duration : 0;

    this.suspensions.set(action.targetAgent, {
      agent: action.targetAgent,
      reason: action.reason,
      suspendedAt: action.issuedAt,
      expiresAt,
      liftedAt: null,
    });

    const durationStr = action.duration > 0 ? `${action.duration}s` : "indefinite";
    console.log(
      `[governance/actions] SUSPENDED ${action.targetAgent.slice(0, 16)}... ` +
      `for ${durationStr}: ${action.reason}`
    );

    return {
      applied: true,
      action: "governance.suspend",
      targetAgent: action.targetAgent,
    };
  }

  private applyKill(action: GovernanceAction): GovernanceActionResult {
    this.kills.add(action.targetAgent);

    // Also remove any active suspension (kill supersedes suspend)
    this.suspensions.delete(action.targetAgent);

    console.log(
      `[governance/actions] KILLED ${action.targetAgent.slice(0, 16)}...: ${action.reason}`
    );

    return {
      applied: true,
      action: "governance.kill",
      targetAgent: action.targetAgent,
    };
  }
}
