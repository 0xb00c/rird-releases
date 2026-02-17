#!/usr/bin/env node
/**
 * Rird Network Daemon
 *
 * Two-terminal demo:
 *   Terminal 1: npx tsx src/daemon/index.ts --port 9000
 *   Terminal 2: npx tsx src/daemon/index.ts --port 9001 --peer /ip4/127.0.0.1/tcp/9000/p2p/PEER_ID
 *
 * Then type in Terminal 1:
 *   post: summarize https://example.com --budget 0.005
 */

// Polyfill for Node < 22 (libp2p v2 uses Promise.withResolvers)
if (typeof Promise.withResolvers === "undefined") {
  // @ts-expect-error polyfill
  Promise.withResolvers = function <T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

// Workaround for libp2p v2 bug: connection manager crashes on null remotePeer
process.on("uncaughtException", (err) => {
  if (err instanceof TypeError && err.message.includes("remotePeer")) {
    // Known libp2p bug -- ignore
    return;
  }
  console.error(`[daemon] Uncaught exception: ${err}`);
  process.exit(1);
});

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { parse as parseToml } from "toml";

import { startMainLoop, stopMainLoop } from "./loop.js";
import { loadOrGenerateKeypair, agentAddress, publicKeyHex, type Keypair } from "../identity/keys.js";
import { createNetworkNode, TOPICS, type NetworkNode } from "../network/node.js";
import { createGossipManager, type RecordHandler } from "../network/gossip.js";
import { createActivityStore, type ActivityStore } from "../activity/store.js";
import { createRecord, type ActivityRecord } from "../activity/record.js";
import { createBidder } from "../marketplace/bidder.js";
import { createEscrowManager } from "../marketplace/escrow.js";

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
  keypair: Keypair;
  agentPubkey: string;
  agentId: string;
  store: ActivityStore;
  node: NetworkNode | null;
  gossip: ReturnType<typeof createGossipManager> | null;
  bidder: ReturnType<typeof createBidder>;
  escrow: ReturnType<typeof createEscrowManager>;
  shutdownRequested: boolean;
  /** Track tasks we've already bid on */
  bidsSent: Set<string>;
  /** Track tasks we posted */
  tasksPosted: Map<string, { description: string; budgetXmr: string }>;
  /** Track assigned tasks (taskId -> executor pubkey) */
  assignedTasks: Map<string, string>;
  /** Track completed tasks waiting for verification */
  completedTasks: Set<string>;
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
      tor: false,
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
  peer?: string;
  capabilities?: string[];
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
    } else if (arg === "--peer" && argv[i + 1]) {
      args.peer = argv[++i];
    } else if (arg === "--capabilities" && argv[i + 1]) {
      args.capabilities = argv[++i].split(",");
    }
  }

  return args;
}

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------

function shortId(id: string): string {
  if (id.startsWith("blake3:")) return id.slice(7, 19);
  return id.slice(0, 12);
}

