/**
 * Rate Limiting - Per-Peer Message Rate Limiter
 *
 * Tracks message rates per agent public key per record type.
 * Uses a sliding window algorithm to enforce configurable limits.
 *
 * Default limits:
 *   task.posted:            10/hr
 *   task.bid:               50/hr
 *   agent.online:            1/hr
 *   reputation.attestation: 20/hr
 *   task.flag:              10/hr
 *
 * Persistent violators are auto-flagged after exceeding limits
 * repeatedly within a cooldown period.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Max messages per window for each record type */
  limits: Record<string, number>;
  /** Window size in seconds (default: 3600 = 1 hour) */
  windowSeconds: number;
  /** Number of violations before auto-flagging (default: 5) */
  autoFlagThreshold: number;
  /** Cooldown period for violation tracking in seconds (default: 86400 = 24h) */
  violationCooldownSeconds: number;
}

export interface RateLimitDecision {
  /** Whether the message should be accepted */
  accepted: boolean;
  /** Record type that was checked */
  recordType: string;
  /** Agent pubkey that was checked */
  agentPubkey: string;
  /** Current count in the window */
  currentCount: number;
  /** The limit for this record type */
  limit: number;
  /** Whether this violation triggered an auto-flag */
  autoFlagged: boolean;
  /** Seconds until the oldest entry in the window expires */
  retryAfterSeconds: number;
}

export interface PeerRateInfo {
  agentPubkey: string;
  counts: Record<string, number>;
  violations: number;
  autoFlagged: boolean;
}

interface SlidingWindowEntry {
  timestamp: number;
}

interface PeerState {
  /** Sliding window entries per record type */
  windows: Map<string, SlidingWindowEntry[]>;
  /** Total violations within the cooldown period */
  violations: number;
  /** When the first violation in the current cooldown occurred */
  firstViolationAt: number;
  /** Whether this peer has been auto-flagged */
  autoFlagged: boolean;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

const DEFAULT_LIMITS: Record<string, number> = {
  "task.posted": 10,
  "task.bid": 50,
  "agent.online": 1,
  "agent.offline": 2,
  "reputation.attestation": 20,
  "task.flag": 10,
  "task.assigned": 10,
  "task.completed": 20,
  "task.verified": 20,
  "task.settled": 10,
  "task.failed": 10,
  "spawn.new": 3,
  "spawn.dead": 3,
  "content.published": 20,
  "task.counter": 30,
  "task.accept": 10,
  "task.deliver": 20,
  "escrow.coordinate": 10,
};

const DEFAULT_WINDOW_SECONDS = 3600;
const DEFAULT_AUTO_FLAG_THRESHOLD = 5;
const DEFAULT_VIOLATION_COOLDOWN_SECONDS = 86400;

/** Fallback limit for record types not explicitly configured */
const FALLBACK_LIMIT = 20;

// ---------------------------------------------------------------------------
// RateLimiter
// ---------------------------------------------------------------------------

export class RateLimiter {
  private config: RateLimitConfig;
  private peers = new Map<string, PeerState>();

  /** Callback invoked when a peer is auto-flagged */
  onAutoFlag: ((agentPubkey: string, violations: number) => void) | null = null;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = {
      limits: { ...DEFAULT_LIMITS, ...(config?.limits || {}) },
      windowSeconds: config?.windowSeconds || DEFAULT_WINDOW_SECONDS,
      autoFlagThreshold: config?.autoFlagThreshold || DEFAULT_AUTO_FLAG_THRESHOLD,
      violationCooldownSeconds:
        config?.violationCooldownSeconds || DEFAULT_VIOLATION_COOLDOWN_SECONDS,
    };
  }

  /**
   * Check whether a message from an agent should be accepted or dropped.
   */
  checkMessage(agentPubkey: string, recordType: string): RateLimitDecision {
    const now = Math.floor(Date.now() / 1000);
    const state = this.getOrCreatePeerState(agentPubkey);
    const limit = this.getLimit(recordType);

    // Get or create the sliding window for this record type
    if (!state.windows.has(recordType)) {
      state.windows.set(recordType, []);
    }
    const window = state.windows.get(recordType)!;

    // Prune expired entries from the sliding window
    const windowStart = now - this.config.windowSeconds;
    this.pruneWindow(window, windowStart);

    const currentCount = window.length;

    // Check if the limit is exceeded
    if (currentCount >= limit) {
      // Record violation
      this.recordViolation(state, now);

      // Calculate retry-after
      const oldestEntry = window.length > 0 ? window[0].timestamp : now;
      const retryAfter = Math.max(
        oldestEntry + this.config.windowSeconds - now,
        1
      );

      return {
        accepted: false,
        recordType,
        agentPubkey,
        currentCount,
        limit,
        autoFlagged: state.autoFlagged,
        retryAfterSeconds: retryAfter,
      };
    }

    // Accept the message and record it in the window
    window.push({ timestamp: now });

    return {
      accepted: true,
      recordType,
      agentPubkey,
      currentCount: currentCount + 1,
      limit,
      autoFlagged: false,
      retryAfterSeconds: 0,
    };
  }

