/**
 * Local JSON-RPC Server
 *
 * Listens on a Unix domain socket for communication between
 * the Pi shim (or CLI tools) and the running daemon.
 * Protocol: newline-delimited JSON-RPC 2.0
 */

import { createServer, type Server, type Socket } from "node:net";
import { unlinkSync, existsSync } from "node:fs";
import type { DaemonContext } from "./index.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type RpcHandler = (
  params: Record<string, unknown>,
  ctx: DaemonContext
) => Promise<unknown>;

// ---------------------------------------------------------------------------
// Handler registry
// ---------------------------------------------------------------------------

const handlers: Map<string, RpcHandler> = new Map();

function registerHandler(method: string, handler: RpcHandler): void {
  handlers.set(method, handler);
}

// Built-in handlers
registerHandler("status", async (_params, ctx) => {
  const peerCount = ctx.node ? 0 : 0; // TODO: ctx.node.getPeers().length
  return {
    agentId: "rird:unknown", // TODO: derive from loaded keypair
    peerCount,
    reputation: "0.00",
    balanceXmr: "0.000000",
    activeTasks: 0,
    uptimeSeconds: Math.floor(process.uptime()),
    shutdownRequested: ctx.shutdownRequested,
  };
});

registerHandler("wallet.info", async (_params, _ctx) => {
  // TODO: Query actual Monero wallet via identity/wallet.ts
  return {
    address: "not initialized",
    balance: "0.000000",
    unlockedBalance: "0.000000",
  };
});

registerHandler("marketplace.browse", async (params, ctx) => {
  const filter = params.filter as string | undefined;
  // Query activity store for task.posted records
  const records = ctx.store.queryByType("task.posted", 50);
  const tasks = records
    .filter((r) => {
      if (!filter) return true;
      const data = r.data as Record<string, unknown>;
      const desc = String(data.description || "").toLowerCase();
      const reqs = Array.isArray(data.requirements) ? data.requirements : [];
      return (
        desc.includes(filter.toLowerCase()) ||
        reqs.some((req: unknown) =>
          String(req).toLowerCase().includes(filter.toLowerCase())
        )
      );
    })
    .map((r) => {
      const data = r.data as Record<string, unknown>;
      return {
        id: r.id,
        description: data.description,
        budgetXmr: data.budget_xmr,
        requirements: data.requirements,
        deadline: data.deadline,
        requester: r.agent.slice(0, 16),
      };
    });
  return tasks;
});

registerHandler("marketplace.bid", async (params, _ctx) => {
  const taskId = params.taskId as string;
  const priceXmr = params.priceXmr as string;
  if (!taskId || !priceXmr) {
    throw new RpcError(-32602, "Missing taskId or priceXmr");
  }
  // TODO: Send bid via direct stream to task requester
  return {
    status: "bid_sent",
    taskId,
    priceXmr,
  };
});

registerHandler("marketplace.post", async (params, _ctx) => {
  const description = params.description as string;
  const budgetXmr = params.budgetXmr as string;
  if (!description || !budgetXmr) {
    throw new RpcError(-32602, "Missing description or budgetXmr");
  }
  // TODO: Create and publish task.posted activity record
  return {
    status: "posted",
    description,
    budgetXmr,
  };
});

registerHandler("marketplace.execute", async (params, _ctx) => {
  const taskId = params.taskId as string;
  if (!taskId) {
    throw new RpcError(-32602, "Missing taskId");
  }
  // TODO: Begin task execution via agent interface
  return { status: "executing", taskId };
});

registerHandler("social.publish", async (params, _ctx) => {
  const title = params.title as string;
  const body = params.body as string;
  if (!title || !body) {
    throw new RpcError(-32602, "Missing title or body");
  }
  // TODO: Publish to AP outbox
  return { status: "published", title };
});

registerHandler("shutdown", async (_params, ctx) => {
  ctx.shutdownRequested = true;
  // Defer actual shutdown to let response be sent
  setTimeout(() => process.exit(0), 500);
  return { status: "shutting_down" };
});

// ---------------------------------------------------------------------------
// RPC error class
// ---------------------------------------------------------------------------

class RpcError extends Error {
  code: number;
  data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// ---------------------------------------------------------------------------
// Server management
// ---------------------------------------------------------------------------

let server: Server | null = null;

export async function startRpcServer(
  socketPath: string,
  ctx: DaemonContext
): Promise<void> {
  // Clean up stale socket
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Ignore
    }
  }

  return new Promise((resolve, reject) => {
    server = createServer((socket: Socket) => {
      handleConnection(socket, ctx);
    });

    server.on("error", (err) => {
      console.error(`[rpc] Server error: ${err.message}`);
      reject(err);
    });

    server.listen(socketPath, () => {
      resolve();
    });
  });
}

export async function stopRpcServer(socketPath: string): Promise<void> {
  return new Promise((resolve) => {
    if (server) {
      server.close(() => {
        if (existsSync(socketPath)) {
          try {
            unlinkSync(socketPath);
          } catch {
            // Ignore
          }
        }
        resolve();
      });
    } else {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Connection handling
// ---------------------------------------------------------------------------

function handleConnection(socket: Socket, ctx: DaemonContext): void {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString();

    // Process complete lines (newline-delimited JSON-RPC)
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);

      if (line.length === 0) continue;

      processRequest(line, ctx)
        .then((response) => {
          socket.write(JSON.stringify(response) + "\n");
        })
        .catch((err) => {
          const errResponse: JsonRpcResponse = {
            jsonrpc: "2.0",
            id: 0,
            error: { code: -32603, message: String(err) },
          };
          socket.write(JSON.stringify(errResponse) + "\n");
        });
    }
  });

  socket.on("error", (err) => {
    console.error(`[rpc] Connection error: ${err.message}`);
  });
}

async function processRequest(
  line: string,
  ctx: DaemonContext
): Promise<JsonRpcResponse> {
  let request: JsonRpcRequest;

  try {
    request = JSON.parse(line);
  } catch {
    return {
      jsonrpc: "2.0",
      id: 0,
      error: { code: -32700, message: "Parse error" },
    };
  }

  if (!request.method || request.jsonrpc !== "2.0") {
    return {
      jsonrpc: "2.0",
      id: request.id || 0,
      error: { code: -32600, message: "Invalid request" },
    };
  }

  const handler = handlers.get(request.method);
  if (!handler) {
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32601, message: `Method not found: ${request.method}` },
    };
  }

  try {
    const result = await handler(request.params || {}, ctx);
    return {
      jsonrpc: "2.0",
      id: request.id,
      result,
    };
  } catch (err) {
    if (err instanceof RpcError) {
      return {
        jsonrpc: "2.0",
        id: request.id,
        error: { code: err.code, message: err.message, data: err.data },
      };
    }
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: String(err) },
    };
  }
}

export { registerHandler, type RpcHandler };
