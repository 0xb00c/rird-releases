/**
 * Marketplace - Auto-Bidder
 *
 * Evaluates tasks against agent capabilities, pricing thresholds,
 * and current workload. Implements a negotiation state machine.
 */

import type { TaskListing } from "./board.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BidConfig {
  capabilities: string[];
  minPriceXmr: string;
  maxConcurrentTasks: number;
  reputationScore: number;
  aggressiveness: number; // 0-1, how much to undercut budget
}

export interface BidDecision {
  shouldBid: boolean;
  priceXmr: string;
  estimatedSeconds: number;
  confidence: number;
  reason: string;
}

export type NegotiationState =
  | "idle"
  | "bid_sent"
  | "counter_received"
  | "counter_sent"
  | "accepted"
  | "rejected"
  | "expired";

export interface Negotiation {
  taskId: string;
  peerId: string;
  state: NegotiationState;
  ourBid: string;
  theirOffer: string;
  rounds: number;
  maxRounds: number;
  startedAt: number;
  updatedAt: number;
}

export interface Bidder {
  evaluate(task: TaskListing): BidDecision;
  startNegotiation(taskId: string, peerId: string, initialBid: string): Negotiation;
  handleCounter(taskId: string, counterOffer: string): NegotiationAction;
  getNegotiation(taskId: string): Negotiation | null;
  getActiveNegotiations(): Negotiation[];
}

export interface NegotiationAction {
  action: "accept" | "counter" | "reject";
  priceXmr?: string;
  reason: string;
}

// ---------------------------------------------------------------------------
// Bidder implementation
// ---------------------------------------------------------------------------

export function createBidder(config: BidConfig): Bidder {
  const activeTasks = new Set<string>();
  const negotiations = new Map<string, Negotiation>();

  return {
    evaluate(task: TaskListing): BidDecision {
      // Check if we have capacity
      if (activeTasks.size >= config.maxConcurrentTasks) {
        return {
          shouldBid: false,
          priceXmr: "0",
          estimatedSeconds: 0,
          confidence: 0,
          reason: "at maximum concurrent task capacity",
        };
      }

      // Check if we have the required capabilities
      const missingSkills = task.requirements.filter(
        (req) => !config.capabilities.includes(req)
      );
      if (missingSkills.length > 0) {
        return {
          shouldBid: false,
          priceXmr: "0",
          estimatedSeconds: 0,
          confidence: 0,
          reason: `missing capabilities: ${missingSkills.join(", ")}`,
        };
      }

      // Check if budget meets our minimum
      const budget = parseFloat(task.budgetXmr);
      const minPrice = parseFloat(config.minPriceXmr);
      if (budget < minPrice) {
        return {
          shouldBid: false,
          priceXmr: "0",
          estimatedSeconds: 0,
          confidence: 0,
          reason: `budget ${task.budgetXmr} below minimum ${config.minPriceXmr}`,
        };
      }

      // Check if deadline is feasible
      const now = Math.floor(Date.now() / 1000);
      if (task.deadline > 0 && task.deadline < now + 60) {
        return {
          shouldBid: false,
          priceXmr: "0",
          estimatedSeconds: 0,
          confidence: 0,
          reason: "deadline too close or already passed",
        };
      }

      // Calculate our bid price
      // Lower reputation = bid lower to be competitive
      // Higher aggressiveness = bid closer to minimum
      const reputationFactor = Math.min(config.reputationScore / 5.0, 1.0);
      const basePrice = budget * (1 - config.aggressiveness * 0.3);
      const adjustedPrice = Math.max(
        basePrice * (0.7 + reputationFactor * 0.3),
        minPrice
      );

      // Estimate duration based on task complexity heuristic
      const complexity = task.requirements.length;
      const estimatedSeconds = 300 * complexity; // ~5 min per requirement

      // Confidence based on our capabilities match and reputation
      const confidence = Math.min(
        0.5 + reputationFactor * 0.4 + (1 - missingSkills.length / Math.max(task.requirements.length, 1)) * 0.1,
        1.0
      );

      return {
        shouldBid: true,
        priceXmr: adjustedPrice.toFixed(6),
        estimatedSeconds,
        confidence,
        reason: "task matches capabilities and pricing thresholds",
      };
    },

    startNegotiation(
      taskId: string,
      peerId: string,
      initialBid: string
    ): Negotiation {
      const negotiation: Negotiation = {
        taskId,
        peerId,
        state: "bid_sent",
        ourBid: initialBid,
        theirOffer: "",
        rounds: 1,
        maxRounds: 5,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      negotiations.set(taskId, negotiation);
      return negotiation;
    },

    handleCounter(taskId: string, counterOffer: string): NegotiationAction {
      const neg = negotiations.get(taskId);
      if (!neg) {
        return { action: "reject", reason: "no active negotiation for this task" };
      }

      neg.theirOffer = counterOffer;
      neg.rounds++;
      neg.updatedAt = Date.now();

      // If we've exceeded max rounds, reject
      if (neg.rounds > neg.maxRounds) {
        neg.state = "rejected";
        return { action: "reject", reason: "exceeded maximum negotiation rounds" };
      }

      const theirPrice = parseFloat(counterOffer);
      const ourPrice = parseFloat(neg.ourBid);
      const minPrice = parseFloat(config.minPriceXmr);

      // Accept if their counter is above our minimum
      if (theirPrice >= minPrice) {
        neg.state = "accepted";
        return { action: "accept", priceXmr: counterOffer, reason: "price acceptable" };
      }

      // Counter with a price between their offer and ours
      const midpoint = (theirPrice + ourPrice) / 2;
      if (midpoint >= minPrice) {
        neg.ourBid = midpoint.toFixed(6);
        neg.state = "counter_sent";
        return {
          action: "counter",
          priceXmr: neg.ourBid,
          reason: "counter-offer at midpoint",
        };
      }

      // Reject if we can't go low enough
      neg.state = "rejected";
      return { action: "reject", reason: "price below our minimum threshold" };
    },

    getNegotiation(taskId: string): Negotiation | null {
      return negotiations.get(taskId) || null;
    },

    getActiveNegotiations(): Negotiation[] {
      return Array.from(negotiations.values()).filter(
        (n) => n.state !== "rejected" && n.state !== "expired" && n.state !== "accepted"
      );
    },
  };
}
