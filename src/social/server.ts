/**
 * Social - HTTP Server for ActivityPub Endpoints
 *
 * Minimal HTTP server for serving AP endpoints on the .onion address.
 * Handles:
 *   - GET /.well-known/webfinger
 *   - GET /actor
 *   - GET /outbox
 *   - POST /inbox
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { APActor } from "./actor.js";
import type { OutboxManager } from "./outbox.js";
import type { InboxHandler } from "./inbox.js";
import type { WebFingerResponse } from "./webfinger.js";
import { verifyRequest } from "./http-signatures.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface APServerConfig {
  port: number;
  host: string;
  /** Set to true to skip HTTP signature verification on inbox POST (development only) */
  disableSignatureVerification?: boolean;
}

export interface APServerDeps {
  actor: APActor;
  outbox: OutboxManager;
  inbox: InboxHandler;
  webfinger: (resource: string) => WebFingerResponse | null;
}

export interface APServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  getPort(): number;
}

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

export function createAPServer(
  config: APServerConfig,
  deps: APServerDeps
): APServer {
  let server: Server | null = null;

  return {
    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer((req, res) => {
          handleRequest(req, res, deps, config).catch((err) => {
            console.error(`[ap-server] Unhandled error: ${err}`);
            sendJson(res, 500, { error: "internal server error" });
          });
        });

        server.on("error", (err) => {
          console.error(`[ap-server] Server error: ${err}`);
          reject(err);
        });

        server.listen(config.port, config.host, () => {
          console.log(
            `[ap-server] Listening on ${config.host}:${config.port}`
          );
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => {
            console.log("[ap-server] Stopped");
            resolve();
          });
        } else {
          resolve();
        }
      });
    },

    getPort(): number {
      return config.port;
    },
  };
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  deps: APServerDeps,
  config: APServerConfig
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";
  const path = url.pathname;

  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Accept, Authorization"
  );

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Route requests
  if (path === "/.well-known/webfinger" && method === "GET") {
    handleWebFinger(url, res, deps);
    return;
  }

  if (path === "/actor" && method === "GET") {
    handleGetActor(res, deps);
    return;
  }

  if (path === "/outbox" && method === "GET") {
    handleGetOutbox(url, res, deps);
    return;
  }

  if (path === "/inbox" && method === "POST") {
    await handlePostInbox(req, res, deps, config);
    return;
  }

  if (path === "/followers" && method === "GET") {
    handleGetFollowers(res, deps);
    return;
  }

  // 404 for everything else
  sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

function handleWebFinger(
  url: URL,
  res: ServerResponse,
  deps: APServerDeps
): void {
  const resource = url.searchParams.get("resource");
  if (!resource) {
    sendJson(res, 400, { error: "missing resource parameter" });
    return;
  }

  const result = deps.webfinger(resource);
  if (!result) {
    sendJson(res, 404, { error: "resource not found" });
    return;
  }

  res.setHeader("Content-Type", "application/jrd+json; charset=utf-8");
  res.writeHead(200);
  res.end(JSON.stringify(result));
}

function handleGetActor(res: ServerResponse, deps: APServerDeps): void {
  res.setHeader("Content-Type", "application/activity+json; charset=utf-8");
  res.writeHead(200);
  res.end(JSON.stringify(deps.actor));
}

function handleGetOutbox(
  url: URL,
  res: ServerResponse,
  deps: APServerDeps
): void {
  const pageParam = url.searchParams.get("page");

  if (pageParam) {
    const page = parseInt(pageParam, 10) || 1;
    const collection = deps.outbox.getPage(page);
    sendActivityJson(res, 200, collection as unknown as Record<string, unknown>);
  } else {
    const collection = deps.outbox.getCollection();
    sendActivityJson(res, 200, collection as unknown as Record<string, unknown>);
  }
}

async function handlePostInbox(
  req: IncomingMessage,
  res: ServerResponse,
  deps: APServerDeps,
  config: APServerConfig
): Promise<void> {
  // Read request body
  const body = await readBody(req);
  if (!body) {
    sendJson(res, 400, { error: "empty request body" });
    return;
  }

  let activity: Record<string, unknown>;
  try {
    activity = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
    return;
  }

  // Verify HTTP signature for authenticity.
  // Signature verification can be disabled for development by setting
  // config.disableSignatureVerification = true in APServerConfig.
  if (!config.disableSignatureVerification) {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`
    );

    const headerMap: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      headerMap[key] = Array.isArray(value) ? value.join(", ") : value;
    }

    const verification = await verifyRequest(
      req.method || "POST",
      url.pathname,
      headerMap
    );

    if (!verification.verified) {
      console.log(
        `[ap-server] Rejected unsigned/invalid request: ${verification.error}`
      );
      sendJson(res, 401, {
        error: "invalid or missing HTTP signature",
        detail: verification.error || "signature verification failed",
      });
      return;
    }

    console.log(
      `[ap-server] Verified signature from ${verification.keyId}`
    );
  }

  const result = await deps.inbox.receive(activity as unknown as Parameters<typeof deps.inbox.receive>[0]);

  if (result.accepted) {
    if (result.responseBody) {
      sendActivityJson(res, 200, result.responseBody);
    } else {
      res.writeHead(202);
      res.end();
    }
  } else {
    sendJson(res, 400, { error: result.error || "activity not accepted" });
  }
}

function handleGetFollowers(res: ServerResponse, deps: APServerDeps): void {
  const followers = deps.inbox.getFollowers();

  sendActivityJson(res, 200, {
    "@context": "https://www.w3.org/ns/activitystreams",
    id: `${deps.actor.id.replace("/actor", "")}/followers`,
    type: "OrderedCollection",
    totalItems: followers.length,
    orderedItems: followers,
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function sendActivityJson(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  res.setHeader("Content-Type", "application/activity+json; charset=utf-8");
  res.writeHead(status);
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const maxSize = 1024 * 1024; // 1MB max

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxSize) {
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (chunks.length === 0) {
        resolve(null);
      } else {
        resolve(Buffer.concat(chunks).toString("utf-8"));
      }
    });

    req.on("error", () => {
      resolve(null);
    });
  });
}
