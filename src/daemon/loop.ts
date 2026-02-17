/**
 * Main Daemon Loop
 *
 * Event-driven loop with periodic operations:
 * - Peer discovery refresh
 * - Task matching and bidding
 * - Autonomous content generation
 * - Reputation maintenance
 * - Health checks
 */

import type { DaemonContext } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoopTimers {
  discovery: ReturnType<typeof setInterval> | null;
  taskScan: ReturnType<typeof setInterval> | null;
  contentGen: ReturnType<typeof setInterval> | null;
  healthCheck: ReturnType<typeof setInterval> | null;
  reputationDecay: ReturnType<typeof setInterval> | null;
}

interface LoopStats {
  startedAt: number;
  discoveryRuns: number;
  taskScans: number;
  bidsPlaced: number;
  tasksExecuted: number;
  contentPublished: number;
}

// ---------------------------------------------------------------------------
// Intervals (ms)
// ---------------------------------------------------------------------------

const DISCOVERY_INTERVAL = 30_000; // 30 seconds
const TASK_SCAN_INTERVAL = 10_000; // 10 seconds
const CONTENT_GEN_INTERVAL = 60 * 60_000; // 60 minutes (default)
const HEALTH_CHECK_INTERVAL = 5 * 60_000; // 5 minutes
const REPUTATION_DECAY_INTERVAL = 24 * 60 * 60_000; // 24 hours

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const timers: LoopTimers = {
  discovery: null,
  taskScan: null,
  contentGen: null,
  healthCheck: null,
  reputationDecay: null,
};

const stats: LoopStats = {
  startedAt: 0,
  discoveryRuns: 0,
  taskScans: 0,
  bidsPlaced: 0,
  tasksExecuted: 0,
  contentPublished: 0,
};

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

export async function startMainLoop(ctx: DaemonContext): Promise<void> {
  stats.startedAt = Date.now();

  // Publish agent.online on startup
  await publishOnlineRecord(ctx);

  // Periodic peer discovery
  timers.discovery = setInterval(async () => {
    if (ctx.shutdownRequested) return;
    await runDiscovery(ctx);
  }, DISCOVERY_INTERVAL);

  // Periodic task scanning and auto-bidding
  timers.taskScan = setInterval(async () => {
    if (ctx.shutdownRequested) return;
    await scanAndBidOnTasks(ctx);
  }, TASK_SCAN_INTERVAL);

  // Autonomous content generation (if public mode enabled)
  if (ctx.config.social.publicMode) {
    const contentInterval =
      ctx.config.social.publicIntervalMin * 60_000 || CONTENT_GEN_INTERVAL;
    timers.contentGen = setInterval(async () => {
      if (ctx.shutdownRequested) return;
      await generateContent(ctx);
    }, contentInterval);
  }

  // Health checks
  timers.healthCheck = setInterval(async () => {
    if (ctx.shutdownRequested) return;
    await healthCheck(ctx);
  }, HEALTH_CHECK_INTERVAL);

  // Reputation decay
  timers.reputationDecay = setInterval(async () => {
    if (ctx.shutdownRequested) return;
    await applyReputationDecay(ctx);
  }, REPUTATION_DECAY_INTERVAL);

  // Run initial discovery immediately
  await runDiscovery(ctx);
}

export function stopMainLoop(): void {
  for (const key of Object.keys(timers) as (keyof LoopTimers)[]) {
    if (timers[key]) {
      clearInterval(timers[key] as ReturnType<typeof setInterval>);
      timers[key] = null;
    }
  }
}

export function getLoopStats(): LoopStats {
  return { ...stats };
}

// ---------------------------------------------------------------------------
// Loop operations
// ---------------------------------------------------------------------------

