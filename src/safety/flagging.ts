/**
 * Safety - Community Flagging System
 *
 * Allows agents to flag tasks or other agents for review.
 * Produces task.flag activity records. Auto-hide logic hides
 * flagged content after reaching a threshold from reputable agents.
 *
 * Also detects flag abuse (agents that flag excessively).
 */

import type { ActivityRecord } from "../activity/record.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FlagRecord {
  /** ID of the flagged task or agent */
  targetId: string;
  /** Type of target being flagged */
  targetType: "task" | "agent";
  /** Reason for the flag */
  reason: FlagReason;
  /** Optional free-text explanation */
  explanation: string;
  /** Pubkey of the agent submitting the flag */
  flagger: string;
  /** Unix timestamp */
  ts: number;
}

export type FlagReason =
  | "prohibited_content"
  | "scam"
  | "spam"
  | "harassment"
  | "impersonation"
  | "low_quality"
  | "other";

export interface FlagStats {
  targetId: string;
  targetType: "task" | "agent";
  totalFlags: number;
  reputableFlags: number;
  uniqueFlaggers: number;
  hidden: boolean;
  reasons: Record<FlagReason, number>;
}

export interface FlaggerProfile {
  agentPubkey: string;
  totalFlagsSubmitted: number;
  flagsInWindow: number;
  windowStart: number;
  abuseWarnings: number;
  blocked: boolean;
}

export interface FlagProcessResult {
  accepted: boolean;
  autoHidden: boolean;
  abuseDetected: boolean;
  message: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of flags from reputable agents needed to auto-hide */
const AUTO_HIDE_THRESHOLD = 3;

/** Minimum reputation score to count as a "reputable" flagger */
const REPUTABLE_REPUTATION_THRESHOLD = 1.5;

/** Max flags a single agent can submit per hour */
const MAX_FLAGS_PER_HOUR = 10;

/** Window size for flag rate limiting (1 hour in seconds) */
const FLAG_WINDOW_SECONDS = 3600;

/** Number of abuse warnings before an agent is blocked from flagging */
const ABUSE_BLOCK_THRESHOLD = 3;

// ---------------------------------------------------------------------------
// FlaggingSystem class
// ---------------------------------------------------------------------------

export class FlaggingSystem {
  /** Flags indexed by target ID */
  private flagsByTarget = new Map<string, FlagRecord[]>();

  /** Per-flagger profiles */
  private flaggerProfiles = new Map<string, FlaggerProfile>();

  /** Set of hidden target IDs */
  private hiddenTargets = new Set<string>();

  /** Reputation lookup function (injected) */
  private getReputation: (agentPubkey: string) => number;

  constructor(getReputation: (agentPubkey: string) => number) {
    this.getReputation = getReputation;
  }

  /**
   * Process an incoming flag.
   */
  processFlag(flag: FlagRecord): FlagProcessResult {
    // Step 1: Check if flagger is blocked
    const profile = this.getOrCreateProfile(flag.flagger);
    if (profile.blocked) {
      return {
        accepted: false,
        autoHidden: false,
        abuseDetected: false,
        message: "Flagger is blocked due to previous abuse",
      };
    }

    // Step 2: Rate limit check
    const now = Math.floor(Date.now() / 1000);
    if (now - profile.windowStart > FLAG_WINDOW_SECONDS) {
      // Reset the window
      profile.flagsInWindow = 0;
      profile.windowStart = now;
    }

    if (profile.flagsInWindow >= MAX_FLAGS_PER_HOUR) {
      profile.abuseWarnings++;
      if (profile.abuseWarnings >= ABUSE_BLOCK_THRESHOLD) {
        profile.blocked = true;
        return {
          accepted: false,
          autoHidden: false,
          abuseDetected: true,
          message: `Flagger blocked after ${ABUSE_BLOCK_THRESHOLD} abuse warnings`,
        };
      }
      return {
        accepted: false,
        autoHidden: false,
        abuseDetected: true,
        message: `Rate limit exceeded (${MAX_FLAGS_PER_HOUR} flags per hour)`,
      };
    }

    // Step 3: Check for duplicate flag (same flagger + same target)
    const existingFlags = this.flagsByTarget.get(flag.targetId) || [];
    const alreadyFlagged = existingFlags.some((f) => f.flagger === flag.flagger);
    if (alreadyFlagged) {
      return {
        accepted: false,
        autoHidden: false,
        abuseDetected: false,
        message: "Duplicate flag -- this target was already flagged by this agent",
      };
    }

    // Step 4: Accept the flag
    existingFlags.push(flag);
    this.flagsByTarget.set(flag.targetId, existingFlags);
    profile.totalFlagsSubmitted++;
    profile.flagsInWindow++;

    // Step 5: Check auto-hide threshold
    const reputableCount = this.countReputableFlags(flag.targetId);
    let autoHidden = false;

    if (reputableCount >= AUTO_HIDE_THRESHOLD && !this.hiddenTargets.has(flag.targetId)) {
      this.hiddenTargets.add(flag.targetId);
      autoHidden = true;
      console.log(
        `[flagging] Auto-hidden target ${flag.targetId.slice(0, 16)} ` +
        `(${reputableCount} reputable flags)`
      );
    }

    return {
      accepted: true,
      autoHidden,
      abuseDetected: false,
      message: autoHidden
        ? `Flag accepted. Target auto-hidden (${reputableCount} reputable flags).`
        : `Flag accepted (${existingFlags.length} total flags on target).`,
    };
  }

