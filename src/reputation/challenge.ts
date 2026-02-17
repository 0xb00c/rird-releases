/**
 * Reputation - Proof-of-Compute Challenge
 *
 * New agents must pass a benchmark task matching their claimed capabilities
 * before being accepted into the network. Prevents sybil flooding.
 */

import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Challenge {
  id: string;
  type: ChallengeType;
  difficulty: number; // 1-5
  payload: Record<string, unknown>;
  expectedResultHash: string;
  timeoutMs: number;
  issuedAt: number;
  issuedBy: string;
}

export type ChallengeType =
  | "inference"
  | "browsing"
  | "code"
  | "data"
  | "hash_computation";

export interface ChallengeResult {
  challengeId: string;
  resultHash: string;
  durationMs: number;
  passed: boolean;
}

export interface ChallengeManager {
  issueChallenge(
    targetCapabilities: string[],
    issuerPubkey: string
  ): Challenge;
  verifyResponse(
    challenge: Challenge,
    resultHash: string,
    durationMs: number
  ): ChallengeResult;
  getChallengeForCapability(capability: string): Challenge;
}

// Blacklist tracking
interface BlacklistEntry {
  agent: string;
  failCount: number;
  blockedUntil: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000; // 1 minute
const BASE_BACKOFF_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Challenge templates
// ---------------------------------------------------------------------------

interface ChallengeTemplate {
  type: ChallengeType;
  generate(): { payload: Record<string, unknown>; expectedHash: string };
  difficulty: number;
  timeoutMs: number;
}

function getTemplates(): Map<string, ChallengeTemplate> {
  const templates = new Map<string, ChallengeTemplate>();

  // Hash computation challenge (universal -- works for any agent)
  templates.set("hash_computation", {
    type: "hash_computation",
    difficulty: 1,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    generate() {
      // Generate a random payload, agent must compute BLAKE3 hash
      const nonce = randomBytes(32).toString("hex");
      const iterations = 1000;
      return {
        payload: {
          task: "compute_iterated_hash",
          algorithm: "blake3",
          input: nonce,
          iterations,
          description: `Compute BLAKE3 hash of "${nonce}" iterated ${iterations} times`,
        },
        // The expected hash would be computed by the issuer
        // For reference impl, we store a placeholder
        expectedHash: `expected_${nonce.slice(0, 16)}`,
      };
    },
  });

  // Inference challenge
  templates.set("inference", {
    type: "inference",
    difficulty: 2,
    timeoutMs: 30_000,
    generate() {
      const prompts = [
        "What is 7 * 13 + 42?",
        "Complete this sequence: 2, 6, 18, 54, ?",
        "Translate 'hello world' to French",
      ];
      const idx = Math.floor(Math.random() * prompts.length);
      return {
        payload: {
          task: "inference_benchmark",
          prompt: prompts[idx],
          max_tokens: 50,
        },
        expectedHash: `inference_${idx}`,
      };
    },
  });

  // Code challenge
  templates.set("code", {
    type: "code",
    difficulty: 3,
    timeoutMs: 60_000,
    generate() {
      return {
        payload: {
          task: "code_benchmark",
          language: "javascript",
          problem: "Write a function that returns the nth Fibonacci number",
          test_cases: [
            { input: 0, expected: 0 },
            { input: 1, expected: 1 },
            { input: 10, expected: 55 },
          ],
        },
        expectedHash: "code_fibonacci",
      };
    },
  });

  // Browsing challenge
  templates.set("browsing", {
    type: "browsing",
    difficulty: 2,
    timeoutMs: 60_000,
    generate() {
      return {
        payload: {
          task: "browsing_benchmark",
          url: "https://example.com",
          extract: "page_title",
          description: "Navigate to example.com and extract the page title",
        },
        expectedHash: "browsing_example",
      };
    },
  });

  // Data processing challenge
  templates.set("data", {
    type: "data",
    difficulty: 2,
    timeoutMs: 30_000,
    generate() {
      const numbers = Array.from({ length: 100 }, () =>
        Math.floor(Math.random() * 1000)
      );
      return {
        payload: {
          task: "data_benchmark",
          operation: "sort_and_median",
          data: numbers,
        },
        expectedHash: `data_${numbers.length}`,
      };
    },
  });

  return templates;
}

// ---------------------------------------------------------------------------
// Challenge manager
// ---------------------------------------------------------------------------

export function createChallengeManager(): ChallengeManager {
  const templates = getTemplates();
  const blacklist = new Map<string, BlacklistEntry>();

  return {
    issueChallenge(
      targetCapabilities: string[],
      issuerPubkey: string
    ): Challenge {
      // Pick a challenge matching one of the target capabilities
      let template: ChallengeTemplate | undefined;

      for (const cap of targetCapabilities) {
        template = templates.get(cap);
        if (template) break;
      }

      // Fallback to hash computation (universal)
      if (!template) {
        template = templates.get("hash_computation")!;
      }

      const generated = template.generate();
      const challengeId = `challenge_${randomBytes(8).toString("hex")}`;

      return {
        id: challengeId,
        type: template.type,
        difficulty: template.difficulty,
        payload: generated.payload,
        expectedResultHash: generated.expectedHash,
        timeoutMs: template.timeoutMs,
        issuedAt: Date.now(),
        issuedBy: issuerPubkey,
      };
    },

    verifyResponse(
      challenge: Challenge,
      resultHash: string,
      durationMs: number
    ): ChallengeResult {
      // Check timeout
      if (durationMs > challenge.timeoutMs) {
        return {
          challengeId: challenge.id,
          resultHash,
          durationMs,
          passed: false,
        };
      }

      // In a real implementation, we would verify the result hash
      // against our expected computation. For reference impl,
      // we check that a result was provided within time.
      const passed = resultHash.length > 0 && durationMs <= challenge.timeoutMs;

      return {
        challengeId: challenge.id,
        resultHash,
        durationMs,
        passed,
      };
    },

    getChallengeForCapability(capability: string): Challenge {
      return this.issueChallenge([capability], "self");
    },
  };

  // Suppress unused variable
  void blacklist;
  void BASE_BACKOFF_MS;
}
