/**
 * Network - Peer Discovery
 *
 * Multi-strategy peer discovery:
 * 1. Bootstrap from IPFS CID peer list
 * 2. Kademlia DHT for distributed routing
 * 3. mDNS for zero-config LAN discovery
 * 4. Gossip-based peer exchange
 */

import type { NetworkNode } from "./node.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PeerInfo {
  peerId: string;
  multiaddrs: string[];
  capabilities: string[];
  lastSeen: number;
  latencyMs: number;
}

export interface DiscoveryConfig {
  bootstrapCid: string;
  extraPeers: string[];
  maxPeers: number;
  refreshIntervalMs: number;
}

interface BootstrapPeerList {
  version: number;
  updated: number;
  peers: Array<{
    peerId: string;
    multiaddrs: string[];
  }>;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const knownPeers = new Map<string, PeerInfo>();
const MAX_PEERS_DEFAULT = 50;

// ---------------------------------------------------------------------------
// Discovery manager
// ---------------------------------------------------------------------------

export function createDiscoveryManager(
  node: NetworkNode,
  config: Partial<DiscoveryConfig> = {}
): DiscoveryManager {
  const maxPeers = config.maxPeers || MAX_PEERS_DEFAULT;

  return {
    async bootstrap(): Promise<number> {
      let discovered = 0;

      // Strategy 1: Fetch peers from IPFS CID
      if (config.bootstrapCid) {
        const peers = await fetchBootstrapPeers(config.bootstrapCid);
        for (const peer of peers) {
          if (knownPeers.size >= maxPeers) break;
          addPeer(peer.peerId, peer.multiaddrs);
          discovered++;
        }
        console.log(
          `[discovery] Bootstrap from CID: ${discovered} peers`
        );
      }

      // Strategy 2: Extra peers from config
      if (config.extraPeers) {
        for (const addr of config.extraPeers) {
          // Parse multiaddr to extract peer ID
          const peerId = extractPeerIdFromMultiaddr(addr);
          if (peerId) {
            addPeer(peerId, [addr]);
            discovered++;
          }
        }
      }

      // Strategy 3: Connect to discovered peers
      for (const [_id, peer] of knownPeers) {
        try {
          await connectToPeer(node, peer);
        } catch (err) {
          console.warn(
            `[discovery] Failed to connect to ${peer.peerId.slice(0, 12)}...: ${err}`
          );
        }
      }

      return discovered;
    },

    async refresh(): Promise<number> {
      let newPeers = 0;

      // Get peers from libp2p's peer store
      const currentPeers = node.getPeers();
      for (const peerId of currentPeers) {
        if (!knownPeers.has(peerId)) {
          addPeer(peerId, []);
          newPeers++;
        } else {
          // Update last seen
          const info = knownPeers.get(peerId)!;
          info.lastSeen = Date.now();
        }
      }

      // Prune stale peers (not seen in 1 hour)
      const staleThreshold = Date.now() - 3600_000;
      for (const [id, peer] of knownPeers) {
        if (peer.lastSeen < staleThreshold) {
          knownPeers.delete(id);
        }
      }

      return newPeers;
    },

    getPeers(): PeerInfo[] {
      return Array.from(knownPeers.values());
    },

    getPeerCount(): number {
      return knownPeers.size;
    },

    addManualPeer(peerId: string, multiaddrs: string[]): void {
      addPeer(peerId, multiaddrs);
    },

    removePeer(peerId: string): void {
      knownPeers.delete(peerId);
    },

    isKnownPeer(peerId: string): boolean {
      return knownPeers.has(peerId);
    },
  };
}

export interface DiscoveryManager {
  bootstrap(): Promise<number>;
  refresh(): Promise<number>;
  getPeers(): PeerInfo[];
  getPeerCount(): number;
  addManualPeer(peerId: string, multiaddrs: string[]): void;
  removePeer(peerId: string): void;
  isKnownPeer(peerId: string): boolean;
}

// ---------------------------------------------------------------------------
// Bootstrap from IPFS
// ---------------------------------------------------------------------------

async function fetchBootstrapPeers(
  cid: string
): Promise<Array<{ peerId: string; multiaddrs: string[] }>> {
  // IPFS gateway URLs to try
  const gateways = [
    `https://ipfs.io/ipfs/${cid}`,
    `https://cloudflare-ipfs.com/ipfs/${cid}`,
    `https://dweb.link/ipfs/${cid}`,
  ];

  for (const url of gateways) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) continue;

      const data = (await response.json()) as BootstrapPeerList;
      if (data.peers && Array.isArray(data.peers)) {
        console.log(
          `[discovery] Fetched ${data.peers.length} bootstrap peers from ${url}`
        );
        return data.peers;
      }
    } catch {
      continue;
    }
  }

  console.warn("[discovery] Failed to fetch bootstrap peers from any IPFS gateway");
  return [];
}

// ---------------------------------------------------------------------------
// Peer management
// ---------------------------------------------------------------------------

function addPeer(peerId: string, multiaddrs: string[]): void {
  const existing = knownPeers.get(peerId);
  if (existing) {
    // Merge multiaddrs
    const allAddrs = new Set([...existing.multiaddrs, ...multiaddrs]);
    existing.multiaddrs = Array.from(allAddrs);
    existing.lastSeen = Date.now();
  } else {
    knownPeers.set(peerId, {
      peerId,
      multiaddrs,
      capabilities: [],
      lastSeen: Date.now(),
      latencyMs: -1,
    });
  }
}

async function connectToPeer(
  _node: NetworkNode,
  _peer: PeerInfo
): Promise<void> {
  // TODO: Use node.libp2p.dial() to connect to peer multiaddrs
  // TODO: Measure latency and update peer info
  // TODO: Exchange capability manifests after connection
}

function extractPeerIdFromMultiaddr(addr: string): string | null {
  // Multiaddr format: /ip4/.../tcp/.../p2p/<peer-id>
  const parts = addr.split("/");
  const p2pIndex = parts.indexOf("p2p");
  if (p2pIndex !== -1 && parts[p2pIndex + 1]) {
    return parts[p2pIndex + 1];
  }
  return null;
}
