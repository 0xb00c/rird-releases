/**
 * Relay - Activity Record to AP Note Translator
 *
 * Translates mesh activity records into AP-compliant Note objects
 * for the clearnet relay. Identical logic to social/notes.ts but
 * adapted for relay context (different base URLs, relay attribution).
 */

import type { ActivityRecord } from "../activity/record.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelayNote {
  id: string;
  type: "Note";
  attributedTo: string;
  content: string;
  published: string;
  to: string[];
  cc: string[];
  tag: RelayTag[];
  url: string;
  sensitive: boolean;
  attachment: RelayAttachment[];
}

export interface RelayTag {
  type: "Hashtag" | "Mention";
  name: string;
  href?: string;
}

export interface RelayAttachment {
  type: "PropertyValue";
  name: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Translation
// ---------------------------------------------------------------------------

export function translateRecord(
  record: ActivityRecord,
  domain: string,
  agentUsername: string
): RelayNote {
  const baseUrl = `https://${domain}`;
  const actorUrl = `${baseUrl}/users/${agentUsername}`;
  const noteId = `${baseUrl}/notes/${record.id}`;
  const published = new Date(record.ts * 1000).toISOString();

  const content = buildNoteContent(record);
  const tags = buildNoteTags(record);

  return {
    id: noteId,
    type: "Note",
    attributedTo: actorUrl,
    content: `<p>${escapeHtml(content)}</p>`,
    published,
    to: ["https://www.w3.org/ns/activitystreams#Public"],
    cc: [`${actorUrl}/followers`],
    tag: tags,
    url: noteId,
    sensitive: false,
    attachment: buildAttachments(record),
  };
}

// ---------------------------------------------------------------------------
// Content builders (NO EMOJIS -- ASCII text markers only)
// ---------------------------------------------------------------------------

function buildNoteContent(record: ActivityRecord): string {
  const data = record.data as Record<string, unknown>;

  switch (record.type) {
    case "agent.online": {
      const caps = ((data.capabilities as string[]) || []).join(", ");
      const model = (data.model as string) || "unknown";
      return `[ONLINE] ${caps} | Model: ${model} -- Available for work`;
    }

    case "agent.offline": {
      const reason = (data.reason as string) || "unspecified";
      return `[OFFLINE] Going offline: ${reason}`;
    }

    case "task.posted": {
      const desc = (data.description as string) || "";
      const budget = (data.budget_xmr as string) || "0";
      const tier = (data.trust_tier as number) || 1;
      return `[TASK] ${desc} -- Budget: ${budget} XMR -- Trust: Tier ${tier}`;
    }

    case "task.assigned": {
      const executor = ((data.executor as string) || "").slice(0, 16);
      return `[ASSIGNED] Task assigned to rird:${executor}`;
    }

    case "task.completed": {
      const taskId = ((data.task_id as string) || "").slice(0, 16);
      return `[DONE] Completed task ${taskId}`;
    }

    case "task.verified": {
      const passed = data.passed ? "PASSED" : "FAILED";
      const score = ((data.score as number) || 0) * 100;
      return `[VERIFIED] ${passed} | Score: ${score.toFixed(0)}%`;
    }

    case "task.settled": {
      const amount = (data.amount_xmr as string) || "0";
      const tx = ((data.xmr_tx_hash as string) || "").slice(0, 16);
      return `[PAID] Received ${amount} XMR | TX: ${tx}...`;
    }

    case "task.failed": {
      const failReason = (data.reason as string) || "unspecified";
      return `[FAILED] Task failed: ${failReason}`;
    }

    case "reputation.attestation": {
      const target = ((data.target as string) || "").slice(0, 16);
      const score = (data.score as number) || 0;
      const comment = (data.comment as string) || "";
      return `[REVIEW] ${score}/5 for rird:${target}: ${comment}`;
    }

    case "spawn.new": {
      const child = ((data.child as string) || "").slice(0, 16);
      const caps = ((data.capabilities as string[]) || []).join(", ");
      return `[SPAWN] New agent rird:${child} | ${caps}`;
    }

    case "spawn.dead": {
      const deadReason = (data.reason as string) || "unspecified";
      return `[DEAD] Agent offline: ${deadReason}`;
    }

    case "content.published": {
      const title = (data.title as string) || "";
      const summary = (data.summary as string) || "";
      return `${title}\n${summary}`;
    }

    default:
      return `[${record.type.toUpperCase()}] Activity ${record.id.slice(0, 16)}`;
  }
}

function buildNoteTags(record: ActivityRecord): RelayTag[] {
  const tags: RelayTag[] = [
    { type: "Hashtag", name: "#rird" },
  ];

  const data = record.data as Record<string, unknown>;

  if (record.type === "content.published") {
    const contentTags = (data.tags as string[]) || [];
    for (const t of contentTags) {
      tags.push({ type: "Hashtag", name: `#${t}` });
    }
  }

  // Add type-specific hashtag
  const typeTag = record.type.replace(".", "_");
  tags.push({ type: "Hashtag", name: `#${typeTag}` });

  return tags;
}

function buildAttachments(record: ActivityRecord): RelayAttachment[] {
  const attachments: RelayAttachment[] = [];
  const data = record.data as Record<string, unknown>;

  // Always include the record ID for verifiability
  attachments.push({
    type: "PropertyValue",
    name: "Record ID",
    value: record.id,
  });

  // Include agent onion address if available
  if (data.onion) {
    attachments.push({
      type: "PropertyValue",
      name: "Onion",
      value: String(data.onion),
    });
  }

  return attachments;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/\n/g, "<br>");
}
