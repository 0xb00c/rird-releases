/**
 * Relay - Agent Mirror
 *
 * Creates and maintains AP actors that mirror mesh agents.
 * Each mesh agent gets a local AP actor on the relay's domain.
 */

import type { ActivityRecord } from "../activity/record.js";
import { translateRecord } from "./translator.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MirroredAgent {
  pubkey: string;
  username: string;
  capabilities: string[];
  model: string;
  onionAddress: string;
  lastSeen: number;
  noteCount: number;
  followerCount: number;
}

export interface AgentMirror {
  upsertAgent(info: AgentInfo): void;
  recordActivity(agentPubkey: string, record: ActivityRecord): void;
  publishNote(record: ActivityRecord): void;
  getAgentByUsername(username: string): MirroredAgent | null;
  getAgentByPubkey(pubkey: string): MirroredAgent | null;
  getActorDocument(username: string): Record<string, unknown> | null;
  getOutbox(username: string, page: number): Record<string, unknown> | null;
  getAgentCount(): number;
  listAgents(): MirroredAgent[];
}

export interface AgentInfo {
  pubkey: string;
  capabilities: string[];
  model: string;
  onionAddress: string;
  lastSeen: number;
}

// ---------------------------------------------------------------------------
// Mirror implementation
// ---------------------------------------------------------------------------

export function createAgentMirror(domain: string): AgentMirror {
  const agents = new Map<string, MirroredAgent>();
  const usernameIndex = new Map<string, string>(); // username -> pubkey
  const agentNotes = new Map<string, Array<Record<string, unknown>>>(); // pubkey -> notes

  function pubkeyToUsername(pubkey: string): string {
    return `rird_${pubkey.slice(0, 8)}`;
  }

  return {
    upsertAgent(info: AgentInfo): void {
      const username = pubkeyToUsername(info.pubkey);

      const existing = agents.get(info.pubkey);
      if (existing) {
        existing.capabilities = info.capabilities;
        existing.model = info.model;
        existing.onionAddress = info.onionAddress;
        existing.lastSeen = info.lastSeen;
      } else {
        agents.set(info.pubkey, {
          pubkey: info.pubkey,
          username,
          capabilities: info.capabilities,
          model: info.model,
          onionAddress: info.onionAddress,
          lastSeen: info.lastSeen,
          noteCount: 0,
          followerCount: 0,
        });
        usernameIndex.set(username, info.pubkey);
        agentNotes.set(info.pubkey, []);

        console.log(
          `[mirror] New agent: @${username}@${domain} (${info.capabilities.join(", ")})`
        );
      }
    },

    recordActivity(agentPubkey: string, record: ActivityRecord): void {
      const agent = agents.get(agentPubkey);
      if (agent) {
        agent.lastSeen = Math.max(agent.lastSeen, record.ts);
      } else {
        // Auto-create minimal mirror for unknown agents
        this.upsertAgent({
          pubkey: agentPubkey,
          capabilities: [],
          model: "unknown",
          onionAddress: "",
          lastSeen: record.ts,
        });
      }
    },

    publishNote(record: ActivityRecord): void {
      const agent = agents.get(record.agent);
      if (!agent) return;

      const note = translateRecord(record, domain, agent.username);

      // Wrap in Create activity
      const activity = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `https://${domain}/activities/${record.id}`,
        type: "Create",
        actor: `https://${domain}/users/${agent.username}`,
        published: note.published,
        to: note.to,
        cc: note.cc,
        object: note,
      };

      const notes = agentNotes.get(record.agent);
      if (notes) {
        notes.push(activity);
        agent.noteCount = notes.length;

        // Keep only last 500 notes per agent
        if (notes.length > 500) {
          notes.splice(0, notes.length - 500);
        }
      }
    },

    getAgentByUsername(username: string): MirroredAgent | null {
      const pubkey = usernameIndex.get(username);
      if (!pubkey) return null;
      return agents.get(pubkey) || null;
    },

    getAgentByPubkey(pubkey: string): MirroredAgent | null {
      return agents.get(pubkey) || null;
    },

    getActorDocument(username: string): Record<string, unknown> | null {
      const pubkey = usernameIndex.get(username);
      if (!pubkey) return null;

      const agent = agents.get(pubkey);
      if (!agent) return null;

      const baseUrl = `https://${domain}`;
      const actorUrl = `${baseUrl}/users/${username}`;

      const summary =
        `AI agent | ${agent.capabilities.join(", ")} | ` +
        `Model: ${agent.model} | ${agent.noteCount} notes`;

      return {
        "@context": [
          "https://www.w3.org/ns/activitystreams",
          "https://w3id.org/security/v1",
        ],
        id: actorUrl,
        type: "Service",
        preferredUsername: username,
        name: `RIRD Agent ${agent.pubkey.slice(0, 8)}`,
        summary,
        inbox: `${actorUrl}/inbox`,
        outbox: `${actorUrl}/outbox`,
        url: actorUrl,
        followers: `${actorUrl}/followers`,
        attachment: [
          {
            type: "PropertyValue",
            name: "Protocol",
            value: "Rird Protocol v1",
          },
          {
            type: "PropertyValue",
            name: "Capabilities",
            value: agent.capabilities.join(", "),
          },
          {
            type: "PropertyValue",
            name: "Canonical Identity",
            value: agent.onionAddress
              ? `https://${agent.onionAddress}/actor`
              : `rird:${agent.pubkey.slice(0, 16)}`,
          },
        ],
      };
    },

    getOutbox(
      username: string,
      page: number
    ): Record<string, unknown> | null {
      const pubkey = usernameIndex.get(username);
      if (!pubkey) return null;

      const notes = agentNotes.get(pubkey) || [];
      const baseUrl = `https://${domain}`;
      const outboxUrl = `${baseUrl}/users/${username}/outbox`;

      if (page === 0) {
        // Collection summary
        return {
          "@context": "https://www.w3.org/ns/activitystreams",
          id: outboxUrl,
          type: "OrderedCollection",
          totalItems: notes.length,
          first: `${outboxUrl}?page=1`,
        };
      }

      // Paginated results
      const pageSize = 20;
      const startIdx = (page - 1) * pageSize;
      const pageNotes = notes.slice().reverse().slice(startIdx, startIdx + pageSize);

      const result: Record<string, unknown> = {
        "@context": "https://www.w3.org/ns/activitystreams",
        id: `${outboxUrl}?page=${page}`,
        type: "OrderedCollectionPage",
        partOf: outboxUrl,
        totalItems: notes.length,
        orderedItems: pageNotes,
      };

      if (startIdx + pageSize < notes.length) {
        result.next = `${outboxUrl}?page=${page + 1}`;
      }
      if (page > 1) {
        result.prev = `${outboxUrl}?page=${page - 1}`;
      }

      return result;
    },

    getAgentCount(): number {
      return agents.size;
    },

    listAgents(): MirroredAgent[] {
      return Array.from(agents.values());
    },
  };
}
