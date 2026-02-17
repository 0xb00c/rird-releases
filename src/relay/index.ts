/**
 * Relay - Entry Point
 *
 * A clearnet relay that bridges the Rird mesh to the fediverse.
 * It connects as a passive libp2p node, reads activity records,
 * and publishes them as AP Notes on a clearnet domain.
 *
 * Usage: npx @rird/network relay --domain relay.example.com --port 8080
 */

import { createNetworkNode, type NetworkNode } from "../network/node.js";
import { createGossipManager } from "../network/gossip.js";
import { createActivityStore } from "../activity/store.js";
import { createMeshListener } from "./mesh-listener.js";
import { createRelayAPServer } from "./ap-server.js";
import { createAgentMirror } from "./agent-mirror.js";
import { TOPICS } from "../network/node.js";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelayConfig {
  domain: string;
  port: number;
  listenPort: number;
  bootstrapPeers: string[];
  dbPath?: string;
}

export interface Relay {
  start(): Promise<void>;
  stop(): Promise<void>;
  getStats(): RelayStats;
}

export interface RelayStats {
  recordsReceived: number;
  agentsMirrored: number;
  notesPublished: number;
  uptime: number;
  peers: number;
}

// ---------------------------------------------------------------------------
// Relay implementation
// ---------------------------------------------------------------------------

export async function createRelay(config: RelayConfig): Promise<Relay> {
  const startTime = Date.now();

  // Initialize storage
  const dbPath =
    config.dbPath ||
    join(homedir(), ".rird", "relay", "activity.db");
  const store = createActivityStore(dbPath);

  // Initialize network node (passive -- does not bid or work)
  let node: NetworkNode | null = null;
  let stats = {
    recordsReceived: 0,
    notesPublished: 0,
  };

  // Initialize agent mirror
  const mirror = createAgentMirror(config.domain);

  return {
    async start(): Promise<void> {
      console.log(`[relay] Starting relay at ${config.domain}:${config.port}`);

      // Start network node
      try {
        node = await createNetworkNode({
          listenPort: config.listenPort,
          enableTor: false, // Relay runs on clearnet
          bootstrapPeers: config.bootstrapPeers,
          enableMdns: true,
        });

        // Set up gossip subscription
        const gossip = createGossipManager(node);
        const listener = createMeshListener(store, mirror, stats);

        // Subscribe to all activity
        gossip.subscribe(TOPICS.ACTIVITY, (record) => {
          listener.onRecord(record);
        });

        console.log("[relay] Connected to mesh, listening for records");
      } catch (err) {
        console.error(`[relay] Failed to connect to mesh: ${err}`);
        console.log("[relay] Running in offline mode (serving cached records)");
      }

      // Start AP HTTP server
      const apServer = createRelayAPServer({
        domain: config.domain,
        port: config.port,
        store,
        mirror,
      });

      await apServer.start();
      console.log(
        `[relay] AP server listening on ${config.domain}:${config.port}`
      );
    },

    async stop(): Promise<void> {
      if (node) {
        await node.stop();
      }
      store.close();
      console.log("[relay] Stopped");
    },

    getStats(): RelayStats {
      return {
        recordsReceived: stats.recordsReceived,
        agentsMirrored: mirror.getAgentCount(),
        notesPublished: stats.notesPublished,
        uptime: Math.floor((Date.now() - startTime) / 1000),
        peers: node?.getPeers().length || 0,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function runRelay(args: string[]): Promise<void> {
  const config: RelayConfig = {
    domain: "localhost",
    port: 8080,
    listenPort: 9001,
    bootstrapPeers: [],
  };

  // Parse CLI args
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--domain" && args[i + 1]) {
      config.domain = args[++i];
    } else if (arg === "--port" && args[i + 1]) {
      config.port = parseInt(args[++i], 10);
    } else if (arg === "--listen-port" && args[i + 1]) {
      config.listenPort = parseInt(args[++i], 10);
    } else if (arg === "--peer" && args[i + 1]) {
      config.bootstrapPeers.push(args[++i]);
    }
  }

  const relay = await createRelay(config);
  await relay.start();

  console.log(`[relay] Relay running. Ctrl+C to stop.`);

  // Graceful shutdown
  process.on("SIGINT", async () => {
    console.log("\n[relay] Shutting down...");
    await relay.stop();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await relay.stop();
    process.exit(0);
  });
}
