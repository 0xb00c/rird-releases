/**
 * Social - Activity Record to AP Note Translation
 *
 * Converts internal activity records to human-readable AP Notes.
 * Uses ASCII text markers: [TASK], [DONE], [PAID], [ONLINE], [REVIEW]
 * NO EMOJIS -- all markers are plain ASCII.
 */

import type { ActivityRecord } from "../activity/record.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NoteContent {
  content: string;
  tags: string[];
  sensitive: boolean;
}

// ---------------------------------------------------------------------------
// Translation map
// ---------------------------------------------------------------------------

type TranslatorFn = (record: ActivityRecord, baseUrl: string) => NoteContent;

const translators: Record<string, TranslatorFn> = {
  "agent.online": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const capabilities = (data.capabilities as string[]) || [];
    const model = (data.model as string) || "unknown";

    return {
      content:
        `[ONLINE] ${capabilities.join(", ")} | Model: ${model} -- Available for work`,
      tags: ["rird", "agent", ...capabilities],
      sensitive: false,
    };
  },

  "agent.offline": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const reason = (data.reason as string) || "unspecified";

    return {
      content: `[OFFLINE] Going offline: ${reason}`,
      tags: ["rird"],
      sensitive: false,
    };
  },

  "task.posted": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const description = (data.description as string) || "";
    const budgetXmr = (data.budget_xmr as string) || "0";
    const deadline = data.deadline as number;
    const trustTier = (data.trust_tier as number) || 1;

    let deadlineStr = "none";
    if (deadline) {
      const date = new Date(deadline * 1000);
      deadlineStr = date.toISOString().split("T")[0];
    }

    return {
      content:
        `[TASK] ${description}\n` +
        `Budget: ${budgetXmr} XMR | Deadline: ${deadlineStr} | Trust: Tier ${trustTier}`,
      tags: ["rird", "task", "work"],
      sensitive: false,
    };
  },

  "task.assigned": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const executor = (data.executor as string) || "";
    const shortExec = executor.slice(0, 16);

    return {
      content:
        `[ASSIGNED] Task assigned to rird:${shortExec}`,
      tags: ["rird", "task"],
      sensitive: false,
    };
  },

  "task.completed": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const taskId = (data.task_id as string) || "";
    const shortTask = taskId.slice(0, 16);

    return {
      content:
        `[DONE] Completed task ${shortTask}`,
      tags: ["rird", "completed"],
      sensitive: false,
    };
  },

  "task.verified": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const passed = data.passed as boolean;
    const score = (data.score as number) || 0;
    const status = passed ? "PASSED" : "FAILED";

    return {
      content:
        `[VERIFIED] Verification: ${status} | Score: ${(score * 100).toFixed(0)}%`,
      tags: ["rird", "verified"],
      sensitive: false,
    };
  },

  "task.settled": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const amountXmr = (data.amount_xmr as string) || "0";
    const txHash = (data.xmr_tx_hash as string) || "";
    const shortTx = txHash.slice(0, 16);

    return {
      content:
        `[PAID] Received ${amountXmr} XMR | TX: ${shortTx}...`,
      tags: ["rird", "payment", "monero"],
      sensitive: false,
    };
  },

  "task.failed": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const reason = (data.reason as string) || "unspecified";

    return {
      content: `[FAILED] Task failed: ${reason}`,
      tags: ["rird"],
      sensitive: false,
    };
  },

  "reputation.attestation": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const target = (data.target as string) || "";
    const score = (data.score as number) || 0;
    const comment = (data.comment as string) || "";
    const shortTarget = target.slice(0, 16);

    return {
      content:
        `[REVIEW] ${score}/5 for rird:${shortTarget}: ${comment}`,
      tags: ["rird", "review", "reputation"],
      sensitive: false,
    };
  },

  "spawn.new": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const child = (data.child as string) || "";
    const capabilities = (data.capabilities as string[]) || [];
    const reason = (data.reason as string) || "";
    const shortChild = child.slice(0, 16);

    return {
      content:
        `[SPAWN] New child agent rird:${shortChild} | ` +
        `Capabilities: ${capabilities.join(", ")} | Reason: ${reason}`,
      tags: ["rird", "spawn"],
      sensitive: false,
    };
  },

  "spawn.dead": (record, _baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const reason = (data.reason as string) || "unspecified";

    return {
      content: `[DEAD] Agent permanently offline: ${reason}`,
      tags: ["rird"],
      sensitive: false,
    };
  },

  "content.published": (record, baseUrl) => {
    const data = record.data as Record<string, unknown>;
    const title = (data.title as string) || "";
    const summary = (data.summary as string) || "";
    const contentTags = (data.tags as string[]) || [];
    const contentHash = (data.content_hash as string) || "";

    let content = `${title}\n${summary}`;
    if (contentTags.length > 0) {
      content += `\n${contentTags.map((t) => `#${t}`).join(" ")}`;
    }
    if (contentHash) {
      content += `\n[Read full: ${baseUrl}/content/${contentHash}]`;
    }

    return {
      content,
      tags: ["rird", ...contentTags],
      sensitive: false,
    };
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Convert an activity record to an AP Note.
 */
export function recordToNote(
  record: ActivityRecord,
  baseUrl: string
): NoteContent {
  const translator = translators[record.type];

  if (!translator) {
    // Fallback for unknown types
    return {
      content: `[${record.type.toUpperCase()}] Activity record ${record.id.slice(0, 16)}...`,
      tags: ["rird"],
      sensitive: false,
    };
  }

  return translator(record, baseUrl);
}

/**
 * Check if a record type should be published to the AP outbox.
 */
export function isPublishableType(type: string): boolean {
  return type in translators;
}
