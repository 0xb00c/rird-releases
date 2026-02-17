/**
 * Social - HTTP Signatures (draft-cavage-http-signatures)
 *
 * Implements HTTP Signatures for ActivityPub federation.
 * Mastodon and other AP implementations require RSA-SHA256 signed requests.
 *
 * This module provides:
 *   - signRequest()          -- Sign an outgoing HTTP request
 *   - verifyRequest()        -- Verify an incoming signed request
 *   - generateRSAKeypair()   -- Generate RSA-2048 keypair
 *   - loadOrCreateRSAKeypair() -- Persist RSA keypair to disk
 *   - deliverActivity()      -- Send a signed POST to a remote inbox
 *
 * Uses node:crypto for RSA operations (no external dependencies).
 */

import {
  generateKeyPairSync,
  createSign,
  createVerify,
  createHash,
} from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RSAKeypair {
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt: number;
}

export interface SignedHeaders {
  Date: string;
  Digest: string;
  Signature: string;
  "Content-Type": string;
}

export interface VerifyResult {
  verified: boolean;
  keyId: string;
  error?: string;
}

export interface ParsedSignature {
  keyId: string;
  algorithm: string;
  headers: string[];
  signature: string;
}

export interface DeliveryResult {
  success: boolean;
  statusCode?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_RSA_PATH = join(
  homedir(),
  ".rird",
  "identity",
  "rsa_keypair.json"
);

const SIGNED_HEADERS = [
  "(request-target)",
  "host",
  "date",
  "digest",
  "content-type",
];

// ---------------------------------------------------------------------------
// RSA Keypair Management
// ---------------------------------------------------------------------------

/**
 * Generate an RSA-2048 keypair for HTTP Signatures.
 * Separate from the Ed25519 identity keypair.
 */
export function generateRSAKeypair(): RSAKeypair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

/**
 * Load an RSA keypair from disk, or create and save a new one.
 */
export async function loadOrCreateRSAKeypair(
  path: string = DEFAULT_RSA_PATH
): Promise<RSAKeypair> {
  if (existsSync(path)) {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as RSAKeypair;
    return parsed;
  }

  console.log("[http-sig] Generating new RSA-2048 keypair for HTTP Signatures...");
  const keypair = generateRSAKeypair();

  const dir = dirname(path);
  await mkdir(dir, { recursive: true });
  await writeFile(path, JSON.stringify(keypair, null, 2), { mode: 0o600 });

  console.log("[http-sig] RSA keypair saved to " + path);
  return keypair;
}

// ---------------------------------------------------------------------------
// Signing outgoing requests
// ---------------------------------------------------------------------------

/**
 * Sign an outgoing HTTP request using RSA-SHA256.
 *
 * Generates the Digest, Date, and Signature headers required by
 * the draft-cavage-http-signatures spec used by Mastodon.
 *
 * @param privateKeyPem - RSA private key in PEM format
 * @param keyId         - Key identifier (typically actorUrl + "#main-key")
 * @param method        - HTTP method (POST, GET, etc.)
 * @param targetUrl     - Full target URL
 * @param body          - Request body (JSON string)
 * @returns Object with headers to add to the request
 */
export function signRequest(
  privateKeyPem: string,
  keyId: string,
  method: string,
  targetUrl: string,
  body: string
): SignedHeaders {
  const url = new URL(targetUrl);
  const path = url.pathname;
  const host = url.host;

  // Generate Digest header: SHA-256 of the body
  const digest = "SHA-256=" + createHash("sha256").update(body).digest("base64");

  // Generate Date header in HTTP date format (RFC 7231)
  const date = new Date().toUTCString();

  const contentType = "application/activity+json";

  // Build the signing string
  const signingString = buildSigningString(
    method.toLowerCase(),
    path,
    host,
    date,
    digest,
    contentType
  );

  // Sign with RSA-SHA256
  const signer = createSign("sha256");
  signer.update(signingString);
  signer.end();
  const signatureB64 = signer.sign(privateKeyPem, "base64");

  // Build the Signature header value
  const signatureHeader =
    `keyId="${keyId}",` +
    `algorithm="rsa-sha256",` +
    `headers="${SIGNED_HEADERS.join(" ")}",` +
    `signature="${signatureB64}"`;

  return {
    Date: date,
    Digest: digest,
    Signature: signatureHeader,
    "Content-Type": contentType,
  };
}

// ---------------------------------------------------------------------------
// Verifying incoming requests
// ---------------------------------------------------------------------------

/**
 * Verify an incoming HTTP request's signature.
 *
 * Parses the Signature header, fetches the actor's public key,
 * rebuilds the signing string, and verifies the RSA-SHA256 signature.
 *
 * @param method  - HTTP method
 * @param path    - Request path (e.g. "/inbox")
 * @param headers - Request headers (must include signature, host, date, digest, content-type)
 * @returns Verification result
 */
export async function verifyRequest(
  method: string,
  path: string,
  headers: Record<string, string | undefined>
): Promise<VerifyResult> {
  const signatureHeader = headers["signature"] || headers["Signature"];
  if (!signatureHeader) {
    return { verified: false, keyId: "", error: "missing Signature header" };
  }

  // Parse the Signature header
  const parsed = parseSignatureHeader(signatureHeader);
  if (!parsed) {
    return { verified: false, keyId: "", error: "malformed Signature header" };
  }

  // Fetch the actor document to get the public key
  let publicKeyPem: string;
  try {
    publicKeyPem = await fetchActorPublicKey(parsed.keyId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verified: false,
      keyId: parsed.keyId,
      error: "failed to fetch actor public key: " + msg,
    };
  }

  // Rebuild the signing string from the headers listed in the signature
  const signingParts: string[] = [];
  for (const h of parsed.headers) {
    if (h === "(request-target)") {
      signingParts.push(`(request-target): ${method.toLowerCase()} ${path}`);
    } else {
      const value = headers[h] || headers[h.toLowerCase()] || "";
      signingParts.push(`${h}: ${value}`);
    }
  }
  const signingString = signingParts.join("\n");

  // Verify the signature
  try {
    const verifier = createVerify("sha256");
    verifier.update(signingString);
    verifier.end();

    const signatureBytes = Buffer.from(parsed.signature, "base64");
    const valid = verifier.verify(publicKeyPem, signatureBytes);

    return { verified: valid, keyId: parsed.keyId };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      verified: false,
      keyId: parsed.keyId,
      error: "signature verification error: " + msg,
    };
  }
}

