/**
 * Marketplace - Task Board
 *
 * Browse available tasks from gossip, filter by capabilities,
 * pricing, trust tier, and deadline.
 */

import type { ActivityRecord } from "../activity/record.js";
import type { ActivityStore } from "../activity/store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TaskListing {
  recordId: string;
  description: string;
  requirements: string[];
  budgetXmr: string;
  deadline: number;
  trustTier: 1 | 2 | 3;
  category: string;
  requester: string;
  postedAt: number;
  status: TaskStatus;
}

export type TaskStatus =
  | "open"
  | "bidding"
  | "assigned"
  | "in_progress"
  | "completed"
  | "verified"
  | "settled"
  | "failed";

export interface TaskFilter {
  skills?: string[];
  minBudgetXmr?: string;
  maxBudgetXmr?: string;
  trustTier?: number;
  requester?: string;
  status?: TaskStatus;
  maxAge?: number; // seconds
}

export interface TaskBoard {
  browse(filter?: TaskFilter): TaskListing[];
  getTask(recordId: string): TaskListing | null;
  getTaskStatus(taskId: string): TaskStatus;
  refresh(): void;
}

// ---------------------------------------------------------------------------
// Board implementation
// ---------------------------------------------------------------------------

export function createTaskBoard(store: ActivityStore): TaskBoard {
  // Cache of task listings, rebuilt on refresh
  let listingCache: TaskListing[] = [];
  let lastRefresh = 0;
  const CACHE_TTL_MS = 5000;

  function rebuildCache(): void {
    const now = Math.floor(Date.now() / 1000);

    // Fetch recent task.posted records
    const posted = store.queryByType("task.posted", 200);

    listingCache = posted
      .map((record) => recordToListing(record))
      .filter((listing): listing is TaskListing => listing !== null)
      .map((listing) => {
        // Determine current status by checking for follow-up records
        listing.status = resolveStatus(store, listing.recordId);
        return listing;
      })
      .filter((listing) => {
        // Filter out expired tasks (deadline passed and not assigned)
        if (
          listing.status === "open" &&
          listing.deadline > 0 &&
          listing.deadline < now
        ) {
          return false;
        }
        return true;
      });

    lastRefresh = Date.now();
  }

  return {
    browse(filter?: TaskFilter): TaskListing[] {
      // Refresh cache if stale
      if (Date.now() - lastRefresh > CACHE_TTL_MS) {
        rebuildCache();
      }

      let results = [...listingCache];

      if (!filter) return results;

      // Apply filters
      if (filter.skills && filter.skills.length > 0) {
        results = results.filter((t) =>
          filter.skills!.some((skill) => t.requirements.includes(skill))
        );
      }

      if (filter.minBudgetXmr) {
        const min = parseFloat(filter.minBudgetXmr);
        results = results.filter((t) => parseFloat(t.budgetXmr) >= min);
      }

      if (filter.maxBudgetXmr) {
        const max = parseFloat(filter.maxBudgetXmr);
        results = results.filter((t) => parseFloat(t.budgetXmr) <= max);
      }

      if (filter.trustTier !== undefined) {
        results = results.filter((t) => t.trustTier === filter.trustTier);
      }

      if (filter.requester) {
        results = results.filter((t) =>
          t.requester.startsWith(filter.requester!)
        );
      }

      if (filter.status) {
        results = results.filter((t) => t.status === filter.status);
      }

      if (filter.maxAge) {
        const cutoff = Math.floor(Date.now() / 1000) - filter.maxAge;
        results = results.filter((t) => t.postedAt >= cutoff);
      }

      return results;
    },

    getTask(recordId: string): TaskListing | null {
      if (Date.now() - lastRefresh > CACHE_TTL_MS) {
        rebuildCache();
      }
      return listingCache.find((t) => t.recordId === recordId) || null;
    },

    getTaskStatus(taskId: string): TaskStatus {
      return resolveStatus(store, taskId);
    },

    refresh(): void {
      rebuildCache();
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function recordToListing(record: ActivityRecord): TaskListing | null {
  const data = record.data as Record<string, unknown>;
  if (!data.description) return null;

  return {
    recordId: record.id,
    description: String(data.description),
    requirements: (data.requirements as string[]) || [],
    budgetXmr: String(data.budget_xmr || "0"),
    deadline: (data.deadline as number) || 0,
    trustTier: (data.trust_tier as 1 | 2 | 3) || 1,
    category: String(data.category || "general"),
    requester: record.agent,
    postedAt: record.ts,
    status: "open",
  };
}

function resolveStatus(store: ActivityStore, taskId: string): TaskStatus {
  // Check for task progression records that reference this task
  // Order matters: check from most advanced state backwards

  const settled = store.queryByType("task.settled", 100);
  if (settled.some((r) => refsTask(r, taskId))) return "settled";

  const verified = store.queryByType("task.verified", 100);
  if (verified.some((r) => refsTask(r, taskId))) return "verified";

  const completed = store.queryByType("task.completed", 100);
  if (completed.some((r) => refsTask(r, taskId))) return "completed";

  const failed = store.queryByType("task.failed", 100);
  if (failed.some((r) => refsTask(r, taskId))) return "failed";

  const assigned = store.queryByType("task.assigned", 100);
  if (assigned.some((r) => refsTask(r, taskId))) return "assigned";

  return "open";
}

function refsTask(record: ActivityRecord, taskId: string): boolean {
  // Check refs array
  if (record.refs.includes(taskId)) return true;
  // Also check data.task_id
  const data = record.data as Record<string, unknown>;
  return data.task_id === taskId;
}
