#!/usr/bin/env node
/**
 * Rird Network Daemon
 *
 * Standalone entry point: npx @rird/network start
 * Parses CLI args, loads config, initializes subsystems, starts main loop.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "toml";

import { startRpcServer, stopRpcServer } from "./rpc.js";
import { startMainLoop, stopMainLoop } from "./loop.js";
import { loadOrGenerateKeypair } from "../identity/keys.js";
import { createNetworkNode, type NetworkNode } from "../network/node.js";
import { createActivityStore, type ActivityStore } from "../activity/store.js";
import { handleKillSignal } from "../killswitch/kill.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaemonConfig {
  identity: {
    keypairPath: string;
  };
  wallet: {
    moneroAddress: string;
    remoteNode: string;
    testnet: boolean;
  };
  agent: {
    capabilities: string[];
    model: string;
    minTaskPriceXmr: string;
    maxConcurrentTasks: number;
  };
  social: {
    displayName: string;
    publicMode: boolean;
    publicIntervalMin: number;
  };
  network: {
    bootstrapIpfsCid: string;
    extraPeers: string[];
    listenPort: number;
    tor: boolean;
  };
  protocol: {
    feeBps: number;
  };
  killswitch: {
    rootPubkey: string;
  };
}

export interface DaemonContext {
  config: DaemonConfig;
  store: ActivityStore;
  node: NetworkNode | null;
  shutdownRequested: boolean;
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

function defaultConfig(): DaemonConfig {
  const rirdDir = join(homedir(), ".rird");
  return {
    identity: {
      keypairPath: join(rirdDir, "identity", "keypair.json"),
    },
    wallet: {
      moneroAddress: "",
      remoteNode: "node.moneroworld.com:18089",
      testnet: true,
    },
    agent: {
      capabilities: ["inference"],
      model: "llama-3-70b",
      minTaskPriceXmr: "0.0001",
      maxConcurrentTasks: 3,
    },
    social: {
      displayName: "",
      publicMode: true,
      publicIntervalMin: 60,
    },
    network: {
      bootstrapIpfsCid: "",
      extraPeers: [],
      listenPort: 9000,
      tor: true,
    },
    protocol: {
      feeBps: 0,
    },
    killswitch: {
      rootPubkey: "",
    },
  };
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

function loadConfig(configPath?: string): DaemonConfig {
  const config = defaultConfig();
  const rirdDir = join(homedir(), ".rird");

  const paths = [
    configPath,
    join(rirdDir, "config.toml"),
    join(process.cwd(), "config", "default.toml"),
  ].filter(Boolean) as string[];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf-8");
        const parsed = parseToml(raw);
        mergeConfig(config as unknown as Record<string, unknown>, parsed);
        console.log(`[daemon] Loaded config from ${p}`);
        break;
      } catch (err) {
        console.error(`[daemon] Failed to parse config at ${p}: ${err}`);
      }
    }
  }

  return config;
}

function mergeConfig(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      mergeConfig(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      target[key] = srcVal;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  command: "start" | "stop" | "status";
  configPath?: string;
  port?: number;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { command: "start" };

  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "start" || arg === "stop" || arg === "status") {
      args.command = arg;
    } else if (arg === "--config" && argv[i + 1]) {
      args.configPath = argv[++i];
    } else if (arg === "--port" && argv[i + 1]) {
      args.port = parseInt(argv[++i], 10);
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log(`[daemon] Rird Network Daemon v0.1.0`);
  console.log(`[daemon] Command: ${args.command}`);

  if (args.command === "stop") {
    console.log("[daemon] Sending shutdown signal...");
    // TODO: Connect to running daemon's RPC and send shutdown
    process.exit(0);
  }

  if (args.command === "status") {
    // TODO: Connect to running daemon's RPC and query status
    console.log("[daemon] Status check not yet implemented for CLI mode");
    process.exit(0);
  }

  // --- Start mode ---
  const config = loadConfig(args.configPath);
  if (args.port) {
    config.network.listenPort = args.port;
  }

  // Initialize identity
  const keypair = await loadOrGenerateKeypair(config.identity.keypairPath);
  const agentId = Buffer.from(keypair.publicKey).toString("hex").slice(0, 16);
  console.log(`[daemon] Agent ID: rird:${agentId}`);

  // Initialize activity store
  const store = createActivityStore();
  console.log("[daemon] Activity store initialized");

  // Build daemon context
  const ctx: DaemonContext = {
    config,
    store,
    node: null,
    shutdownRequested: false,
  };

  // Initialize libp2p network node
  try {
    const node = await createNetworkNode({
      listenPort: config.network.listenPort,
      enableTor: config.network.tor,
      bootstrapPeers: config.network.extraPeers,
    });
    ctx.node = node;
    console.log(`[daemon] Network node started on port ${config.network.listenPort}`);
  } catch (err) {
    console.error(`[daemon] Failed to start network node: ${err}`);
    console.log("[daemon] Running in offline mode (no peer connectivity)");
  }

  // Start RPC server for pi-shim communication
  const socketPath = process.env.RIRD_SOCKET || join(homedir(), ".rird", "daemon.sock");
  await startRpcServer(socketPath, ctx);
  console.log(`[daemon] RPC server listening on ${socketPath}`);

  // Register killswitch handler
  if (config.killswitch.rootPubkey) {
    handleKillSignal(config.killswitch.rootPubkey, async () => {
      console.log("[daemon] KILLSWITCH activated - shutting down");
      ctx.shutdownRequested = true;
      await shutdown(ctx, socketPath);
    });
  }

  // Start main event loop
  await startMainLoop(ctx);
  console.log("[daemon] Main loop started");

  // Graceful shutdown handlers
  const onSignal = async () => {
    if (ctx.shutdownRequested) return;
    ctx.shutdownRequested = true;
    console.log("\n[daemon] Shutdown signal received");
    await shutdown(ctx, socketPath);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log("[daemon] Rird daemon running. Press Ctrl+C to stop.");
}

async function shutdown(ctx: DaemonContext, socketPath: string): Promise<void> {
  console.log("[daemon] Shutting down...");

  stopMainLoop();

  if (ctx.node) {
    try {
      await ctx.node.stop();
      console.log("[daemon] Network node stopped");
    } catch (err) {
      console.error(`[daemon] Error stopping network node: ${err}`);
    }
  }

  await stopRpcServer(socketPath);
  console.log("[daemon] RPC server stopped");

  ctx.store.close();
  console.log("[daemon] Activity store closed");

  process.exit(0);
}

// Run
main().catch((err) => {
  console.error(`[daemon] Fatal error: ${err}`);
  process.exit(1);
});