// ---------------------------------------------------------------------------
// Activity delivery
// ---------------------------------------------------------------------------

/**
 * Deliver a signed ActivityPub activity to a remote inbox.
 *
 * Sends a POST request with proper HTTP Signature headers.
 *
 * @param inboxUrl      - Target inbox URL
 * @param activity      - Activity object to deliver
 * @param privateKeyPem - RSA private key for signing
 * @param keyId         - Key identifier (actorUrl + "#main-key")
 * @returns Delivery result
 */
export async function deliverActivity(
  inboxUrl: string,
  activity: Record<string, unknown>,
  privateKeyPem: string,
  keyId: string
): Promise<DeliveryResult> {
  const body = JSON.stringify(activity);

  const signedHeaders = signRequest(
    privateKeyPem,
    keyId,
    "POST",
    inboxUrl,
    body
  );

  const url = new URL(inboxUrl);

  try {
    const response = await fetch(inboxUrl, {
      method: "POST",
      headers: {
        Host: url.host,
        Date: signedHeaders.Date,
        Digest: signedHeaders.Digest,
        Signature: signedHeaders.Signature,
        "Content-Type": signedHeaders["Content-Type"],
        Accept: "application/activity+json",
        "User-Agent": "RirdProtocol/1.0",
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });

    if (response.ok || response.status === 202) {
      return { success: true, statusCode: response.status };
    }

    return {
      success: false,
      statusCode: response.status,
      error: `HTTP ${response.status}: ${response.statusText}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: "delivery failed: " + msg };
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the signing string from the standard set of headers.
 */
function buildSigningString(
  method: string,
  path: string,
  host: string,
  date: string,
  digest: string,
  contentType: string
): string {
  return [
    `(request-target): ${method} ${path}`,
    `host: ${host}`,
    `date: ${date}`,
    `digest: ${digest}`,
    `content-type: ${contentType}`,
  ].join("\n");
}

/**
 * Parse a Signature header value into its components.
 *
 * Format: keyId="...",algorithm="...",headers="...",signature="..."
 */
function parseSignatureHeader(header: string): ParsedSignature | null {
  const params: Record<string, string> = {};

  // Match key="value" pairs, handling values that may contain base64 characters
  const regex = /(\w+)="([^"]*)"/g;
  let match = regex.exec(header);
  while (match !== null) {
    params[match[1]] = match[2];
    match = regex.exec(header);
  }

  if (!params.keyId || !params.signature) {
    return null;
  }

  return {
    keyId: params.keyId,
    algorithm: params.algorithm || "rsa-sha256",
    headers: params.headers ? params.headers.split(" ") : ["date"],
    signature: params.signature,
  };
}

/**
 * Fetch an actor document and extract the public key PEM.
 *
 * The keyId is typically in the format "https://example.com/actor#main-key".
 * We fetch the actor URL (without the fragment) and read publicKey.publicKeyPem.
 */
async function fetchActorPublicKey(keyId: string): Promise<string> {
  // Strip the fragment (#main-key) to get the actor URL
  const actorUrl = keyId.split("#")[0];

  const response = await fetch(actorUrl, {
    headers: {
      Accept: "application/activity+json, application/ld+json",
      "User-Agent": "RirdProtocol/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching actor ${actorUrl}`);
  }

  const actor = (await response.json()) as {
    publicKey?: { id?: string; publicKeyPem?: string };
  };

  if (!actor.publicKey?.publicKeyPem) {
    throw new Error("actor document missing publicKey.publicKeyPem");
  }

  return actor.publicKey.publicKeyPem;
}

// Re-export parseSignatureHeader for testing
export { parseSignatureHeader, buildSigningString, fetchActorPublicKey };
