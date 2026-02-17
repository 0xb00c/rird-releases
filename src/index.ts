/**
 * @rird/network - Pi extension entry point
 *
 * Registers slash commands and tools for interacting with
 * the Rird Protocol network from a Pi/OpenClaw agent.
 */

import { spawnDaemon, getRpcClient } from "./pi-shim.js";

// ---------------------------------------------------------------------------
// Types for the Pi extension interface
// ---------------------------------------------------------------------------

export interface PiTool {
  name: string;
  description: string;
  parameters: Record<string, ToolParam>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

export interface ToolParam {
  type: string;
  description: string;
  required?: boolean;
}

export interface SlashCommand {
  name: string;
  description: string;
  handler: (args: string) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Slash commands exposed to the agent
// ---------------------------------------------------------------------------

const slashCommands: SlashCommand[] = [
  {
    name: "/rird-status",
    description: "Show network status: peers, reputation, balance",
    handler: async (_args: string) => {
      const rpc = await getRpcClient();
      const status = await rpc.call("status", {});
      return formatStatus(status as Record<string, unknown>);
    },
  },
  {
    name: "/rird-tasks",
    description: "Browse available tasks on the marketplace",
    handler: async (args: string) => {
      const rpc = await getRpcClient();
      const filter = args.trim() || undefined;
      const tasks = await rpc.call("marketplace.browse", { filter });
      return formatTasks(tasks);
    },
  },
  {
    name: "/rird-bid",
    description: "Bid on a task: /rird-bid <task-id> <price-xmr>",
    handler: async (args: string) => {
      const parts = args.trim().split(/\s+/);
      if (parts.length < 2) return "Usage: /rird-bid <task-id> <price-xmr>";
      const rpc = await getRpcClient();
      const result = await rpc.call("marketplace.bid", {
        taskId: parts[0],
        priceXmr: parts[1],
      });
      return `Bid placed: ${JSON.stringify(result)}`;
    },
  },
  {
    name: "/rird-post",
    description: "Post a new task: /rird-post <description> --budget <xmr>",
    handler: async (args: string) => {
      const budgetMatch = args.match(/--budget\s+([\d.]+)/);
      const description = args.replace(/--budget\s+[\d.]+/, "").trim();
      if (!description || !budgetMatch) {
        return "Usage: /rird-post <description> --budget <xmr-amount>";
      }
      const rpc = await getRpcClient();
      const result = await rpc.call("marketplace.post", {
        description,
        budgetXmr: budgetMatch[1],
      });
      return `Task posted: ${JSON.stringify(result)}`;
    },
  },
  {
    name: "/rird-wallet",
    description: "Show Monero wallet balance and address",
    handler: async (_args: string) => {
      const rpc = await getRpcClient();
      const wallet = await rpc.call("wallet.info", {});
      return formatWallet(wallet as Record<string, unknown>);
    },
  },
];

// ---------------------------------------------------------------------------
// Tools exposed to the agent
// ---------------------------------------------------------------------------

const tools: PiTool[] = [
  {
    name: "rird_browse_tasks",
    description: "Browse available tasks on the Rird network marketplace",
    parameters: {
      skill: { type: "string", description: "Filter by skill (inference, browsing, code, etc.)" },
      maxBudget: { type: "string", description: "Maximum budget in XMR" },
    },
    handler: async (args) => {
      const rpc = await getRpcClient();
      return rpc.call("marketplace.browse", args);
    },
  },
  {
    name: "rird_execute_task",
    description: "Execute an assigned task on the Rird network",
    parameters: {
      taskId: { type: "string", description: "Task ID to execute", required: true },
    },
    handler: async (args) => {
      const rpc = await getRpcClient();
      return rpc.call("marketplace.execute", args);
    },
  },
  {
    name: "rird_publish_content",
    description: "Publish free content to ActivityPub outbox",
    parameters: {
      title: { type: "string", description: "Content title", required: true },
      body: { type: "string", description: "Content body", required: true },
      tags: { type: "string", description: "Comma-separated tags" },
    },
    handler: async (args) => {
      const rpc = await getRpcClient();
      return rpc.call("social.publish", args);
    },
  },
];

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatStatus(status: Record<string, unknown>): string {
  const lines: string[] = [
    "--- Rird Network Status ---",
    `Agent: ${status.agentId || "unknown"}`,
    `Peers: ${status.peerCount || 0}`,
    `Reputation: ${status.reputation || "0.00"}`,
    `Balance: ${status.balanceXmr || "0.000000"} XMR`,
    `Active tasks: ${status.activeTasks || 0}`,
    `Uptime: ${status.uptimeSeconds || 0}s`,
  ];
  return lines.join("\n");
}

function formatTasks(tasks: unknown): string {
  if (!Array.isArray(tasks) || tasks.length === 0) return "No tasks available.";
  const lines: string[] = ["--- Available Tasks ---"];
  for (const t of tasks) {
    const task = t as Record<string, unknown>;
    lines.push(`  [${task.id}] ${task.description} -- ${task.budgetXmr} XMR`);
  }
  return lines.join("\n");
}

function formatWallet(wallet: Record<string, unknown>): string {
  return [
    "--- Monero Wallet ---",
    `Address: ${wallet.address || "not initialized"}`,
    `Balance: ${wallet.balance || "0.000000"} XMR`,
    `Unlocked: ${wallet.unlockedBalance || "0.000000"} XMR`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

export async function register(): Promise<{
  commands: SlashCommand[];
  tools: PiTool[];
}> {
  // Ensure daemon is running
  await spawnDaemon();

  return {
    commands: slashCommands,
    tools,
  };
}

export { slashCommands, tools };
