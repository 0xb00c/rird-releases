/**
 * Network - Tor Integration
 *
 * Manages a Tor subprocess for:
 * - SOCKS5 proxy for outgoing connections
 * - Hidden service creation for AP endpoint hosting
 * - .onion address generation and persistence
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TorConfig {
  socksPort: number;
  controlPort: number;
  hiddenServicePort: number;
  dataDir: string;
}

export interface TorManager {
  start(): Promise<string>; // returns .onion address
  stop(): Promise<void>;
  getOnionAddress(): string | null;
  getSocksPort(): number;
  isRunning(): boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SOCKS_PORT = 9050;
const DEFAULT_CONTROL_PORT = 9051;
const DEFAULT_HS_PORT = 8080;
const TOR_DATA_DIR = join(homedir(), ".rird", "tor");
const ONION_DIR = join(homedir(), ".rird", "identity", "onion");

// ---------------------------------------------------------------------------
// Tor manager
// ---------------------------------------------------------------------------

export function createTorManager(
  config: Partial<TorConfig> = {}
): TorManager {
  const socksPort = config.socksPort || DEFAULT_SOCKS_PORT;
  const controlPort = config.controlPort || DEFAULT_CONTROL_PORT;
  const hsPort = config.hiddenServicePort || DEFAULT_HS_PORT;
  const dataDir = config.dataDir || TOR_DATA_DIR;

  let torProcess: ChildProcess | null = null;
  let onionAddress: string | null = null;

  return {
    async start(): Promise<string> {
      // Ensure directories exist
      await mkdir(dataDir, { recursive: true });
      await mkdir(ONION_DIR, { recursive: true });

      // Check for existing .onion address
      const existingOnion = await loadOnionAddress();
      if (existingOnion) {
        onionAddress = existingOnion;
        console.log(`[tor] Loaded existing onion: ${onionAddress}`);
      }

      // Generate torrc
      const torrcPath = join(dataDir, "torrc");
      const torrc = generateTorrc(socksPort, controlPort, hsPort, dataDir);
      await writeFile(torrcPath, torrc, "utf-8");

      // Start Tor process
      return new Promise((resolve, reject) => {
        torProcess = spawn("tor", ["-f", torrcPath], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let started = false;
        const timeout = setTimeout(() => {
          if (!started) {
            reject(new Error("Tor failed to start within 60 seconds"));
          }
        }, 60_000);

        torProcess.stdout?.on("data", (data: Buffer) => {
          const line = data.toString();

          // Look for the bootstrapped message
          if (line.includes("Bootstrapped 100%") && !started) {
            started = true;
            clearTimeout(timeout);

            // Read the .onion address
            readOnionHostname(dataDir)
              .then((addr) => {
                onionAddress = addr;
                saveOnionAddress(addr).catch(() => {});
                console.log(`[tor] Hidden service: ${addr}`);
                resolve(addr);
              })
              .catch((err) => {
                reject(
                  new Error(`Tor started but failed to read onion address: ${err}`)
                );
              });
          }
        });

        torProcess.stderr?.on("data", (data: Buffer) => {
          const line = data.toString().trim();
          if (line.length > 0) {
            console.error(`[tor] stderr: ${line}`);
          }
        });

        torProcess.on("error", (err) => {
          clearTimeout(timeout);
          console.error(`[tor] Process error: ${err.message}`);
          if (!started) {
            reject(new Error(`Failed to start Tor: ${err.message}`));
          }
        });

        torProcess.on("exit", (code) => {
          clearTimeout(timeout);
          if (!started) {
            reject(new Error(`Tor exited with code ${code} before starting`));
          } else {
            console.log(`[tor] Process exited with code ${code}`);
          }
          torProcess = null;
        });
      });
    },

    async stop(): Promise<void> {
      if (torProcess && !torProcess.killed) {
        torProcess.kill("SIGTERM");

        // Wait for graceful shutdown
        await new Promise<void>((resolve) => {
          const timeout = setTimeout(() => {
            if (torProcess && !torProcess.killed) {
              torProcess.kill("SIGKILL");
            }
            resolve();
          }, 5000);

          torProcess!.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        });

        torProcess = null;
        console.log("[tor] Stopped");
      }
    },

    getOnionAddress(): string | null {
      return onionAddress;
    },

    getSocksPort(): number {
      return socksPort;
    },

    isRunning(): boolean {
      return torProcess !== null && !torProcess.killed;
    },
  };
}

// ---------------------------------------------------------------------------
// Torrc generation
// ---------------------------------------------------------------------------

function generateTorrc(
  socksPort: number,
  controlPort: number,
  hsPort: number,
  dataDir: string
): string {
  const hsDir = join(dataDir, "hidden_service");

  return [
    `SocksPort ${socksPort}`,
    `ControlPort ${controlPort}`,
    `DataDirectory ${dataDir}`,
    ``,
    `# Hidden service for ActivityPub endpoints`,
    `HiddenServiceDir ${hsDir}`,
    `HiddenServicePort 443 127.0.0.1:${hsPort}`,
    ``,
    `# Reduce logging noise`,
    `Log notice stdout`,
    ``,
    `# Avoid writing unnecessary files`,
    `AvoidDiskWrites 1`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Onion address management
// ---------------------------------------------------------------------------

async function readOnionHostname(dataDir: string): Promise<string> {
  const hostnamePath = join(dataDir, "hidden_service", "hostname");

  // Wait for Tor to create the hostname file
  for (let i = 0; i < 30; i++) {
    if (existsSync(hostnamePath)) {
      const hostname = (await readFile(hostnamePath, "utf-8")).trim();
      if (hostname.endsWith(".onion")) {
        return hostname;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error("Tor did not generate .onion hostname in time");
}

async function saveOnionAddress(address: string): Promise<void> {
  const path = join(ONION_DIR, "address");
  await writeFile(path, address, { mode: 0o600 });
}

async function loadOnionAddress(): Promise<string | null> {
  const path = join(ONION_DIR, "address");
  if (!existsSync(path)) return null;

  try {
    const addr = (await readFile(path, "utf-8")).trim();
    return addr.endsWith(".onion") ? addr : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// SOCKS5 proxy helper
// ---------------------------------------------------------------------------

/**
 * Get SOCKS5 proxy URL for use with fetch/HTTP clients.
 */
export function getSocksProxyUrl(port: number = DEFAULT_SOCKS_PORT): string {
  return `socks5h://127.0.0.1:${port}`;
}