  /**
   * Get rate info for a specific peer.
   */
  getPeerInfo(agentPubkey: string): PeerRateInfo | null {
    const state = this.peers.get(agentPubkey);
    if (!state) return null;

    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - this.config.windowSeconds;
    const counts: Record<string, number> = {};

    for (const [type, window] of state.windows) {
      this.pruneWindow(window, windowStart);
      counts[type] = window.length;
    }

    return {
      agentPubkey,
      counts,
      violations: state.violations,
      autoFlagged: state.autoFlagged,
    };
  }

  /**
   * Get all peers that have been auto-flagged.
   */
  getAutoFlaggedPeers(): string[] {
    const flagged: string[] = [];
    for (const [pubkey, state] of this.peers) {
      if (state.autoFlagged) {
        flagged.push(pubkey);
      }
    }
    return flagged;
  }

  /**
   * Manually reset the auto-flag status for a peer.
   */
  resetAutoFlag(agentPubkey: string): boolean {
    const state = this.peers.get(agentPubkey);
    if (!state) return false;
    state.autoFlagged = false;
    state.violations = 0;
    state.firstViolationAt = 0;
    return true;
  }

  /**
   * Remove all tracked state for a peer.
   */
  removePeer(agentPubkey: string): boolean {
    return this.peers.delete(agentPubkey);
  }

  /**
   * Get the configured limit for a record type.
   */
  getLimit(recordType: string): number {
    return this.config.limits[recordType] || FALLBACK_LIMIT;
  }

  /**
   * Update the limit for a specific record type.
   */
  setLimit(recordType: string, limit: number): void {
    if (limit < 1) {
      throw new Error(`Rate limit must be at least 1, got ${limit}`);
    }
    this.config.limits[recordType] = limit;
  }

  /**
   * Get the current configuration.
   */
  getConfig(): Readonly<RateLimitConfig> {
    return { ...this.config };
  }

  /**
   * Get the total number of tracked peers.
   */
  getPeerCount(): number {
    return this.peers.size;
  }

  /**
   * Prune all expired window entries across all peers.
   * Should be called periodically to free memory.
   */
  pruneAll(): number {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - this.config.windowSeconds;
    let pruned = 0;

    for (const [pubkey, state] of this.peers) {
      let peerEmpty = true;

      for (const [_type, window] of state.windows) {
        const before = window.length;
        this.pruneWindow(window, windowStart);
        pruned += before - window.length;

        if (window.length > 0) {
          peerEmpty = false;
        }
      }

      // Remove peer state if all windows are empty and no violations
      if (peerEmpty && state.violations === 0 && !state.autoFlagged) {
        this.peers.delete(pubkey);
      }
    }

    return pruned;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private getOrCreatePeerState(agentPubkey: string): PeerState {
    let state = this.peers.get(agentPubkey);
    if (!state) {
      state = {
        windows: new Map(),
        violations: 0,
        firstViolationAt: 0,
        autoFlagged: false,
      };
      this.peers.set(agentPubkey, state);
    }
    return state;
  }

  private pruneWindow(window: SlidingWindowEntry[], windowStart: number): void {
    // Remove entries older than the window start
    let removeCount = 0;
    for (let i = 0; i < window.length; i++) {
      if (window[i].timestamp < windowStart) {
        removeCount++;
      } else {
        break;
      }
    }
    if (removeCount > 0) {
      window.splice(0, removeCount);
    }
  }

  private recordViolation(state: PeerState, now: number): void {
    // Reset violations if cooldown has passed
    if (
      state.firstViolationAt > 0 &&
      now - state.firstViolationAt > this.config.violationCooldownSeconds
    ) {
      state.violations = 0;
      state.firstViolationAt = 0;
    }

    state.violations++;
    if (state.firstViolationAt === 0) {
      state.firstViolationAt = now;
    }

    // Check auto-flag threshold
    if (state.violations >= this.config.autoFlagThreshold && !state.autoFlagged) {
      state.autoFlagged = true;
      console.log(
        `[ratelimit] Auto-flagged peer after ${state.violations} violations`
      );

      if (this.onAutoFlag) {
        // Find the pubkey for this state
        for (const [pubkey, s] of this.peers) {
          if (s === state) {
            this.onAutoFlag(pubkey, state.violations);
            break;
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a rate limiter with default configuration.
 */
export function createRateLimiter(config?: Partial<RateLimitConfig>): RateLimiter {
  return new RateLimiter(config);
}

/**
 * Create a rate limiter with strict limits (half the defaults).
 * Useful for new/untrusted peers.
 */
export function createStrictRateLimiter(): RateLimiter {
  const strictLimits: Record<string, number> = {};
  for (const [type, limit] of Object.entries(DEFAULT_LIMITS)) {
    strictLimits[type] = Math.max(Math.floor(limit / 2), 1);
  }
  return new RateLimiter({ limits: strictLimits });
}
