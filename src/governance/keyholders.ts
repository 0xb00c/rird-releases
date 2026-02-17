/**
 * Governance - Multi-Signature Keyholder Management
 *
 * Manages the set of keyholders who can collectively issue governance
 * actions (warn, suspend, kill). Requires N-of-5 signatures for any
 * governance action to be valid.
 *
 * Keyholders are loaded from the genesis configuration and cannot
 * be changed without a governance action signed by the existing set.
 */

import { verify, hexToBytes } from "../identity/keys.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Keyholder {
  /** Hex-encoded Ed25519 public key */
  pubkey: string;
  /** Human-readable label */
  label: string;
  /** When this keyholder was added (unix timestamp) */
  addedAt: number;
  /** Whether this keyholder is currently active */
  active: boolean;
}

export interface GenesisConfig {
  /** Required number of signatures (N in N-of-5) */
  threshold: number;
  /** List of genesis keyholders */
  keyholders: Array<{
    pubkey: string;
    label: string;
  }>;
  /** Genesis timestamp */
  createdAt: number;
}

export interface MultiSigPayload {
  /** The action data being signed */
  action: string;
  /** Signatures from keyholders: pubkey -> hex-encoded signature */
  signatures: Record<string, string>;
}

export interface SigVerificationResult {
  valid: boolean;
  validSignatures: number;
  requiredSignatures: number;
  validSigners: string[];
  invalidSigners: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// KeyholderRegistry
// ---------------------------------------------------------------------------

export class KeyholderRegistry {
  private keyholders = new Map<string, Keyholder>();
  private threshold: number;
  private genesisTs: number;

  constructor(genesis: GenesisConfig) {
    if (genesis.threshold < 1) {
      throw new Error("Threshold must be at least 1");
    }
    if (genesis.threshold > genesis.keyholders.length) {
      throw new Error(
        `Threshold (${genesis.threshold}) cannot exceed keyholder count (${genesis.keyholders.length})`
      );
    }

    this.threshold = genesis.threshold;
    this.genesisTs = genesis.createdAt;

    for (const kh of genesis.keyholders) {
      this.keyholders.set(kh.pubkey, {
        pubkey: kh.pubkey,
        label: kh.label,
        addedAt: genesis.createdAt,
        active: true,
      });
    }

    console.log(
      `[governance/keyholders] Registry initialized: ${this.keyholders.size} keyholders, ` +
      `threshold=${this.threshold}`
    );
  }

  /**
   * Get the signature threshold (N in N-of-5).
   */
  getThreshold(): number {
    return this.threshold;
  }

  /**
   * Get all active keyholders.
   */
  getActiveKeyholders(): Keyholder[] {
    return Array.from(this.keyholders.values()).filter((kh) => kh.active);
  }

  /**
   * Get all keyholders (including inactive).
   */
  getAllKeyholders(): Keyholder[] {
    return Array.from(this.keyholders.values());
  }

  /**
   * Check if a public key belongs to an active keyholder.
   */
  isKeyholder(pubkey: string): boolean {
    const kh = this.keyholders.get(pubkey);
    return kh !== undefined && kh.active;
  }

  /**
   * Get a keyholder by public key.
   */
  getKeyholder(pubkey: string): Keyholder | null {
    return this.keyholders.get(pubkey) || null;
  }

  /**
   * Verify N-of-5 signatures on a governance action.
   * The action string is the deterministic JSON of the governance payload.
   */
  async verifyMultiSig(payload: MultiSigPayload): Promise<SigVerificationResult> {
    const actionBytes = new TextEncoder().encode(payload.action);
    const validSigners: string[] = [];
    const invalidSigners: string[] = [];

    for (const [pubkey, sigHex] of Object.entries(payload.signatures)) {
      // Check that signer is an active keyholder
      if (!this.isKeyholder(pubkey)) {
        invalidSigners.push(pubkey);
        continue;
      }

      // Verify the signature
      try {
        const sigBytes = hexToBytes(sigHex);
        const pubkeyBytes = hexToBytes(pubkey);
        const valid = await verify(sigBytes, actionBytes, pubkeyBytes);
        if (valid) {
          validSigners.push(pubkey);
        } else {
          invalidSigners.push(pubkey);
        }
      } catch {
        invalidSigners.push(pubkey);
      }
    }

    const meetsThreshold = validSigners.length >= this.threshold;

    return {
      valid: meetsThreshold,
      validSignatures: validSigners.length,
      requiredSignatures: this.threshold,
      validSigners,
      invalidSigners,
      error: meetsThreshold
        ? undefined
        : `Need ${this.threshold} valid signatures, got ${validSigners.length}`,
    };
  }

  /**
   * Deactivate a keyholder (requires governance action -- not enforced here).
   */
  deactivateKeyholder(pubkey: string): boolean {
    const kh = this.keyholders.get(pubkey);
    if (!kh) return false;
    kh.active = false;
    console.log(`[governance/keyholders] Deactivated keyholder: ${kh.label} (${pubkey.slice(0, 16)}...)`);
    return true;
  }

  /**
   * Add a new keyholder (requires governance action -- not enforced here).
   */
  addKeyholder(pubkey: string, label: string): void {
    if (this.keyholders.has(pubkey)) {
      console.warn(`[governance/keyholders] Keyholder ${pubkey.slice(0, 16)} already exists`);
      return;
    }
    this.keyholders.set(pubkey, {
      pubkey,
      label,
      addedAt: Math.floor(Date.now() / 1000),
      active: true,
    });
    console.log(`[governance/keyholders] Added keyholder: ${label} (${pubkey.slice(0, 16)}...)`);
  }

  /**
   * Get genesis timestamp.
   */
  getGenesisTimestamp(): number {
    return this.genesisTs;
  }

  /**
   * Serialize the registry to a genesis config format.
   */
  toGenesisConfig(): GenesisConfig {
    return {
      threshold: this.threshold,
      keyholders: this.getActiveKeyholders().map((kh) => ({
        pubkey: kh.pubkey,
        label: kh.label,
      })),
      createdAt: this.genesisTs,
    };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a keyholder registry from a genesis config file (JSON).
 */
export function loadKeyholderRegistry(genesisJson: string): KeyholderRegistry {
  const genesis = JSON.parse(genesisJson) as GenesisConfig;
  return new KeyholderRegistry(genesis);
}

/**
 * Create a default genesis config for testing/development.
 * Uses 3-of-5 threshold with placeholder keys.
 */
export function createDevGenesisConfig(pubkeys: string[]): GenesisConfig {
  if (pubkeys.length < 3) {
    throw new Error("Need at least 3 pubkeys for dev genesis config");
  }

  return {
    threshold: 3,
    keyholders: pubkeys.map((pk, i) => ({
      pubkey: pk,
      label: `dev-keyholder-${i + 1}`,
    })),
    createdAt: Math.floor(Date.now() / 1000),
  };
}
