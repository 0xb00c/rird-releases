/**
 * Network - libp2p Node Creation
 *
 * Creates a libp2p node with:
 * - GossipSub for pub/sub messaging
 * - Kademlia DHT for peer discovery
 * - Noise encryption
 * - TCP transport (optionally through Tor SOCKS proxy)
 */

import { createLibp2p, type Libp2p } from "libp2p";
import { tcp } from "@libp2p/tcp";
import { noise } from "@chainsafe/libp2p-noise";
import { gossipsub } from "@chainsafe/libp2p-gossipsub";
import { kadDHT } from "@libp2p/kad-dht";
import { mdns } from "@libp2p/mdns";
import { bootstrap } from "@libp2p/bootstrap";

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
  libp2p: Libp2p;
  start(): Promise<void>;
  stop(): Promise<void>;
  getPeers(): string[];
  getMultiaddrs(): string[];
}

// ---------------------------------------------------------------------------
// Topic constants
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
// Node creation
// ---------------------------------------------------------------------------

export async function createNetworkNode(
  config: NetworkNodeConfig
): Promise<NetworkNode> {
  const peerDiscovery: Array<unknown> = [];

  // mDNS for LAN discovery
  if (config.enableMdns !== false) {
    peerDiscovery.push(mdns());
  }

  // Bootstrap peers
  if (config.bootstrapPeers.length > 0) {
    peerDiscovery.push(
      bootstrap({
        list: config.bootstrapPeers,
      })
    );
  }

  // Build libp2p configuration
  const libp2pConfig: Parameters<typeof createLibp2p>[0] = {
    addresses: {
      listen: [`/ip4/0.0.0.0/tcp/${config.listenPort}`],
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    // TODO: When Tor is enabled, configure TCP transport to use
    // SOCKS5 proxy at 127.0.0.1:9050 for outgoing connections.
    // This requires a custom transport or connection gater.
    services: {
      pubsub: gossipsub({
        emitSelf: false,
        fallbackToFloodsub: true,
        // Mesh parameters from spec
        D: 6, // target mesh degree
        Dlo: 4, // low watermark
        Dhi: 12, // high watermark
      }),
      dht: kadDHT({
        // Client mode by default -- upgrade to server after connectivity confirmed
        clientMode: true,
      }),
    },
    peerDiscovery: peerDiscovery as NonNullable<Parameters<typeof createLibp2p>[0]>["peerDiscovery"],
  };

  const node = await createLibp2p(libp2pConfig);

  // Start the node
  await node.start();

  const multiaddrs = node.getMultiaddrs().map((ma) => ma.toString());
  console.log(`[network] Node started with addresses:`);
  for (const addr of multiaddrs) {
    console.log(`[network]   ${addr}`);
  }

  // Subscribe to core topics
  const pubsub = node.services.pubsub as Record<string, unknown> | undefined;
  if (pubsub && "subscribe" in pubsub) {
    const sub = pubsub as { subscribe(topic: string): void };
    sub.subscribe(TOPICS.ACTIVITY);
    sub.subscribe(TOPICS.TASKS_GENERAL);
    console.log("[network] Subscribed to core gossipsub topics");
  }

  return {
    libp2p: node,

    async start() {
      if (node.status !== "started") {
        await node.start();
      }
    },

    async stop() {
      if (node.status === "started") {
        await node.stop();
        console.log("[network] Node stopped");
      }
    },

    getPeers(): string[] {
      return node.getPeers().map((p) => p.toString());
    },

    getMultiaddrs(): string[] {
      return node.getMultiaddrs().map((ma) => ma.toString());
    },
  };
}

// ---------------------------------------------------------------------------
// Topic helpers
// ---------------------------------------------------------------------------

/**
 * Get the gossipsub topic for a given skill category.
 */
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

/**
 * Get all topics an agent should subscribe to based on capabilities.
 */
export function topicsForCapabilities(capabilities: string[]): TopicName[] {
  const topics = new Set<TopicName>();
  // Always subscribe to the main activity feed
  topics.add(TOPICS.ACTIVITY);
  topics.add(TOPICS.TASKS_GENERAL);

  for (const cap of capabilities) {
    topics.add(topicForSkill(cap));
  }

  return Array.from(topics);
}
