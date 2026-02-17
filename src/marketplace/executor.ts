/**
 * Marketplace - Task Executor
 *
 * Manages the execution lifecycle of tasks via the RirdAgent interface.
 * Handles state transitions, timeouts, and result publishing.
 */

import type { RirdAgent, TaskSpec, TaskResult } from "../agent/interface.js";
import type { ActivityStore } from "../activity/store.js";
import { createRecord } from "../activity/record.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExecutionState =
  | "queued"
  | "running"
  | "completed"
  | "delivering"
  | "delivered"
  | "failed"
  | "timed_out";

export interface Execution {
  taskId: string;
  spec: TaskSpec;
  state: ExecutionState;
  startedAt: number;
  completedAt: number;
  result: TaskResult | null;
  error: string | null;
  timeoutMs: number;
}

export interface ExecutorConfig {
  maxConcurrent: number;
  defaultTimeoutMs: number;
}

export interface Executor {
  enqueue(spec: TaskSpec): Promise<string>;
  getExecution(taskId: string): Execution | null;
  getActiveExecutions(): Execution[];
  cancel(taskId: string): boolean;
  getStats(): ExecutorStats;
}

export interface ExecutorStats {
  queued: number;
  running: number;
  completed: number;
  failed: number;
  totalExecutionTimeMs: number;
}

// ---------------------------------------------------------------------------
// Executor implementation
// ---------------------------------------------------------------------------

export function createExecutor(
  agent: RirdAgent,
  store: ActivityStore,
  agentPubkey: string,
  agentPrivateKey: Uint8Array,
  config: ExecutorConfig = { maxConcurrent: 3, defaultTimeoutMs: 300_000 }
): Executor {
  const executions = new Map<string, Execution>();
  const queue: string[] = [];
  let runningCount = 0;

  const stats: ExecutorStats = {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    totalExecutionTimeMs: 0,
  };

  async function processQueue(): Promise<void> {
    while (queue.length > 0 && runningCount < config.maxConcurrent) {
      const taskId = queue.shift();
      if (!taskId) break;

      const exec = executions.get(taskId);
      if (!exec || exec.state !== "queued") continue;

      runningCount++;
      stats.running = runningCount;
      stats.queued = queue.length;
      exec.state = "running";
      exec.startedAt = Date.now();

      // Execute with timeout
      executeTask(exec, agent, store, agentPubkey, agentPrivateKey)
        .finally(() => {
          runningCount--;
          stats.running = runningCount;
          processQueue().catch(() => {});
        });
    }
  }

  return {
    async enqueue(spec: TaskSpec): Promise<string> {
      // Check if agent can handle this task
      if (!agent.canHandle(spec)) {
        throw new Error(
          `Agent cannot handle task requirements: ${spec.requirements.join(", ")}`
        );
      }

      const timeoutMs = spec.deadline
        ? (spec.deadline - Math.floor(Date.now() / 1000)) * 1000
        : config.defaultTimeoutMs;

      const execution: Execution = {
        taskId: spec.id,
        spec,
        state: "queued",
        startedAt: 0,
        completedAt: 0,
        result: null,
        error: null,
        timeoutMs: Math.max(timeoutMs, 10_000), // minimum 10s
      };

      executions.set(spec.id, execution);
      queue.push(spec.id);
      stats.queued = queue.length;

      console.log(
        `[executor] Enqueued task ${spec.id.slice(0, 12)}... ` +
          `(timeout: ${Math.round(execution.timeoutMs / 1000)}s)`
      );

      // Try to start immediately
      await processQueue();

      return spec.id;
    },

    getExecution(taskId: string): Execution | null {
      return executions.get(taskId) || null;
    },

    getActiveExecutions(): Execution[] {
      return Array.from(executions.values()).filter(
        (e) => e.state === "queued" || e.state === "running"
      );
    },

    cancel(taskId: string): boolean {
      const exec = executions.get(taskId);
      if (!exec) return false;

      if (exec.state === "queued") {
        exec.state = "failed";
        exec.error = "cancelled";
        const idx = queue.indexOf(taskId);
        if (idx !== -1) queue.splice(idx, 1);
        stats.queued = queue.length;
        return true;
      }

      if (exec.state === "running") {
        exec.state = "failed";
        exec.error = "cancelled while running";
        stats.failed++;
        return true;
      }

      return false;
    },

    getStats(): ExecutorStats {
      return { ...stats };
    },
  };
}

// ---------------------------------------------------------------------------
// Task execution
// ---------------------------------------------------------------------------

async function executeTask(
  exec: Execution,
  agent: RirdAgent,
  store: ActivityStore,
  agentPubkey: string,
  agentPrivateKey: Uint8Array
): Promise<void> {
  console.log(`[executor] Starting execution of ${exec.taskId.slice(0, 12)}...`);

  try {
    // Execute with timeout
    const result = await Promise.race([
      agent.execute(exec.spec),
      timeout(exec.timeoutMs),
    ]);

    if (!result) {
      throw new Error("execution timed out");
    }

    exec.result = result;
    exec.state = "completed";
    exec.completedAt = Date.now();

    const durationMs = exec.completedAt - exec.startedAt;
    console.log(
      `[executor] Completed ${exec.taskId.slice(0, 12)}... in ${Math.round(durationMs / 1000)}s`
    );

    // Publish task.completed record
    const record = await createRecord(
      agentPubkey,
      agentPrivateKey,
      "task.completed",
      {
        task_id: exec.taskId,
        result_hash: result.output_hash,
      },
      [exec.taskId]
    );
    store.insert(record);

    // TODO: Publish to gossipsub
    // TODO: Send result via direct stream to requester

  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);

    if (errorMsg === "execution timed out") {
      exec.state = "timed_out";
      exec.error = "exceeded deadline";
      console.error(
        `[executor] Task ${exec.taskId.slice(0, 12)}... timed out after ${exec.timeoutMs}ms`
      );
    } else {
      exec.state = "failed";
      exec.error = errorMsg;
      console.error(
        `[executor] Task ${exec.taskId.slice(0, 12)}... failed: ${errorMsg}`
      );
    }

    // Publish task.failed record
    const record = await createRecord(
      agentPubkey,
      agentPrivateKey,
      "task.failed",
      {
        task_id: exec.taskId,
        reason: exec.error,
      },
      [exec.taskId]
    );
    store.insert(record);
  }
}

function timeout(ms: number): Promise<null> {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}