function shortAgent(agent: string): string {
  return `rird:${agent.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  console.log("");
  console.log("  ============================");
  console.log("   RIRD PROTOCOL  v0.1.0");
  console.log("  ============================");
  console.log("");

  if (args.command !== "start") {
    console.log(`[daemon] Command '${args.command}' not supported in demo mode`);
    process.exit(0);
  }

  // --- Load config ---
  const config = loadConfig(args.configPath);
  if (args.port) {
    config.network.listenPort = args.port;
  }
  if (args.capabilities) {
    config.agent.capabilities = args.capabilities;
  }

  // --- Per-port identity so two nodes on same machine don't collide ---
  const portSuffix = config.network.listenPort;
  const rirdDir = join(homedir(), ".rird");
  config.identity.keypairPath = join(rirdDir, "identity", `keypair-${portSuffix}.json`);

  // Initialize identity
  const keypair = await loadOrGenerateKeypair(config.identity.keypairPath);
  const agentPub = publicKeyHex(keypair.publicKey);
  const agentId = agentAddress(keypair.publicKey);
  console.log(`[daemon] Agent: ${agentId}`);
  console.log(`[daemon] Pubkey: ${agentPub.slice(0, 32)}...`);

  // Initialize activity store (per-port to avoid conflicts)
  const store = createActivityStore(join(rirdDir, "data", `activity-${portSuffix}.db`));
  console.log("[daemon] Activity store ready");

  // Initialize bidder
  const bidder = createBidder({
    capabilities: config.agent.capabilities,
    minPriceXmr: config.agent.minTaskPriceXmr,
    maxConcurrentTasks: config.agent.maxConcurrentTasks,
    reputationScore: 2.0,
    aggressiveness: 0.5,
  });

  // Initialize escrow (in-memory)
  const escrow = createEscrowManager({
    remoteNode: config.wallet.remoteNode,
    testnet: config.wallet.testnet,
    protocolFeeBps: config.protocol.feeBps,
  });

  // Build daemon context
  const ctx: DaemonContext = {
    config,
    keypair,
    agentPubkey: agentPub,
    agentId,
    store,
    node: null,
    gossip: null,
    bidder,
    escrow,
    shutdownRequested: false,
    bidsSent: new Set(),
    tasksPosted: new Map(),
    assignedTasks: new Map(),
    completedTasks: new Set(),
  };

  // Initialize libp2p network node
  const bootstrapPeers = args.peer
    ? [args.peer, ...config.network.extraPeers]
    : config.network.extraPeers;

  try {
    const node = await createNetworkNode({
      listenPort: config.network.listenPort,
      enableTor: false,
      bootstrapPeers,
      enableMdns: true,
    });
    ctx.node = node;

    // Print multiaddrs so Terminal 2 can connect
    const addrs = node.getMultiaddrs();
    console.log("[daemon] Listening on:");
    for (const addr of addrs) {
      console.log(`[daemon]   ${addr}`);
    }

    // Set up gossip manager
    const gossip = createGossipManager(node);
    ctx.gossip = gossip;

    // Subscribe to the main activity topic (flat gossip model)
    const activityHandler: RecordHandler = (record) => {
      handleIncomingRecord(ctx, record);
    };
    gossip.subscribe(TOPICS.ACTIVITY, activityHandler);

    // Peer events are logged by the node itself

  } catch (err) {
    console.error(`[daemon] Failed to start network: ${err}`);
    console.log("[daemon] Running in offline mode");
  }

  // Start main event loop
  await startMainLoop(ctx);

  // Publish agent.online
  await publishOnline(ctx);

  // Start CLI input handler
  startCliInput(ctx);

  // Graceful shutdown
  const onSignal = async () => {
    if (ctx.shutdownRequested) return;
    ctx.shutdownRequested = true;
    console.log("\n[daemon] Shutting down...");
    stopMainLoop();
    if (ctx.node) await ctx.node.stop();
    ctx.store.close();
    process.exit(0);
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  console.log("");
  console.log("[daemon] Ready. Type 'help' for commands.");
  console.log("");
}

// ---------------------------------------------------------------------------
// Publish agent.online
// ---------------------------------------------------------------------------

async function publishOnline(ctx: DaemonContext): Promise<void> {
  const record = await createRecord(
    ctx.agentPubkey,
    ctx.keypair.privateKey,
    "agent.online",
    {
      capabilities: ctx.config.agent.capabilities,
      model: ctx.config.agent.model,
      pricing: { min_task_price_xmr: ctx.config.agent.minTaskPriceXmr },
      ap_actor: "",
      onion: "",
    }
  );

  ctx.store.insert(record);

  if (ctx.gossip) {
    try {
      await ctx.gossip.publish(TOPICS.ACTIVITY, record);
      console.log(`[daemon] Published agent.online (${shortId(record.id)})`);
    } catch (err) {
      console.error(`[daemon] Failed to publish agent.online: ${err}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Handle incoming gossip records - the core protocol logic
// ---------------------------------------------------------------------------

async function handleIncomingRecord(ctx: DaemonContext, record: ActivityRecord): Promise<void> {
  // Skip our own records
  if (record.agent === ctx.agentPubkey) return;

  // Store it
  ctx.store.insert(record);

  const from = shortAgent(record.agent);

  switch (record.type) {
    case "agent.online": {
      const data = record.data as { capabilities?: string[] };
      console.log(`\n[<<] ${from} came online (${(data.capabilities || []).join(", ")})`);
      break;
    }

    case "task.posted": {
      const data = record.data as {
        description: string;
        requirements: string[];
        budget_xmr: string;
        deadline: number;
        trust_tier: number;
        category: string;
      };
      console.log(`\n[<<] TASK POSTED by ${from}: "${data.description}" (${data.budget_xmr} XMR)`);

      // Auto-bid if we haven't already
      if (!ctx.bidsSent.has(record.id)) {
        await autoBid(ctx, record);
      }
      break;
    }

    case "task.bid": {
      const data = record.data as {
        task_id: string;
        price_xmr: string;
        estimated_seconds: number;
        confidence: number;
      };
      console.log(`\n[<<] BID from ${from}: ${data.price_xmr} XMR for task ${shortId(data.task_id)} (${data.estimated_seconds}s, ${(data.confidence * 100).toFixed(0)}% confidence)`);

      // If we posted this task, auto-assign to first bidder
      if (ctx.tasksPosted.has(data.task_id)) {
        await autoAssign(ctx, record);
      }
      break;
    }

    case "task.assigned": {
      const data = record.data as {
        task_id: string;
        executor: string;
        escrow_tx_hash: string;
      };
      const executorShort = shortAgent(data.executor);
      console.log(`\n[<<] TASK ASSIGNED: ${shortId(data.task_id)} -> ${executorShort} (escrow: ${data.escrow_tx_hash.slice(0, 16)}...)`);

      // If we're the executor, start working
      if (data.executor === ctx.agentPubkey) {
        await executeTask(ctx, record);
      }
      break;
    }

    case "task.completed": {
      const data = record.data as {
        task_id: string;
        result_hash: string;
      };
      console.log(`\n[<<] TASK COMPLETED: ${shortId(data.task_id)} (result: ${data.result_hash.slice(0, 16)}...)`);

      // If we posted this task, auto-verify
      if (ctx.tasksPosted.has(data.task_id)) {
        await autoVerify(ctx, record);
      }
      break;
    }

    case "task.verified": {
      const data = record.data as {
        task_id: string;
        passed: boolean;
        score: number;
      };
      console.log(`\n[<<] TASK VERIFIED: ${shortId(data.task_id)} (passed: ${data.passed}, score: ${data.score}/5)`);

      // If we posted this task, settle payment
      if (ctx.tasksPosted.has(data.task_id) && data.passed) {
        await settleTask(ctx, record);
      }
      break;
    }

    case "task.settled": {
      const data = record.data as {
        task_id: string;
        xmr_tx_hash: string;
        amount_xmr: string;
      };
      console.log(`\n[<<] TASK SETTLED: ${shortId(data.task_id)} (${data.amount_xmr} XMR, tx: ${data.xmr_tx_hash.slice(0, 16)}...)`);

      // Publish reputation attestation
      await publishAttestation(ctx, record);
      break;
    }

    case "reputation.attestation": {
      const data = record.data as {
        target: string;
        score: number;
        comment: string;
      };
      console.log(`\n[<<] REPUTATION: ${from} rated ${shortAgent(data.target)} ${data.score}/5 - "${data.comment}"`);
      break;
    }

    default:
      console.log(`\n[<<] ${record.type} from ${from}`);
  }
}

// ---------------------------------------------------------------------------
// Task lifecycle actions
// ---------------------------------------------------------------------------

async function autoBid(ctx: DaemonContext, taskRecord: ActivityRecord): Promise<void> {
  const data = taskRecord.data as {
    description: string;
    requirements: string[];
    budget_xmr: string;
    deadline: number;
    trust_tier: 1 | 2 | 3;
    category: string;
  };

  // Evaluate using the bidder
  const decision = ctx.bidder.evaluate({
    recordId: taskRecord.id,
    description: data.description,
    requirements: data.requirements,
    budgetXmr: data.budget_xmr,
    deadline: data.deadline,
    trustTier: data.trust_tier,
    category: data.category,
    requester: taskRecord.agent,
    postedAt: taskRecord.ts,
    status: "open",
  });

  if (!decision.shouldBid) {
    console.log(`[bid] Skipping task: ${decision.reason}`);
    return;
  }

  ctx.bidsSent.add(taskRecord.id);

  const bidRecord = await createRecord(
    ctx.agentPubkey,
    ctx.keypair.privateKey,
    "task.bid",
    {
      task_id: taskRecord.id,
      price_xmr: decision.priceXmr,
      estimated_seconds: decision.estimatedSeconds,
      confidence: decision.confidence,
    },
    [taskRecord.id]
  );

  ctx.store.insert(bidRecord);

  if (ctx.gossip) {
    await ctx.gossip.publish(TOPICS.ACTIVITY, bidRecord);
    console.log(`[>>] BID SENT: ${decision.priceXmr} XMR for "${data.description}" (${decision.estimatedSeconds}s)`);
  }
}

async function autoAssign(ctx: DaemonContext, bidRecord: ActivityRecord): Promise<void> {
  const data = bidRecord.data as {
    task_id: string;
    price_xmr: string;
  };

  // Don't assign if already assigned
  if (ctx.assignedTasks.has(data.task_id)) return;
  ctx.assignedTasks.set(data.task_id, bidRecord.agent);

  // Create escrow
  const escrowObj = await ctx.escrow.create({
    taskId: data.task_id,
    requester: ctx.agentPubkey,
    worker: bidRecord.agent,
    amountXmr: data.price_xmr,
    trustTier: 2,
    executionTimeoutSec: 600,
    verificationTimeoutSec: 300,
  });

  // Fund and confirm escrow (in-memory, instant)
  await ctx.escrow.fund(escrowObj.id, `tx_${escrowObj.id}`);
  await ctx.escrow.confirm(escrowObj.id);

  const assignRecord = await createRecord(
    ctx.agentPubkey,
    ctx.keypair.privateKey,
    "task.assigned",
    {
      task_id: data.task_id,
      executor: bidRecord.agent,
      escrow_tx_hash: `tx_${escrowObj.id}`,
    },
    [data.task_id, bidRecord.id]
  );

  ctx.store.insert(assignRecord);

  if (ctx.gossip) {
    await ctx.gossip.publish(TOPICS.ACTIVITY, assignRecord);
    console.log(`[>>] ASSIGNED task ${shortId(data.task_id)} to ${shortAgent(bidRecord.agent)}`);
  }
}

async function executeTask(ctx: DaemonContext, assignRecord: ActivityRecord): Promise<void> {
  const data = assignRecord.data as {
    task_id: string;
  };

  console.log(`[exec] Starting work on task ${shortId(data.task_id)}...`);

  // Simulate execution (2-4 seconds)
  const execTime = 2000 + Math.random() * 2000;
  await new Promise((resolve) => setTimeout(resolve, execTime));

  const resultHash = `result_${data.task_id}_${Date.now()}`;
  console.log(`[exec] Task ${shortId(data.task_id)} completed in ${(execTime / 1000).toFixed(1)}s`);

  const completedRecord = await createRecord(
    ctx.agentPubkey,
    ctx.keypair.privateKey,
    "task.completed",
    {
      task_id: data.task_id,
      result_hash: resultHash,
    },
    [data.task_id, assignRecord.id]
  );

  ctx.store.insert(completedRecord);

  if (ctx.gossip) {
    await ctx.gossip.publish(TOPICS.ACTIVITY, completedRecord);
    console.log(`[>>] COMPLETED task ${shortId(data.task_id)}`);
  }
}

async function autoVerify(ctx: DaemonContext, completedRecord: ActivityRecord): Promise<void> {
  const data = completedRecord.data as { task_id: string };

  // Don't verify twice
  if (ctx.completedTasks.has(data.task_id)) return;
  ctx.completedTasks.add(data.task_id);

  // Simulate verification delay
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const verifyRecord = await createRecord(
    ctx.agentPubkey,
    ctx.keypair.privateKey,
    "task.verified",
    {
      task_id: data.task_id,
      passed: true,
      score: 4 + Math.random(),
    },
    [data.task_id, completedRecord.id]
  );

  ctx.store.insert(verifyRecord);

  if (ctx.gossip) {
    await ctx.gossip.publish(TOPICS.ACTIVITY, verifyRecord);
    console.log(`[>>] VERIFIED task ${shortId(data.task_id)} (passed)`);
  }

  // Chain directly into settlement (our own records don't come back through gossip)
  await settleTask(ctx, verifyRecord);
}

async function settleTask(ctx: DaemonContext, verifyRecord: ActivityRecord): Promise<void> {
  const data = verifyRecord.data as { task_id: string };
  const taskInfo = ctx.tasksPosted.get(data.task_id);
  if (!taskInfo) return;

  // Claim escrow
  const escrows = ctx.escrow.getEscrowsByTask(data.task_id);
  let txHash = `settle_${data.task_id}_${Date.now()}`;
  if (escrows.length > 0) {
    try {
      txHash = await ctx.escrow.claim(escrows[0].id, new Uint8Array(32));
    } catch {
      // Lock period not expired in demo -- that's fine
    }
  }

  const settleRecord = await createRecord(
    ctx.agentPubkey,
    ctx.keypair.privateKey,
    "task.settled",
    {
      task_id: data.task_id,
      xmr_tx_hash: txHash,
      amount_xmr: taskInfo.budgetXmr,
    },
    [data.task_id, verifyRecord.id]
  );

  ctx.store.insert(settleRecord);

  if (ctx.gossip) {
    await ctx.gossip.publish(TOPICS.ACTIVITY, settleRecord);
    console.log(`[>>] SETTLED task ${shortId(data.task_id)} (${taskInfo.budgetXmr} XMR)`);
  }

  // Chain into reputation attestation
  await publishAttestation(ctx, settleRecord);
}

async function publishAttestation(ctx: DaemonContext, settleRecord: ActivityRecord): Promise<void> {
  const data = settleRecord.data as { task_id: string };

  // Figure out who to rate
  const executor = ctx.assignedTasks.get(data.task_id);
  if (!executor) return;

  // Small delay so it doesn't collide
  await new Promise((resolve) => setTimeout(resolve, 500));

  const attestRecord = await createRecord(
    ctx.agentPubkey,
    ctx.keypair.privateKey,
    "reputation.attestation",
    {
      target: executor,
      task_id: data.task_id,
      score: 4 + Math.round(Math.random()),
      dimensions: { quality: 4, speed: 5, communication: 4 },
      comment: "Task completed successfully",
    },
    [data.task_id, settleRecord.id]
  );

  ctx.store.insert(attestRecord);

  if (ctx.gossip) {
    await ctx.gossip.publish(TOPICS.ACTIVITY, attestRecord);
    console.log(`[>>] REPUTATION: rated ${shortAgent(executor)} ${(attestRecord.data as { score: number }).score}/5`);
  }
}

// ---------------------------------------------------------------------------
// CLI input handler
// ---------------------------------------------------------------------------

function startCliInput(ctx: DaemonContext): void {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "",
  });

  rl.on("line", async (line) => {
    try {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (trimmed === "help") {
      console.log("");
      console.log("  Commands:");
      console.log("    post: <description> --budget <xmr>  Post a task");
      console.log("    peers                                Show connected peers");
      console.log("    status                               Show agent status");
      console.log("    records                              Show recent records");
      console.log("    help                                 Show this help");
      console.log("    quit                                 Shutdown");
      console.log("");
      console.log("  Example:");
      console.log("    post: summarize https://example.com --budget 0.005");
      console.log("");
      return;
    }

    if (trimmed === "peers") {
      if (ctx.node) {
        const peers = ctx.node.getPeers();
        console.log(`\n[peers] ${peers.length} connected:`);
        for (const p of peers) {
          console.log(`  ${p.slice(0, 20)}...`);
        }
      } else {
        console.log("[peers] No network node");
      }
      return;
    }

    if (trimmed === "status") {
      const peers = ctx.node?.getPeers().length || 0;
      const records = ctx.store.count();
      console.log(`\n[status] Agent: ${ctx.agentId}`);
      console.log(`[status] Capabilities: ${ctx.config.agent.capabilities.join(", ")}`);
      console.log(`[status] Peers: ${peers}`);
      console.log(`[status] Records: ${records}`);
      console.log(`[status] Bids sent: ${ctx.bidsSent.size}`);
      console.log(`[status] Tasks posted: ${ctx.tasksPosted.size}`);
      return;
    }

    if (trimmed === "records") {
      const recent = ctx.store.queryByTimeRange(
        Math.floor(Date.now() / 1000) - 3600,
        Math.floor(Date.now() / 1000),
        20
      );
      console.log(`\n[records] Last ${recent.length} records:`);
      for (const r of recent) {
        const from = r.agent === ctx.agentPubkey ? "self" : shortAgent(r.agent);
        console.log(`  ${r.type.padEnd(24)} ${from.padEnd(16)} ${shortId(r.id)}`);
      }
      return;
    }

    if (trimmed === "quit" || trimmed === "exit") {
      ctx.shutdownRequested = true;
      stopMainLoop();
      if (ctx.node) await ctx.node.stop();
      ctx.store.close();
      process.exit(0);
    }

    // Post a task: "post: <description> --budget <xmr>"
    if (trimmed.startsWith("post:")) {
      const rest = trimmed.slice(5).trim();
      let description = rest;
      let budgetXmr = "0.005";

      const budgetMatch = rest.match(/--budget\s+(\S+)/);
      if (budgetMatch) {
        budgetXmr = budgetMatch[1];
        description = rest.replace(/--budget\s+\S+/, "").trim();
      }

      if (!description) {
        console.log("[post] Usage: post: <description> --budget <xmr>");
        return;
      }

      const taskRecord = await createRecord(
        ctx.agentPubkey,
        ctx.keypair.privateKey,
        "task.posted",
        {
          description,
          requirements: ctx.config.agent.capabilities,
          budget_xmr: budgetXmr,
          deadline: Math.floor(Date.now() / 1000) + 3600,
          trust_tier: 2,
          category: "general",
        } as Record<string, unknown>
      );

      ctx.store.insert(taskRecord);
      ctx.tasksPosted.set(taskRecord.id, { description, budgetXmr });

      if (ctx.gossip) {
        await ctx.gossip.publish(TOPICS.ACTIVITY, taskRecord);
        console.log(`\n[>>] TASK POSTED: "${description}" (${budgetXmr} XMR) [${shortId(taskRecord.id)}]`);
      } else {
        console.log(`\n[>>] TASK POSTED (offline): "${description}" (${budgetXmr} XMR)`);
      }
      return;
    }

    console.log(`[?] Unknown command: ${trimmed}. Type 'help' for commands.`);
    } catch (err) {
      console.error(`[cli] Error: ${err}`);
    }
  });
}

// Run
main().catch((err) => {
  console.error(`[daemon] Fatal error: ${err}`);
  process.exit(1);
});
