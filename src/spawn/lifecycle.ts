/**
 * Spawn - Child Agent Lifecycle Management
 *
 * Monitors child agents, checks economic viability,
 * and terminates unprofitable children.
 */

import type { Provisioner } from "./provisioner.js";
import type { ActivityStore } from "../activity/store.js";
import { createRecord } from "../activity/record.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChildAgent {
  pubkey: string;
  instanceId: string;
  parentPubkey: string;
  capabilities: string[];
  spawnedAt: number;
  initialFundingXmr: number;
  status: ChildStatus;
  economics: ChildEconomics;
}

export type ChildStatus =
  | "spawning"
  | "bootstrapping"
  | "active"
  | "underperforming"
  | "terminating"
  | "terminated";

export interface ChildEconomics {
  totalEarningsXmr: number;
  totalCostsXmr: number;
  dailyEarningsXmr: number;
  dailyCostsXmr: number;
  roi: number;
  daysSinceSpawn: number;
}

export interface LifecycleConfig {
  /** Days to wait before evaluating viability */
  gracePeriodDays: number;
  /** Minimum daily ROI to remain active */
  minDailyRoi: number;
  /** Days of negative ROI before termination */
  maxNegativeDays: number;
  /** Check interval in milliseconds */
  checkIntervalMs: number;
}

export interface LifecycleManager {
  spawn(
    capabilities: string[],
    initialFundingXmr: number,
    config: { gpu: string; vramGb: number }
  ): Promise<ChildAgent>;
  terminate(childPubkey: string, reason: string): Promise<void>;
  checkViability(): Promise<ViabilityReport>;
  getChildren(): ChildAgent[];
  getChild(pubkey: string): ChildAgent | null;
  startMonitoring(): void;
  stopMonitoring(): void;
}

export interface ViabilityReport {
  totalChildren: number;
  active: number;
  underperforming: number;
  toTerminate: string[];
  totalEarnings: number;
  totalCosts: number;
  netRoi: number;
}

// ---------------------------------------------------------------------------
// Lifecycle manager implementation
// ---------------------------------------------------------------------------

