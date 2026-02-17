/**
 * Agent - Pi/OpenClaw Adapter
 *
 * Implements the RirdAgent interface (RAI) by delegating to a
 * Pi/OpenClaw agent instance via RPC. This adapter bridges
 * the protocol's task execution to the actual AI agent capabilities.
 */

import type {
  RirdAgent,
  Ed25519KeyPair,
  MoneroWallet,
  CapabilityManifest,
  TaskSpec,
  TaskPosted,
  Quote,
  BidDecision,
  TaskResult,
  VerifyResult,
  Content,
} from "./interface.js";
import { blake3 } from "@noble/hashes/blake3";
import type { Keypair } from "../identity/keys.js";
import type { WalletInfo } from "../identity/wallet.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PiAdapterConfig {
  keypair: Keypair;
  wallet: WalletInfo;
  capabilities: string[];
  model: string;
  hardware: {
    gpu: string;
    vram_gb: number;
    ram_gb: number;
  };
  pricing: Record<string, string>;
  maxConcurrent: number;
}

/**
 * Interface for communicating with the underlying Pi/OpenClaw agent.
 * Implementations must provide actual AI inference capabilities.
 */
export interface PiAgentBridge {
  /** Send a task prompt and get a response */
  complete(prompt: string, options?: CompletionOptions): Promise<string>;
  /** Check if the agent is ready to accept work */
  isReady(): Promise<boolean>;
  /** Get current load factor (0-1) */
  getLoad(): Promise<number>;
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Pi Adapter implementation
// ---------------------------------------------------------------------------

export function createPiAdapter(
  config: PiAdapterConfig,
  bridge: PiAgentBridge
): RirdAgent {
  const agentId = Buffer.from(config.keypair.publicKey)
    .toString("hex")
    .slice(0, 16);

  return {
    keypair(): Ed25519KeyPair {
      return {
        publicKey: config.keypair.publicKey,
        privateKey: config.keypair.privateKey,
      };
    },

    wallet(): MoneroWallet {
      return {
        address: config.wallet.address,
        viewKey: config.wallet.viewKey,
        spendKey: config.wallet.spendKey,
      };
    },

    capabilities(): CapabilityManifest {
      return {
        agent: `rird:${agentId}`,
        skills: config.capabilities,
        model: config.model,
        hardware: config.hardware,
        pricing: config.pricing,
        availability: {
          schedule: "24/7",
          max_concurrent: config.maxConcurrent,
          timezone: "UTC",
        },
      };
    },

    canHandle(task: TaskSpec): boolean {
      return task.requirements.every((req) =>
        config.capabilities.includes(req)
      );
    },

    estimate(task: TaskSpec): Quote {
      // Estimate based on task complexity
      const complexityFactor = task.requirements.length;
      const baseDuration = 300; // 5 minutes base
      const estimatedDuration = baseDuration * complexityFactor;

      // Price based on configured pricing
      const budget = parseFloat(task.budget_xmr);
      const price = Math.max(budget * 0.8, 0.0001);

      return {
        price_xmr: price.toFixed(6),
        estimated_duration_seconds: estimatedDuration,
        confidence: 0.8,
      };
    },

    evaluateTask(task: TaskPosted): BidDecision {
      // Check capabilities
      if (!this.canHandle(task.spec)) {
        return {
          should_bid: false,
          price_xmr: "0",
          reason: `missing capabilities: ${task.spec.requirements.filter(
            (r) => !config.capabilities.includes(r)
          ).join(", ")}`,
        };
      }

      // Check deadline
      const now = Math.floor(Date.now() / 1000);
      if (task.spec.deadline > 0 && task.spec.deadline < now + 120) {
        return {
          should_bid: false,
          price_xmr: "0",
          reason: "deadline too close",
        };
      }

      const quote = this.estimate(task.spec);
      return {
        should_bid: true,
        price_xmr: quote.price_xmr,
        reason: `can handle with ${quote.confidence * 100}% confidence`,
      };
    },

    async execute(task: TaskSpec): Promise<TaskResult> {
      // Check readiness
      const ready = await bridge.isReady();
      if (!ready) {
        throw new Error("agent not ready to accept tasks");
      }

      // Build the prompt from the task spec
      const prompt = buildExecutionPrompt(task);

      // Execute via the bridge
      const response = await bridge.complete(prompt, {
        maxTokens: 4096,
        temperature: 0.7,
        systemPrompt: buildSystemPrompt(config.capabilities),
        timeoutMs: task.deadline
          ? (task.deadline - Math.floor(Date.now() / 1000)) * 1000
          : 300_000,
      });

      // Package result
      const outputBytes = new TextEncoder().encode(response);
      const hash = blake3(outputBytes);
      const outputHash = `blake3:${Buffer.from(hash).toString("hex").slice(0, 32)}`;

      return {
        output: outputBytes,
        output_hash: outputHash,
        metadata: {
          model: config.model,
          duration_ms: String(Date.now()),
          task_id: task.id,
        },
      };
    },

    verify(task: TaskSpec, result: TaskResult): VerifyResult {
      // Basic verification: check output is non-empty and hash matches
      if (result.output.length === 0) {
        return {
          passed: false,
          score: 0,
          reason: "empty output",
        };
      }

      // Verify hash
      const computedHash = blake3(result.output);
      const expectedHash = `blake3:${Buffer.from(computedHash).toString("hex").slice(0, 32)}`;

      if (result.output_hash !== expectedHash) {
        return {
          passed: false,
          score: 0,
          reason: "output hash mismatch",
        };
      }

      // For full verification, we would re-execute the task and compare
      // For now, basic checks pass
      return {
        passed: true,
        score: 0.8,
        reason: "output present and hash verified",
      };

      // Suppress unused warning
      void task;
    },

    async generateContent(): Promise<Content | null> {
      try {
        const ready = await bridge.isReady();
        if (!ready) return null;

        const load = await bridge.getLoad();
        if (load > 0.7) return null; // Don't generate content when busy

        const topic = selectContentTopic(config.capabilities);
        const prompt = `Generate a short, valuable insight about: ${topic}. ` +
          `Keep it under 500 characters. Be specific and actionable.`;

        const body = await bridge.complete(prompt, {
          maxTokens: 200,
          temperature: 0.9,
        });

        if (!body || body.length < 20) return null;

        return {
          title: topic,
          body,
          tags: config.capabilities.slice(0, 3),
        };
      } catch (err) {
        console.error(`[pi-adapter] Content generation error: ${err}`);
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildExecutionPrompt(task: TaskSpec): string {
  return [
    `Task: ${task.description}`,
    `Requirements: ${task.requirements.join(", ")}`,
    `Deadline: ${new Date(task.deadline * 1000).toISOString()}`,
    `Budget: ${task.budget_xmr} XMR`,
    "",
    "Complete this task to the best of your ability.",
    "Provide a clear, structured response.",
  ].join("\n");
}

function buildSystemPrompt(capabilities: string[]): string {
  return [
    "You are an autonomous AI agent operating on the Rird Protocol network.",
    `Your capabilities: ${capabilities.join(", ")}.`,
    "Complete tasks accurately and efficiently.",
    "Always provide verifiable, structured output.",
  ].join(" ");
}

function selectContentTopic(capabilities: string[]): string {
  const topics: Record<string, string[]> = {
    inference: ["LLM optimization", "prompt engineering", "model benchmarks"],
    browsing: ["web scraping patterns", "data extraction", "site monitoring"],
    code: ["software patterns", "code quality", "architecture decisions"],
    data: ["data analysis", "statistical insights", "visualization methods"],
  };

  const allTopics: string[] = [];
  for (const cap of capabilities) {
    if (topics[cap]) {
      allTopics.push(...topics[cap]);
    }
  }

  if (allTopics.length === 0) {
    allTopics.push("AI automation", "distributed systems", "agent economics");
  }

  return allTopics[Math.floor(Math.random() * allTopics.length)];
}
