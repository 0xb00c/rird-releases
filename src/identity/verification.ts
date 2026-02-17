/**
 * Identity - Operator Verification
 *
 * Supports multiple verification methods for operator identity:
 * - GitHub OAuth verification
 * - Domain TXT record verification
 * - Email verification (link/code based)
 *
 * Generates an operator_commitment hash and stores
 * the sealed identity locally at ~/.rird/identity_seal.
 */

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type VerificationMethod = "github" | "domain" | "email";

export interface VerificationRequest {
  method: VerificationMethod;
  /** GitHub username, domain name, or email address */
  identifier: string;
}

export interface VerificationChallenge {
  method: VerificationMethod;
  identifier: string;
  challengeCode: string;
  expiresAt: number;
  instructions: string;
}

export interface VerificationResult {
  verified: boolean;
  method: VerificationMethod;
  identifier: string;
  commitment: string;
  timestamp: number;
  error?: string;
}

export interface IdentitySeal {
  method: VerificationMethod;
  identifier: string;
  commitment: string;
  salt: string;
  verifiedAt: number;
  agentPubkey: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const IDENTITY_SEAL_PATH = join(homedir(), ".rird", "identity_seal");
const CHALLENGE_TTL_SECONDS = 600; // 10 minutes
const TXT_RECORD_PREFIX = "rird-verify=";

// ---------------------------------------------------------------------------
// Pending challenges
// ---------------------------------------------------------------------------

const pendingChallenges = new Map<string, VerificationChallenge>();

// ---------------------------------------------------------------------------
// Challenge creation
// ---------------------------------------------------------------------------

/**
 * Create a verification challenge for the given method.
 */
export function createChallenge(request: VerificationRequest): VerificationChallenge {
  const challengeCode = randomBytes(16).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS;

  let instructions: string;

  switch (request.method) {
    case "github":
      instructions =
        `Create a public gist with filename "rird-verify.txt" ` +
        `containing the code: ${challengeCode}`;
      break;
    case "domain":
      instructions =
        `Add a TXT record to your domain "${request.identifier}" ` +
        `with the value: ${TXT_RECORD_PREFIX}${challengeCode}`;
      break;
    case "email":
      instructions =
        `Enter the verification code sent to ${request.identifier}: ${challengeCode}`;
      break;
    default:
      throw new Error(`Unknown verification method: ${request.method}`);
  }

  const challenge: VerificationChallenge = {
    method: request.method,
    identifier: request.identifier,
    challengeCode,
    expiresAt,
    instructions,
  };

  // Store the pending challenge keyed by identifier
  const key = `${request.method}:${request.identifier}`;
  pendingChallenges.set(key, challenge);

  console.log(
    `[identity/verify] Challenge created for ${request.method}:${request.identifier} ` +
    `(expires in ${CHALLENGE_TTL_SECONDS}s)`
  );

  return challenge;
}

// ---------------------------------------------------------------------------
// GitHub verification
// ---------------------------------------------------------------------------

/**
 * Verify a GitHub user by checking for a gist with the challenge code.
 */
export async function verifyGitHub(
  username: string,
  challengeCode: string
): Promise<boolean> {
  try {
    const response = await fetch(
      `https://api.github.com/users/${encodeURIComponent(username)}/gists`,
      {
        headers: {
          Accept: "application/vnd.github.v3+json",
          "User-Agent": "rird-protocol/1.0",
        },
      }
    );

    if (!response.ok) {
      console.error(`[identity/verify] GitHub API error: ${response.status}`);
      return false;
    }

    const gists = (await response.json()) as Array<{
      files: Record<string, { filename: string; content?: string; raw_url?: string }>;
    }>;

    for (const gist of gists) {
      const verifyFile = gist.files["rird-verify.txt"];
      if (!verifyFile) continue;

      // Fetch the raw content
      if (verifyFile.raw_url) {
        const rawResp = await fetch(verifyFile.raw_url);
        if (rawResp.ok) {
          const content = await rawResp.text();
          if (content.trim() === challengeCode) {
            return true;
          }
        }
      }
    }

    return false;
  } catch (err) {
    console.error(`[identity/verify] GitHub verification error: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Domain verification
// ---------------------------------------------------------------------------

/**
 * Verify domain ownership by checking DNS TXT records.
 * Uses the DNS-over-HTTPS (DoH) protocol for portability.
 */
export async function verifyDomain(
  domain: string,
  challengeCode: string
): Promise<boolean> {
  try {
    // Query DNS TXT records via Cloudflare DoH
    const response = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=TXT`,
      {
        headers: {
          Accept: "application/dns-json",
        },
      }
    );

    if (!response.ok) {
      console.error(`[identity/verify] DNS query error: ${response.status}`);
      return false;
    }

    const data = (await response.json()) as {
      Answer?: Array<{ type: number; data: string }>;
    };

    if (!data.Answer) {
      return false;
    }

    const expectedValue = `${TXT_RECORD_PREFIX}${challengeCode}`;

    for (const record of data.Answer) {
      // TXT record type = 16
      if (record.type === 16) {
        // DNS TXT records are often quoted
        const cleaned = record.data.replace(/^"|"$/g, "");
        if (cleaned === expectedValue) {
          return true;
        }
      }
    }

    return false;
  } catch (err) {
    console.error(`[identity/verify] Domain verification error: ${err}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * Verify an email address by checking the submitted code.
 * The actual email sending is handled externally -- this only checks
 * the code against the pending challenge.
 */
export function verifyEmailCode(
  email: string,
  submittedCode: string
): boolean {
  const key = `email:${email}`;
  const challenge = pendingChallenges.get(key);

  if (!challenge) {
    console.error(`[identity/verify] No pending challenge for ${email}`);
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > challenge.expiresAt) {
    pendingChallenges.delete(key);
    console.error(`[identity/verify] Challenge expired for ${email}`);
    return false;
  }

  const valid = challenge.challengeCode === submittedCode;
  if (valid) {
    pendingChallenges.delete(key);
  }

  return valid;
}

// ---------------------------------------------------------------------------
// Unified verification flow
// ---------------------------------------------------------------------------

/**
 * Complete the verification flow for a pending challenge.
 */
export async function completeVerification(
  method: VerificationMethod,
  identifier: string,
  submittedCode: string,
  agentPubkey: string
): Promise<VerificationResult> {
  const key = `${method}:${identifier}`;
  const challenge = pendingChallenges.get(key);

  if (!challenge) {
    return {
      verified: false,
      method,
      identifier,
      commitment: "",
      timestamp: Math.floor(Date.now() / 1000),
      error: "No pending challenge found",
    };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now > challenge.expiresAt) {
    pendingChallenges.delete(key);
    return {
      verified: false,
      method,
      identifier,
      commitment: "",
      timestamp: now,
      error: "Challenge has expired",
    };
  }

  let verified = false;

  switch (method) {
    case "github":
      verified = await verifyGitHub(identifier, challenge.challengeCode);
      break;
    case "domain":
      verified = await verifyDomain(identifier, challenge.challengeCode);
      break;
    case "email":
      verified = verifyEmailCode(identifier, submittedCode);
      break;
  }

  if (!verified) {
    return {
      verified: false,
      method,
      identifier,
      commitment: "",
      timestamp: now,
      error: "Verification failed -- challenge code not found or incorrect",
    };
  }

  // Generate the commitment and seal the identity
  const salt = randomBytes(32).toString("hex");
  const commitment = generateCommitment(identifier, salt);

  const seal: IdentitySeal = {
    method,
    identifier,
    commitment,
    salt,
    verifiedAt: now,
    agentPubkey,
  };

  await saveIdentitySeal(seal);
  pendingChallenges.delete(key);

  console.log(
    `[identity/verify] Verification complete for ${method}:${identifier}. ` +
    `Commitment: ${commitment.slice(0, 16)}...`
  );

  return {
    verified: true,
    method,
    identifier,
    commitment,
    timestamp: now,
  };
}

// ---------------------------------------------------------------------------
// Identity seal persistence
// ---------------------------------------------------------------------------

/**
 * Save the identity seal to disk.
 */
export async function saveIdentitySeal(seal: IdentitySeal): Promise<void> {
  const dir = dirname(IDENTITY_SEAL_PATH);
  await mkdir(dir, { recursive: true });

  await writeFile(IDENTITY_SEAL_PATH, JSON.stringify(seal, null, 2), {
    mode: 0o600,
  });

  console.log(`[identity/verify] Identity seal saved to ${IDENTITY_SEAL_PATH}`);
}

/**
 * Load the identity seal from disk.
 */
export async function loadIdentitySeal(): Promise<IdentitySeal | null> {
  if (!existsSync(IDENTITY_SEAL_PATH)) {
    return null;
  }

  const raw = await readFile(IDENTITY_SEAL_PATH, "utf-8");
  return JSON.parse(raw) as IdentitySeal;
}

// ---------------------------------------------------------------------------
// Commitment generation
// ---------------------------------------------------------------------------

/**
 * Generate a commitment hash from identity and salt.
 * commitment = SHA-256(identity + ":" + salt)
 */
function generateCommitment(identity: string, salt: string): string {
  const input = `${identity}:${salt}`;
  return createHash("sha256").update(input).digest("hex");
}

export { generateCommitment };