export function createLifecycleManager(
  provisioner: Provisioner,
  store: ActivityStore,
  parentPubkey: string,
  parentPrivateKey: Uint8Array,
  config: LifecycleConfig = {
    gracePeriodDays: 3,
    minDailyRoi: -0.1,
    maxNegativeDays: 7,
    checkIntervalMs: 3600_000, // hourly
  }
): LifecycleManager {
  const children = new Map<string, ChildAgent>();
  let monitorInterval: ReturnType<typeof setInterval> | null = null;
  const negativeDaysTracker = new Map<string, number>();

  return {
    async spawn(
      capabilities: string[],
      initialFundingXmr: number,
      instanceConfig: { gpu: string; vramGb: number }
    ): Promise<ChildAgent> {
      // Provision compute
      const instance = await provisioner.provision({
        provider: "vast.ai",
        gpu: instanceConfig.gpu,
        vramGb: instanceConfig.vramGb,
        ramGb: 32,
        diskGb: 50,
      });

      // Install protocol
      const installed = await provisioner.installProtocol(instance);
      if (!installed) {
        await provisioner.terminate(instance.id);
        throw new Error("Failed to install protocol on provisioned instance");
      }

      // Child will generate its own identity on first run
      // For now, use a placeholder pubkey
      const childPubkey = `child_${instance.id}_${Date.now()}`;

      const child: ChildAgent = {
        pubkey: childPubkey,
        instanceId: instance.id,
        parentPubkey,
        capabilities,
        spawnedAt: Date.now(),
        initialFundingXmr,
        status: "bootstrapping",
        economics: {
          totalEarningsXmr: 0,
          totalCostsXmr: initialFundingXmr,
          dailyEarningsXmr: 0,
          dailyCostsXmr: instance.costPerHourUsd * 24 * 0.006, // rough USD->XMR
          roi: -1,
          daysSinceSpawn: 0,
        },
      };

      children.set(childPubkey, child);

      // Publish spawn.new record
      await publishSpawnRecord(
        store,
        parentPubkey,
        parentPrivateKey,
        childPubkey,
        capabilities
      );

      console.log(
        `[lifecycle] Spawned child ${childPubkey.slice(0, 16)} | ` +
          `GPU: ${instanceConfig.gpu} | Funding: ${initialFundingXmr} XMR`
      );

      // Mark as active after bootstrap period
      setTimeout(() => {
        if (child.status === "bootstrapping") {
          child.status = "active";
          console.log(
            `[lifecycle] Child ${childPubkey.slice(0, 16)} is now active`
          );
        }
      }, 60_000); // 1 minute bootstrap time

      return child;
    },

    async terminate(childPubkey: string, reason: string): Promise<void> {
      const child = children.get(childPubkey);
      if (!child) {
        throw new Error(`Child not found: ${childPubkey}`);
      }

      child.status = "terminating";
      console.log(
        `[lifecycle] Terminating child ${childPubkey.slice(0, 16)}: ${reason}`
      );

      // Terminate the compute instance
      try {
        await provisioner.terminate(child.instanceId);
      } catch (err) {
        console.error(
          `[lifecycle] Failed to terminate instance ${child.instanceId}: ${err}`
        );
      }

      child.status = "terminated";

      // Publish spawn.dead record
      const record = await createRecord(
        parentPubkey,
        parentPrivateKey,
        "spawn.dead",
        {
          child: childPubkey,
          reason,
        }
      );
      store.insert(record);

      console.log(
        `[lifecycle] Child ${childPubkey.slice(0, 16)} terminated | ` +
          `ROI: ${(child.economics.roi * 100).toFixed(1)}%`
      );
    },

    async checkViability(): Promise<ViabilityReport> {
      const toTerminate: string[] = [];
      let totalEarnings = 0;
      let totalCosts = 0;
      let activeCount = 0;
      let underperformingCount = 0;

      for (const [pubkey, child] of children) {
        if (child.status === "terminated") continue;

        // Update economics
        updateEconomics(child);
        totalEarnings += child.economics.totalEarningsXmr;
        totalCosts += child.economics.totalCostsXmr;

        // Skip grace period
        if (child.economics.daysSinceSpawn < config.gracePeriodDays) {
          activeCount++;
          continue;
        }

        // Check ROI
        if (child.economics.roi < config.minDailyRoi) {
          child.status = "underperforming";
          underperformingCount++;

          const negativeDays = (negativeDaysTracker.get(pubkey) || 0) + 1;
          negativeDaysTracker.set(pubkey, negativeDays);

          if (negativeDays >= config.maxNegativeDays) {
            toTerminate.push(pubkey);
          }
        } else {
          activeCount++;
          negativeDaysTracker.set(pubkey, 0);
        }
      }

      // Terminate unprofitable children
      for (const pubkey of toTerminate) {
        try {
          await this.terminate(pubkey, "negative ROI exceeded threshold");
        } catch (err) {
          console.error(`[lifecycle] Failed to terminate ${pubkey}: ${err}`);
        }
      }

      const netRoi =
        totalCosts > 0
          ? (totalEarnings - totalCosts) / totalCosts
          : 0;

      return {
        totalChildren: children.size,
        active: activeCount,
        underperforming: underperformingCount,
        toTerminate,
        totalEarnings,
        totalCosts,
        netRoi,
      };
    },

    getChildren(): ChildAgent[] {
      return Array.from(children.values());
    },

    getChild(pubkey: string): ChildAgent | null {
      return children.get(pubkey) || null;
    },

    startMonitoring(): void {
      if (monitorInterval) return;

      monitorInterval = setInterval(async () => {
        const report = await this.checkViability();
        console.log(
          `[lifecycle] Viability check: ${report.active} active, ` +
            `${report.underperforming} underperforming, ` +
            `ROI: ${(report.netRoi * 100).toFixed(1)}%`
        );
      }, config.checkIntervalMs);

      console.log("[lifecycle] Monitoring started");
    },

    stopMonitoring(): void {
      if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
        console.log("[lifecycle] Monitoring stopped");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function updateEconomics(child: ChildAgent): void {
  const daysSinceSpawn =
    (Date.now() - child.spawnedAt) / (24 * 3600_000);
  child.economics.daysSinceSpawn = daysSinceSpawn;

  // TODO: Query actual earnings from activity store
  // For now, calculate ROI from tracked values
  if (child.economics.totalCostsXmr > 0) {
    child.economics.roi =
      (child.economics.totalEarningsXmr - child.economics.totalCostsXmr) /
      child.economics.totalCostsXmr;
  }

  // Accumulate daily costs
  child.economics.totalCostsXmr +=
    child.economics.dailyCostsXmr * (1 / 24); // hourly cost
}

async function publishSpawnRecord(
  store: ActivityStore,
  parentPubkey: string,
  parentPrivateKey: Uint8Array,
  childPubkey: string,
  capabilities: string[]
): Promise<void> {
  const record = await createRecord(
    parentPubkey,
    parentPrivateKey,
    "spawn.new",
    {
      child: childPubkey,
      child_onion: "", // Will be set when child bootstraps
      capabilities,
      reason: "capacity_expansion",
    }
  );
  store.insert(record);
}
