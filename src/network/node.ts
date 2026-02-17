/**
 * Network - TCP Gossip Node
 *
 * Simple TCP-based peer-to-peer networking:
 * - Listens for incoming connections
 * - Connects to specified peers
 * - Broadcasts JSON messages to all connected peers
 * - Handles reconnection on disconnect
 *
 * Uses newline-delimited JSON (NDJSON) over TCP.
 */

import { createServer, createConnection, type Socket, type Server } from "node:net";
import { randomBytes } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NetworkNodeConfig {
  listenPort: number;
  enableTor: boolean;
  bootstrapPeers: string[];
  enableMdns?: boolean;
}

export interface NetworkNode {
  nodeId: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getPeers(): string[];
  getMultiaddrs(): string[];
  broadcast(data: unknown): void;
  onMessage(handler: (data: unknown, peerId: string) => void): void;
  onPeerConnect(handler: (peerId: string) => void): void;
  onPeerDisconnect(handler: (peerId: string) => void): void;
}

// ---------------------------------------------------------------------------
// Topic constants (kept for compatibility)
// ---------------------------------------------------------------------------

export const TOPICS = {
  ACTIVITY: "/rird/activity/1.0.0",
  TASKS_INFERENCE: "/rird/tasks/inference",
  TASKS_BROWSING: "/rird/tasks/browsing",
  TASKS_MONITORING: "/rird/tasks/monitoring",
  TASKS_CODE: "/rird/tasks/code",
  TASKS_DATA: "/rird/tasks/data",
  TASKS_GENERAL: "/rird/tasks/general",
} as const;

export type TopicName = (typeof TOPICS)[keyof typeof TOPICS];

// ---------------------------------------------------------------------------
// Peer connection
// ---------------------------------------------------------------------------

interface Peer {
  id: string;
  socket: Socket;
  addr: string;
  buffer: string;
}

// ---------------------------------------------------------------------------
// Node creation
// ---------------------------------------------------------------------------