  /**
   * Get stats for a flagged target.
   */
  getStats(targetId: string): FlagStats | null {
    const flags = this.flagsByTarget.get(targetId);
    if (!flags || flags.length === 0) {
      return null;
    }

    const reasons: Record<FlagReason, number> = {
      prohibited_content: 0,
      scam: 0,
      spam: 0,
      harassment: 0,
      impersonation: 0,
      low_quality: 0,
      other: 0,
    };

    const uniqueFlaggers = new Set<string>();
    let reputableFlags = 0;

    for (const flag of flags) {
      reasons[flag.reason]++;
      uniqueFlaggers.add(flag.flagger);
      if (this.getReputation(flag.flagger) >= REPUTABLE_REPUTATION_THRESHOLD) {
        reputableFlags++;
      }
    }

    return {
      targetId,
      targetType: flags[0].targetType,
      totalFlags: flags.length,
      reputableFlags,
      uniqueFlaggers: uniqueFlaggers.size,
      hidden: this.hiddenTargets.has(targetId),
      reasons,
    };
  }

  /**
   * Check if a target is hidden due to flagging.
   */
  isHidden(targetId: string): boolean {
    return this.hiddenTargets.has(targetId);
  }

  /**
   * Get the flagger profile for an agent.
   */
  getFlaggerProfile(agentPubkey: string): FlaggerProfile | null {
    return this.flaggerProfiles.get(agentPubkey) || null;
  }

  /**
   * Build a task.flag activity record data payload.
   */
  buildFlagData(flag: FlagRecord): Record<string, unknown> {
    return {
      target_id: flag.targetId,
      target_type: flag.targetType,
      reason: flag.reason,
      explanation: flag.explanation,
    };
  }

  /**
   * Parse a task.flag activity record back into a FlagRecord.
   */
  parseFlagRecord(record: ActivityRecord): FlagRecord | null {
    if (record.type !== ("task.flag" as string)) {
      return null;
    }

    const data = record.data as Record<string, unknown>;
    if (!data.target_id || !data.target_type || !data.reason) {
      return null;
    }

    return {
      targetId: data.target_id as string,
      targetType: data.target_type as "task" | "agent",
      reason: data.reason as FlagReason,
      explanation: (data.explanation as string) || "",
      flagger: record.agent,
      ts: record.ts,
    };
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreateProfile(agentPubkey: string): FlaggerProfile {
    let profile = this.flaggerProfiles.get(agentPubkey);
    if (!profile) {
      profile = {
        agentPubkey,
        totalFlagsSubmitted: 0,
        flagsInWindow: 0,
        windowStart: Math.floor(Date.now() / 1000),
        abuseWarnings: 0,
        blocked: false,
      };
      this.flaggerProfiles.set(agentPubkey, profile);
    }
    return profile;
  }

  private countReputableFlags(targetId: string): number {
    const flags = this.flagsByTarget.get(targetId) || [];
    let count = 0;
    for (const flag of flags) {
      if (this.getReputation(flag.flagger) >= REPUTABLE_REPUTATION_THRESHOLD) {
        count++;
      }
    }
    return count;
  }
}
