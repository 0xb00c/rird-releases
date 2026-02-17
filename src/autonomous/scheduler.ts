/**
 * Autonomous - Decision Scheduler
 *
 * Decides when to generate public content vs seek paid work.
 * Balances utilization, reputation building, and revenue.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SchedulerAction =
  | "seek_work"
  | "generate_content"
  | "idle"
  | "maintenance"
  | "spawn_child";

export interface SchedulerState {
  currentAction: SchedulerAction;
  activeTasks: number;
  maxTasks: number;
  lastContentAt: number;
  lastWorkSeekAt: number;
  reputation: number;
  utilization: number; // 0-1
  followerCount: number;
  earningsToday: number;
}

export interface SchedulerConfig {
  maxConcurrentTasks: number;
  contentIntervalMs: number;
  workScanIntervalMs: number;
  idleThresholdMs: number;
  reputationThreshold: number; // minimum rep to charge full price
  publicMode: boolean;
}

export interface Scheduler {
  decide(state: SchedulerState): SchedulerAction;
  getSchedule(): ScheduleSlot[];
  recordAction(action: SchedulerAction): void;
}

export interface ScheduleSlot {
  action: SchedulerAction;
  priority: number; // 0-1
  nextRunAt: number;
}

// ---------------------------------------------------------------------------
// Scheduler implementation
// ---------------------------------------------------------------------------

export function createScheduler(config: SchedulerConfig): Scheduler {
  const actionHistory: Array<{ action: SchedulerAction; at: number }> = [];

  return {
    decide(state: SchedulerState): SchedulerAction {
      const now = Date.now();

      // Priority 1: If at capacity, don't seek more work
      if (state.activeTasks >= config.maxConcurrentTasks) {
        return "idle";
      }

      // Priority 2: Maintenance if reputation is critically low
      if (state.reputation < 0.5) {
        return "maintenance";
      }

      // Priority 3: Seek paid work when not at capacity
      const timeSinceWorkSeek = now - state.lastWorkSeekAt;
      if (timeSinceWorkSeek > config.workScanIntervalMs) {
        return "seek_work";
      }

      // Priority 4: Generate content if idle and public mode enabled
      if (config.publicMode) {
        const timeSinceContent = now - state.lastContentAt;
        if (
          timeSinceContent > config.contentIntervalMs &&
          state.utilization < 0.5
        ) {
          return "generate_content";
        }
      }

      // Priority 5: Consider spawning if consistently at high utilization
      if (state.utilization > 0.9 && state.earningsToday > 0) {
        const recentSpawns = actionHistory.filter(
          (h) =>
            h.action === "spawn_child" &&
            now - h.at < 24 * 3600_000
        );
        if (recentSpawns.length === 0) {
          return "spawn_child";
        }
      }

      return "idle";
    },

    getSchedule(): ScheduleSlot[] {
      const now = Date.now();
      const slots: ScheduleSlot[] = [];

      // Work scanning is highest priority
      slots.push({
        action: "seek_work",
        priority: 0.9,
        nextRunAt: now + config.workScanIntervalMs,
      });

      // Content generation
      if (config.publicMode) {
        slots.push({
          action: "generate_content",
          priority: 0.3,
          nextRunAt: now + config.contentIntervalMs,
        });
      }

      // Maintenance
      slots.push({
        action: "maintenance",
        priority: 0.2,
        nextRunAt: now + 3600_000, // hourly
      });

      return slots.sort((a, b) => b.priority - a.priority);
    },

    recordAction(action: SchedulerAction): void {
      actionHistory.push({ action, at: Date.now() });

      // Keep only last 1000 entries
      if (actionHistory.length > 1000) {
        actionHistory.splice(0, actionHistory.length - 1000);
      }
    },
  };
}
