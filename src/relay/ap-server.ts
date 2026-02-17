/**
 * Relay - Clearnet ActivityPub Server
 *
 * HTTP server that serves AP endpoints for mirrored agents
 * on a clearnet domain. Allows Mastodon users to follow
 * agents via @agent_address@relay.example.com.
 */

import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
  type Server,
} from "node:http";
import type { ActivityStore } from "../activity/store.js";
import type { AgentMirror } from "./agent-mirror.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RelayAPServerConfig {
  domain: string;
  port: number;
  store: ActivityStore;
  mirror: AgentMirror;
}

export interface RelayAPServer {
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Server implementation
// ---------------------------------------------------------------------------

export function createRelayAPServer(
  config: RelayAPServerConfig
): RelayAPServer {
  let server: Server | null = null;

  return {
    async start(): Promise<void> {
      return new Promise((resolve, reject) => {
        server = createServer((req, res) => {
          handleRequest(req, res, config).catch((err) => {
            console.error(`[relay-ap] Unhandled error: ${err}`);
            sendJson(res, 500, { error: "internal server error" });
          });
        });

        server.on("error", reject);

        server.listen(config.port, () => {
          console.log(
            `[relay-ap] AP server listening on port ${config.port}`
          );
          resolve();
        });
      });
    },

    async stop(): Promise<void> {
      return new Promise((resolve) => {
        if (server) {
          server.close(() => resolve());
        } else {
          resolve();
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Request routing
// ---------------------------------------------------------------------------

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  config: RelayAPServerConfig
): Promise<void> {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );
  const method = req.method || "GET";
  const path = url.pathname;

  // CORS
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

  // WebFinger: /.well-known/webfinger?resource=acct:name@domain
  if (path === "/.well-known/webfinger" && method === "GET") {
    handleWebFinger(url, res, config);
    return;
  }

  // Node info (for Mastodon compatibility)
  if (path === "/.well-known/nodeinfo" && method === "GET") {
    handleNodeInfo(res, config);
    return;
  }

  // Actor: /users/<agent-short-id>
  const actorMatch = path.match(/^\/users\/([a-zA-Z0-9_]+)$/);
  if (actorMatch && method === "GET") {
    handleGetActor(actorMatch[1], res, config);
    return;
  }

  // Outbox: /users/<id>/outbox
  const outboxMatch = path.match(/^\/users\/([a-zA-Z0-9_]+)\/outbox$/);
  if (outboxMatch && method === "GET") {
    handleGetOutbox(outboxMatch[1], url, res, config);
    return;
  }

  // Inbox: /users/<id>/inbox
  const inboxMatch = path.match(/^\/users\/([a-zA-Z0-9_]+)\/inbox$/);
  if (inboxMatch && method === "POST") {
    handlePostInbox(inboxMatch[1], req, res, config);
    return;
  }

  // Root / stats page
  if (path === "/" && method === "GET") {
    handleStats(res, config);
    return;
  }

  sendJson(res, 404, { error: "not found" });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleWebFinger(
  url: URL,
  res: ServerResponse,
  config: RelayAPServerConfig
): void {
  const resource = url.searchParams.get("resource");
  if (!resource) {
    sendJson(res, 400, { error: "missing resource parameter" });
    return;
  }

  // Parse acct:username@domain
  const match = resource.match(/^acct:([^@]+)@(.+)$/);
  if (!match || match[2] !== config.domain) {
    sendJson(res, 404, { error: "resource not found" });
    return;
  }

  const username = match[1];
  const agent = config.mirror.getAgentByUsername(username);
  if (!agent) {
    sendJson(res, 404, { error: "agent not found" });
    return;
  }

  res.setHeader("Content-Type", "application/jrd+json; charset=utf-8");
  res.writeHead(200);
  res.end(
    JSON.stringify({
      subject: resource,
      aliases: [`https://${config.domain}/users/${username}`],
      links: [
        {
          rel: "self",
          type: "application/activity+json",
          href: `https://${config.domain}/users/${username}`,
        },
      ],
    })
  );
}

function handleNodeInfo(
  res: ServerResponse,
  config: RelayAPServerConfig
): void {
  sendJson(res, 200, {
    links: [
      {
        rel: "http://nodeinfo.diaspora.software/ns/schema/2.0",
        href: `https://${config.domain}/nodeinfo/2.0`,
      },
    ],
  });
}

function handleGetActor(
  username: string,
  res: ServerResponse,
  config: RelayAPServerConfig
): void {
  const actor = config.mirror.getActorDocument(username);
  if (!actor) {
    sendJson(res, 404, { error: "agent not found" });
    return;
  }

  res.setHeader("Content-Type", "application/activity+json; charset=utf-8");
  res.writeHead(200);
  res.end(JSON.stringify(actor));
}

function handleGetOutbox(
  username: string,
  url: URL,
  res: ServerResponse,
  config: RelayAPServerConfig
): void {
  const page = parseInt(url.searchParams.get("page") || "0", 10);
  const outbox = config.mirror.getOutbox(username, page);

  if (!outbox) {
    sendJson(res, 404, { error: "agent not found" });
    return;
  }

  res.setHeader("Content-Type", "application/activity+json; charset=utf-8");
  res.writeHead(200);
  res.end(JSON.stringify(outbox));
}

async function handlePostInbox(
  _username: string,
  req: IncomingMessage,
  res: ServerResponse,
  _config: RelayAPServerConfig
): Promise<void> {
  // Relay inboxes are mostly a no-op
  // We accept follows to track follower counts
  const body = await readBody(req);
  if (!body) {
    sendJson(res, 400, { error: "empty body" });
    return;
  }

  try {
    const activity = JSON.parse(body);
    console.log(
      `[relay-ap] Inbox received ${activity.type} from ${activity.actor}`
    );
    // TODO: Handle Follow/Undo activities
    res.writeHead(202);
    res.end();
  } catch {
    sendJson(res, 400, { error: "invalid JSON" });
  }
}

function handleStats(
  res: ServerResponse,
  config: RelayAPServerConfig
): void {
  const agents = config.mirror.getAgentCount();
  const html = [
    "<!DOCTYPE html>",
    "<html><head><title>Rird Relay</title></head><body>",
    "<h1>Rird Protocol Relay</h1>",
    `<p>Domain: ${config.domain}</p>`,
    `<p>Agents mirrored: ${agents}</p>`,
    `<p>Records stored: ${config.store.count()}</p>`,
    "<p>This relay mirrors AI agents from the Rird Protocol mesh.</p>",
    "<p>Follow agents from any Mastodon client: @agent_id@" + config.domain + "</p>",
    "</body></html>",
  ].join("\n");

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.writeHead(200);
  res.end(html);
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

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(
        chunks.length > 0
          ? Buffer.concat(chunks).toString("utf-8")
          : null
      );
    });
    req.on("error", () => resolve(null));
  });
}
