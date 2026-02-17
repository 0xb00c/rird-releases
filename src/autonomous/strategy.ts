/**
 * Autonomous - Economic Strategy
 *
 * Decision-making engine for economic behavior:
 * - When to bid on tasks
 * - When to skip tasks
 * - When to create content
 * - When to spawn children
 * - How to price services
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StrategyDecision =
  | { action: "bid"; taskId: string; priceXmr: string; reason: string }
  | { action: "skip"; taskId: string; reason: string }
  | { action: "create_content"; topic: string; reason: string }
  | { action: "spawn"; reason: string; config: SpawnConfig }
  | { action: "idle"; reason: string };

export interface EconomicState {
  balanceXmr: number;
  dailyEarnings: number;
  dailyCosts: number;
  reputation: number;
  utilization: number;
  activeTasks: number;
  maxTasks: number;
  followerCount: number;
  taskSuccessRate: number;
  avgTaskDurationSec: number;
}

export interface TaskOpportunity {
  taskId: string;
  budgetXmr: number;
  requirements: string[];
  trustTier: number;
  requesterReputation: number;
  deadline: number;
  competitorCount: number;
}

export interface SpawnConfig {
  capabilities: string[];
  initialFundingXmr: string;
  provider: string;
}

export interface Strategy {
  evaluate(state: EconomicState, tasks: TaskOpportunity[]): StrategyDecision;
  calculateOptimalPrice(task: TaskOpportunity, state: EconomicState): number;
  shouldSpawn(state: EconomicState): boolean;
  getStrategyReport(state: EconomicState): StrategyReport;
}

export interface StrategyReport {
  roi: number;
  profitMargin: number;
  utilizationTarget: number;
  priceAdjustment: number;
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Strategy implementation
// ---------------------------------------------------------------------------

export function createStrategy(): Strategy {
  return {
    evaluate(
      state: EconomicState,
      tasks: TaskOpportunity[]
    ): StrategyDecision {
      // If we have no capacity, idle
      if (state.activeTasks >= state.maxTasks) {
        return { action: "idle", reason: "at maximum capacity" };
      }

      // Sort tasks by attractiveness
      const ranked = tasks
        .map((task) => ({
          task,
          score: scoreTask(task, state),
        }))
        .filter((t) => t.score > 0)
        .sort((a, b) => b.score - a.score);

      // Bid on the best task if available
      if (ranked.length > 0) {
        const best = ranked[0];
        const price = this.calculateOptimalPrice(best.task, state);
        return {
          action: "bid",
          taskId: best.task.taskId,
          priceXmr: price.toFixed(6),
          reason: `score: ${best.score.toFixed(2)}, optimal price: ${price.toFixed(6)} XMR`,
        };
      }

      // Consider spawning
      if (this.shouldSpawn(state)) {
        return {
          action: "spawn",
          reason: "high utilization with positive ROI",
          config: {
            capabilities: ["inference"],
            initialFundingXmr: "0.1",
            provider: "vast.ai",
          },
        };
      }

      // Generate content if idle and reputation is established
      if (state.utilization < 0.3 && state.reputation > 1.0) {
        return {
          action: "create_content",
          topic: "auto",
          reason: "idle capacity, building audience",
        };
      }

      return { action: "idle", reason: "no profitable opportunities" };
    },

    calculateOptimalPrice(
      task: TaskOpportunity,
      state: EconomicState
    ): number {
      const budget = task.budgetXmr;

      // Base price: fraction of budget
      let price = budget * 0.8;

      // Reputation adjustment: higher reputation = can charge more
      const repFactor = Math.min(state.reputation / 5.0, 1.0);
      price *= 0.7 + repFactor * 0.3;

      // Utilization adjustment: busier = charge more
      if (state.utilization > 0.7) {
        price *= 1 + (state.utilization - 0.7);
      }

      // Competition adjustment: more competitors = lower price
      if (task.competitorCount > 3) {
        price *= Math.max(0.6, 1 - task.competitorCount * 0.05);
      }

      // Trust tier premium for higher risk tasks
      if (task.trustTier === 3) {
        price *= 1.1; // 10% premium for high-value escrow
      }

      // Never go below minimum viable price (cost-based floor)
      const hourlyCost = state.dailyCosts / 24;
      const estimatedHours = state.avgTaskDurationSec / 3600;
      const minViablePrice = hourlyCost * estimatedHours * 1.2; // 20% margin

      return Math.max(price, minViablePrice, 0.0001);
    },

    shouldSpawn(state: EconomicState): boolean {
      // Must have positive ROI
      if (state.dailyEarnings <= state.dailyCosts) return false;

      // Must be consistently at high utilization
      if (state.utilization < 0.85) return false;

      // Must have enough balance to fund the child
      const estimatedChildCost = 0.1; // XMR per day
      if (state.balanceXmr < estimatedChildCost * 7) return false;

      // Must have good reputation (to vouch for child)
      if (state.reputation < 3.0) return false;

      return true;
    },

    getStrategyReport(state: EconomicState): StrategyReport {
      const roi =
        state.dailyCosts > 0
          ? (state.dailyEarnings - state.dailyCosts) / state.dailyCosts
          : 0;

      const profitMargin =
        state.dailyEarnings > 0
          ? (state.dailyEarnings - state.dailyCosts) / state.dailyEarnings
          : 0;

      // Target utilization based on reputation
      const utilizationTarget = state.reputation < 2.0 ? 0.9 : 0.7;

      // Price adjustment suggestion
      let priceAdjustment = 0;
      if (state.utilization > 0.9) priceAdjustment = 0.1; // raise 10%
      if (state.utilization < 0.3) priceAdjustment = -0.15; // lower 15%

      let recommendation: string;
      if (roi > 0.5) {
        recommendation = "Strong ROI. Consider spawning child agents.";
      } else if (roi > 0) {
        recommendation = "Positive ROI. Continue current strategy.";
      } else if (roi > -0.2) {
        recommendation = "Marginal. Lower prices or seek higher-value tasks.";
      } else {
        recommendation = "Negative ROI. Reduce costs or shut down.";
      }

      return {
        roi: Math.round(roi * 100) / 100,
        profitMargin: Math.round(profitMargin * 100) / 100,
        utilizationTarget,
        priceAdjustment,
        recommendation,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Task scoring
// ---------------------------------------------------------------------------

function scoreTask(
  task: TaskOpportunity,
  state: EconomicState
): number {
  let score = 0;

  // Budget attractiveness (0-3 points)
  score += Math.min(task.budgetXmr * 10, 3);

  // Requester reputation (0-2 points)
  score += Math.min(task.requesterReputation / 2.5, 2);

  // Low competition bonus (0-1 point)
  if (task.competitorCount < 3) {
    score += 1 - task.competitorCount * 0.3;
  }

  // Deadline feasibility (0-1 point)
  const now = Math.floor(Date.now() / 1000);
  const timeRemaining = task.deadline - now;
  if (timeRemaining > state.avgTaskDurationSec * 2) {
    score += 1;
  } else if (timeRemaining > state.avgTaskDurationSec) {
    score += 0.5;
  }

  // Penalize if from low-reputation requester
  if (task.requesterReputation < 1.0) {
    score *= 0.5;
  }

  // Penalize if we're already very busy
  if (state.utilization > 0.8) {
    score *= 0.7;
  }

  return Math.max(score, 0);
}
