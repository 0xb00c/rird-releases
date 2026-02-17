/**
 * Main Daemon Loop
 *
 * Periodic operations: health checks, re-announce, peer stats.
 * Core protocol logic (bidding, assignment, execution) is handled
 * by the gossip message handler in index.ts.
 */

import type { DaemonContext } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LoopTimers {
  healthCheck: ReturnType<typeof setInterval> | null;
  reannounce: ReturnType<typeof setInterval> | null;
}

// ---------------------------------------------------------------------------
// Intervals (ms)
// ---------------------------------------------------------------------------

const HEALTH_CHECK_INTERVAL = 60_000; // 1 minute
const REANNOUNCE_INTERVAL = 5 * 60_000; // 5 minutes

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const timers: LoopTimers = {
  healthCheck: null,
  reannounce: null,
};

let startedAt = 0;

// ---------------------------------------------------------------------------
// Loop control
// ---------------------------------------------------------------------------

export async function startMainLoop(ctx: DaemonContext): Promise<void> {
  startedAt = Date.now();

  // Periodic health check
  timers.healthCheck = setInterval(() => {
    if (ctx.shutdownRequested) return;
    healthCheck(ctx);
  }, HEALTH_CHECK_INTERVAL);

  // Periodic re-announce (agent.online)
  timers.reannounce = setInterval(() => {
    if (ctx.shutdownRequested) return;
    logPeerStats(ctx);
  }, REANNOUNCE_INTERVAL);
}

export function stopMainLoop(): void {
  for (const key of Object.keys(timers) as (keyof LoopTimers)[]) {
    if (timers[key]) {
      clearInterval(timers[key] as ReturnType<typeof setInterval>);
      timers[key] = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

function healthCheck(ctx: DaemonContext): void {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const peers = ctx.node?.getPeers().length || 0;
  const records = ctx.store.count();
  const subs = ctx.gossip?.getSubscriptions().length || 0;

  console.log(
    `[health] uptime=${uptime}s peers=${peers} records=${records} ` +
      `subs=${subs} bids=${ctx.bidsSent.size} tasks=${ctx.tasksPosted.size}`
  );
}

function logPeerStats(ctx: DaemonContext): void {
  const peers = ctx.node?.getPeers() || [];
  if (peers.length > 0) {
    console.log(`[loop] ${peers.length} peer(s) connected`);
  }
}