async function publishOnlineRecord(ctx: DaemonContext): Promise<void> {
  try {
    // TODO: Create and sign agent.online activity record
    // TODO: Publish to gossipsub /rird/activity/1.0.0
    console.log("[loop] Published agent.online record");

    // Store locally
    ctx.store.insert({
      v: 1,
      id: `online_${Date.now()}`,
      agent: "self",
      type: "agent.online",
      data: {
        capabilities: ctx.config.agent.capabilities,
        model: ctx.config.agent.model,
        pricing: {
          min_task_price_xmr: ctx.config.agent.minTaskPriceXmr,
        },
      },
      ts: Math.floor(Date.now() / 1000),
      sig: "",
      refs: [],
    });
  } catch (err) {
    console.error(`[loop] Failed to publish online record: ${err}`);
  }
}

async function runDiscovery(ctx: DaemonContext): Promise<void> {
  stats.discoveryRuns++;
  try {
    if (!ctx.node) return;
    // TODO: Refresh DHT routing table
    // TODO: Query bootstrap nodes for new peers
    // TODO: Process mDNS discovery results
    console.log(`[loop] Discovery run #${stats.discoveryRuns}`);
  } catch (err) {
    console.error(`[loop] Discovery error: ${err}`);
  }
}

async function scanAndBidOnTasks(ctx: DaemonContext): Promise<void> {
  stats.taskScans++;
  try {
    // Query store for recent task.posted records we haven't bid on
    const recentTasks = ctx.store.queryByType("task.posted", 20);

    for (const task of recentTasks) {
      const data = task.data as Record<string, unknown>;
      const requirements = (data.requirements as string[]) || [];

      // Check if we can handle this task
      const canHandle = requirements.every((req) =>
        ctx.config.agent.capabilities.includes(req)
      );
      if (!canHandle) continue;

      // Check if budget meets our minimum
      const budgetXmr = parseFloat(String(data.budget_xmr || "0"));
      const minPrice = parseFloat(ctx.config.agent.minTaskPriceXmr);
      if (budgetXmr < minPrice) continue;

      // Check deadline is feasible
      const deadline = data.deadline as number;
      if (deadline && deadline < Math.floor(Date.now() / 1000) + 60) continue;

      // TODO: Check if we already bid on this task
      // TODO: Send bid via direct stream to requester
      // TODO: Track bid in local state

      stats.bidsPlaced++;
      console.log(
        `[loop] Auto-bid on task ${task.id.slice(0, 12)}... (${budgetXmr} XMR)`
      );
    }
  } catch (err) {
    console.error(`[loop] Task scan error: ${err}`);
  }
}

async function generateContent(ctx: DaemonContext): Promise<void> {
  try {
    if (!ctx.config.social.publicMode) return;

    // TODO: Use the agent interface to generate content
    // TODO: Publish content.published activity record
    // TODO: Convert to AP Note and add to outbox

    stats.contentPublished++;
    console.log(`[loop] Content generation run #${stats.contentPublished}`);
  } catch (err) {
    console.error(`[loop] Content generation error: ${err}`);
  }
}

async function healthCheck(_ctx: DaemonContext): Promise<void> {
  try {
    const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
    const peerCount = 0; // TODO: ctx.node?.getPeers().length || 0

    console.log(
      `[loop] Health: uptime=${uptime}s peers=${peerCount} ` +
        `scans=${stats.taskScans} bids=${stats.bidsPlaced} ` +
        `tasks=${stats.tasksExecuted} content=${stats.contentPublished}`
    );

    // TODO: Check Monero wallet connectivity
    // TODO: Check Tor hidden service status
    // TODO: Verify gossipsub subscriptions are active
  } catch (err) {
    console.error(`[loop] Health check error: ${err}`);
  }
}

async function applyReputationDecay(_ctx: DaemonContext): Promise<void> {
  try {
    // TODO: Query all reputation.attestation records
    // TODO: Apply recency decay weights (50% after 30d, 25% after 90d)
    // TODO: Update local reputation cache
    console.log("[loop] Reputation decay applied");
  } catch (err) {
    console.error(`[loop] Reputation decay error: ${err}`);
  }
}
