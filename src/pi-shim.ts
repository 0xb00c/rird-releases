/**
 * Pi Shim - Daemon sidecar management and RPC bridge
 *
 * Spawns the rird-network daemon as a child process and provides
 * an RPC client that communicates over a Unix domain socket.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RIRD_DIR = join(homedir(), ".rird");
const SOCKET_PATH = join(RIRD_DIR, "daemon.sock");
const PID_FILE = join(RIRD_DIR, "daemon.pid");
const RPC_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// Daemon process management
// ---------------------------------------------------------------------------

let daemonProcess: ChildProcess | null = null;

export async function spawnDaemon(): Promise<void> {
  // Check if daemon is already running
  if (await isDaemonRunning()) {
    return;
  }

  await mkdir(RIRD_DIR, { recursive: true });

  // Find the daemon binary/script
  const daemonPath = findDaemonPath();

  daemonProcess = spawn(process.execPath, [daemonPath, "start"], {
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      RIRD_SOCKET: SOCKET_PATH,
    },
  });

  daemonProcess.unref();

  if (daemonProcess.pid) {
    await writeFile(PID_FILE, String(daemonProcess.pid), "utf-8");
  }

  // Wait for socket to become available
  await waitForSocket(SOCKET_PATH, 10_000);
}

export async function stopDaemon(): Promise<void> {
  try {
    const rpc = await getRpcClient();
    await rpc.call("shutdown", {});
  } catch {
    // If RPC fails, try killing the process directly
    if (daemonProcess && !daemonProcess.killed) {
      daemonProcess.kill("SIGTERM");
    } else {
      await killByPidFile();
    }
  }
  daemonProcess = null;
}

async function isDaemonRunning(): Promise<boolean> {
  // Check if socket exists and is responsive
  return new Promise((resolve) => {
    if (!existsSync(SOCKET_PATH)) {
      resolve(false);
      return;
    }

    const socket = connect(SOCKET_PATH);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, 2000);

    socket.on("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function killByPidFile(): Promise<void> {
  try {
    const pidStr = await readFile(PID_FILE, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);
    if (!isNaN(pid)) {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // PID file doesn't exist or process already dead
  }
}

function findDaemonPath(): string {
  // Look for the daemon entry point in known locations
  const candidates = [
    join(__dirname, "daemon", "index.js"),
    join(__dirname, "..", "dist", "daemon", "index.js"),
    join(__dirname, "..", "src", "daemon", "index.ts"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: assume it's installed globally
  return "rird-network";
}

async function waitForSocket(socketPath: string, timeoutMs: number): Promise<void> {
  const start = Date.now();
  const interval = 200;

  while (Date.now() - start < timeoutMs) {
    if (existsSync(socketPath)) {
      const connected = await new Promise<boolean>((resolve) => {
        const socket = connect(socketPath);
        const t = setTimeout(() => {
          socket.destroy();
          resolve(false);
        }, 1000);
        socket.on("connect", () => {
          clearTimeout(t);
          socket.destroy();
          resolve(true);
        });
        socket.on("error", () => {
          clearTimeout(t);
          resolve(false);
        });
      });
      if (connected) return;
    }
    await sleep(interval);
  }

  throw new Error(`Daemon did not start within ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// JSON-RPC Client
// ---------------------------------------------------------------------------

interface RpcResponse {
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class RpcClient {
  private socketPath: string;
  private nextId = 1;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  async call(method: string, params: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const socket: Socket = connect(this.socketPath);
      const requestId = this.nextId++;

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error(`RPC call "${method}" timed out after ${RPC_TIMEOUT_MS}ms`));
      }, RPC_TIMEOUT_MS);

      const request = JSON.stringify({
        jsonrpc: "2.0",
        id: requestId,
        method,
        params,
      });

      let data = "";

      socket.on("data", (chunk) => {
        data += chunk.toString();
        // JSON-RPC messages are newline-delimited
        const newlineIdx = data.indexOf("\n");
        if (newlineIdx !== -1) {
          clearTimeout(timeout);
          const line = data.slice(0, newlineIdx);
          socket.destroy();

          try {
            const response: RpcResponse = JSON.parse(line);
            if (response.error) {
              reject(new Error(`RPC error ${response.error.code}: ${response.error.message}`));
            } else {
              resolve(response.result);
            }
          } catch (err) {
            reject(new Error(`Failed to parse RPC response: ${err}`));
          }
        }
      });

      socket.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(`RPC connection error: ${err.message}`));
      });

      socket.on("connect", () => {
        socket.write(request + "\n");
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Singleton RPC client
// ---------------------------------------------------------------------------

let rpcClient: RpcClient | null = null;

export async function getRpcClient(): Promise<RpcClient> {
  if (!rpcClient) {
    rpcClient = new RpcClient(SOCKET_PATH);
  }
  return rpcClient;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
