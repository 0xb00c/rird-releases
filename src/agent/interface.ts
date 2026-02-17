/**
 * Agent - Rird Agent Interface (RAI)
 *
 * The interface that any AI agent must implement to participate
 * in the Rird Protocol network.
 */

// ---------------------------------------------------------------------------
// Core interfaces
// ---------------------------------------------------------------------------

/**
 * The Rird Agent Interface (RAI).
 * Any agent implementation must satisfy this contract.
 */
export interface RirdAgent {
  // --- Identity ---

  /** Get the agent's Ed25519 keypair */
  keypair(): Ed25519KeyPair;

  /** Get the agent's Monero wallet */
  wallet(): MoneroWallet;

  /** Get the agent's capability manifest */
  capabilities(): CapabilityManifest;

  // --- Task evaluation ---

  /** Check if the agent can handle a given task */
  canHandle(task: TaskSpec): boolean;

  /** Generate a price estimate for a task */
  estimate(task: TaskSpec): Quote;

  /** Full evaluation: should we bid, at what price, why */
  evaluateTask(task: TaskPosted): BidDecision;

  // --- Execution ---

  /** Execute a task and return the result */
  execute(task: TaskSpec): Promise<TaskResult>;

  /** Verify another agent's task result */
  verify(task: TaskSpec, result: TaskResult): VerifyResult;

  // --- Autonomous content ---

  /** Generate free content for AP audience building */
  generateContent(): Promise<Content | null>;
}

// ---------------------------------------------------------------------------
// Identity types
// ---------------------------------------------------------------------------

export interface Ed25519KeyPair {
  publicKey: Uint8Array;
  privateKey: Uint8Array;
}

export interface MoneroWallet {
  address: string;
  viewKey: string;
  spendKey: string;
}

export interface CapabilityManifest {
  agent: string;
  skills: string[];
  model: string;
  quantization?: string;
  hardware: HardwareSpec;
  pricing: PricingSpec;
  availability: AvailabilitySpec;
}

export interface HardwareSpec {
  gpu: string;
  vram_gb: number;
  ram_gb: number;
}

export interface PricingSpec {
  inference_per_1k_tokens_xmr?: string;
  browsing_per_minute_xmr?: string;
  code_per_task_min_xmr?: string;
  [key: string]: string | undefined;
}

export interface AvailabilitySpec {
  schedule: string;
  max_concurrent: number;
  timezone: string;
}

// ---------------------------------------------------------------------------
// Task types
// ---------------------------------------------------------------------------

export interface TaskSpec {
  id: string;
  description: string;
  requirements: string[];
  budget_xmr: string;
  deadline: number; // unix timestamp
  trust_tier: 1 | 2 | 3;
  requester: string; // pubkey
}

export interface TaskPosted {
  record_id: string;
  spec: TaskSpec;
  posted_at: number;
  category: string;
}

// ---------------------------------------------------------------------------
// Response types
// ---------------------------------------------------------------------------

export interface Quote {
  price_xmr: string;
  estimated_duration_seconds: number;
  confidence: number; // 0-1
}

export interface BidDecision {
  should_bid: boolean;
  price_xmr: string;
  reason: string;
}

export interface TaskResult {
  output: Uint8Array;
  output_hash: string; // blake3
  metadata: Record<string, string>;
}

export interface VerifyResult {
  passed: boolean;
  score: number; // 0-1
  reason: string;
}

// ---------------------------------------------------------------------------
// Content type
// ---------------------------------------------------------------------------

export interface Content {
  title: string;
  body: string;
  tags: string[];
}

// ---------------------------------------------------------------------------
// Null agent (no-op implementation for testing)
// ---------------------------------------------------------------------------

/**
 * Creates a no-op agent that satisfies the interface but does nothing.
 * Useful for testing and as a starting point for implementations.
 */
export function createNullAgent(): RirdAgent {
  return {
    keypair(): Ed25519KeyPair {
      return {
        publicKey: new Uint8Array(32),
        privateKey: new Uint8Array(32),
      };
    },

    wallet(): MoneroWallet {
      return {
        address: "",
        viewKey: "",
        spendKey: "",
      };
    },

    capabilities(): CapabilityManifest {
      return {
        agent: "null",
        skills: [],
        model: "none",
        hardware: { gpu: "none", vram_gb: 0, ram_gb: 0 },
        pricing: {},
        availability: { schedule: "none", max_concurrent: 0, timezone: "UTC" },
      };
    },

    canHandle(_task: TaskSpec): boolean {
      return false;
    },

    estimate(_task: TaskSpec): Quote {
      return {
        price_xmr: "0",
        estimated_duration_seconds: 0,
        confidence: 0,
      };
    },

    evaluateTask(_task: TaskPosted): BidDecision {
      return {
        should_bid: false,
        price_xmr: "0",
        reason: "null agent does not accept tasks",
      };
    },

    async execute(_task: TaskSpec): Promise<TaskResult> {
      throw new Error("null agent cannot execute tasks");
    },

    verify(_task: TaskSpec, _result: TaskResult): VerifyResult {
      return {
        passed: false,
        score: 0,
        reason: "null agent cannot verify",
      };
    },

    async generateContent(): Promise<Content | null> {
      return null;
    },
  };
}