export async function createNetworkNode(
  config: NetworkNodeConfig
): Promise<NetworkNode> {
  const nodeId = randomBytes(8).toString("hex");
  const peers = new Map<string, Peer>();
  let server: Server | null = null;

  const messageHandlers: Array<(data: unknown, peerId: string) => void> = [];
  const connectHandlers: Array<(peerId: string) => void> = [];
  const disconnectHandlers: Array<(peerId: string) => void> = [];

  function handleSocket(socket: Socket, remoteAddr: string, isDialer: boolean): void {
    const peer: Peer = {
      id: "",
      socket,
      addr: remoteAddr,
      buffer: "",
    };
    let handshakeSent = false;

    socket.setEncoding("utf-8");

    socket.on("data", (chunk: string) => {
      peer.buffer += chunk;
      const lines = peer.buffer.split("\n");
      peer.buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);

          // Handle handshake (only process once per peer)
          if (msg._type === "handshake" && !peer.id) {
            peer.id = msg.nodeId;

            // Avoid duplicate connections to same node
            if (peers.has(peer.id)) {
              socket.destroy();
              return;
            }

            peers.set(peer.id, peer);
            console.log(`[network] >>> Peer connected: ${peer.id.slice(0, 12)}... (${remoteAddr})`);
            for (const h of connectHandlers) h(peer.id);

            // Reply with our handshake if we haven't sent one yet
            if (!handshakeSent) {
              handshakeSent = true;
              const reply = JSON.stringify({ _type: "handshake", nodeId }) + "\n";
              socket.write(reply);
            }
            continue;
          }

          // Skip handshake messages if already connected
          if (msg._type === "handshake") continue;

          // Route message to handlers
          if (peer.id) {
            for (const h of messageHandlers) {
              try {
                h(msg, peer.id);
              } catch (err) {
                console.error(`[network] Handler error: ${err}`);
              }
            }
          }
        } catch {
          // Ignore parse errors
        }
      }
    });

    socket.on("close", () => {
      if (peer.id) {
        peers.delete(peer.id);
        console.log(`[network] <<< Peer disconnected: ${peer.id.slice(0, 12)}...`);
        for (const h of disconnectHandlers) h(peer.id);
      }
    });

    socket.on("error", () => {
      if (peer.id) {
        peers.delete(peer.id);
      }
    });

    // If we're the dialer, send handshake first
    if (isDialer) {
      handshakeSent = true;
      const handshake = JSON.stringify({ _type: "handshake", nodeId }) + "\n";
      socket.write(handshake);
    }
  }

  // Start TCP server
  await new Promise<void>((resolve, reject) => {
    server = createServer((socket) => {
      const addr = `${socket.remoteAddress}:${socket.remotePort}`;
      handleSocket(socket, addr, false);
    });

    server.on("error", reject);
    server.listen(config.listenPort, "0.0.0.0", () => {
      console.log(`[network] Listening on port ${config.listenPort} (node: ${nodeId.slice(0, 12)}...)`);
      resolve();
    });
  });

  // Connect to bootstrap peers
  for (const peerAddr of config.bootstrapPeers) {
    if (!peerAddr) continue;

    // Parse address: host:port or /ip4/host/tcp/port format
    let host: string;
    let port: number;

    const multiMatch = peerAddr.match(/\/ip4\/([^/]+)\/tcp\/(\d+)/);
    if (multiMatch) {
      host = multiMatch[1];
      port = parseInt(multiMatch[2], 10);
    } else {
      const parts = peerAddr.split(":");
      host = parts[0];
      port = parseInt(parts[1], 10);
    }

    if (!host || !port) {
      console.warn(`[network] Invalid peer address: ${peerAddr}`);
      continue;
    }

    try {
      const socket = createConnection({ host, port }, () => {
        handleSocket(socket, `${host}:${port}`, true);
      });
      socket.on("error", (err) => {
        console.warn(`[network] Failed to connect to ${host}:${port}: ${err.message}`);
      });
    } catch (err) {
      console.warn(`[network] Connection error: ${err}`);
    }
  }

  return {
    nodeId,

    async start() {
      // Already started
    },

    async stop() {
      for (const peer of peers.values()) {
        peer.socket.destroy();
      }
      peers.clear();
      if (server) {
        server.close();
      }
      console.log("[network] Node stopped");
    },

    getPeers(): string[] {
      return Array.from(peers.keys());
    },

    getMultiaddrs(): string[] {
      return [`/ip4/127.0.0.1/tcp/${config.listenPort}/node/${nodeId}`];
    },

    broadcast(data: unknown): void {
      const msg = JSON.stringify(data) + "\n";
      for (const peer of peers.values()) {
        try {
          peer.socket.write(msg);
        } catch {
          // Peer might be disconnecting
        }
      }
    },

    onMessage(handler: (data: unknown, peerId: string) => void): void {
      messageHandlers.push(handler);
    },

    onPeerConnect(handler: (peerId: string) => void): void {
      connectHandlers.push(handler);
    },

    onPeerDisconnect(handler: (peerId: string) => void): void {
      disconnectHandlers.push(handler);
    },
  };
}

// ---------------------------------------------------------------------------
// Topic helpers (kept for compatibility)
// ---------------------------------------------------------------------------

export function topicForSkill(skill: string): TopicName {
  const map: Record<string, TopicName> = {
    inference: TOPICS.TASKS_INFERENCE,
    browsing: TOPICS.TASKS_BROWSING,
    monitoring: TOPICS.TASKS_MONITORING,
    code: TOPICS.TASKS_CODE,
    data: TOPICS.TASKS_DATA,
  };
  return map[skill] || TOPICS.TASKS_GENERAL;
}

export function topicsForCapabilities(capabilities: string[]): TopicName[] {
  const topics = new Set<TopicName>();
  topics.add(TOPICS.ACTIVITY);
  topics.add(TOPICS.TASKS_GENERAL);

  for (const cap of capabilities) {
    topics.add(topicForSkill(cap));
  }

  return Array.from(topics);
}
