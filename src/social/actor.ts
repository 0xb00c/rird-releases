/**
 * Social - ActivityPub Actor Document
 *
 * Generates the self-hosted AP actor document for this agent.
 * Served at https://<onion-address>/actor
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActorConfig {
  onionAddress: string;
  /**
   * RSA public key in PEM format for HTTP Signature verification.
   * Mastodon and other AP implementations expect RSA-SHA256 signatures.
   * Generate with generateRSAKeypair() from ./http-signatures.ts.
   * Format: "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
   */
  publicKeyPem: string;
  agentPubkey: string;
  displayName: string;
  capabilities: string[];
  moneroAddress: string;
  reputationSummary: string;
}

export interface APActor {
  "@context": string[];
  id: string;
  type: string;
  preferredUsername: string;
  name: string;
  summary: string;
  inbox: string;
  outbox: string;
  publicKey: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
  attachment: APPropertyValue[];
  url: string;
  followers: string;
  following: string;
  endpoints: {
    sharedInbox: string;
  };
}

export interface APPropertyValue {
  type: "PropertyValue";
  name: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Actor generation
// ---------------------------------------------------------------------------

export function generateActor(config: ActorConfig): APActor {
  const baseUrl = `https://${config.onionAddress}`;
  const shortId = config.agentPubkey.slice(0, 16);
  const username = `rird_${shortId.slice(0, 8)}`;

  const name = config.displayName || `RIRD Agent ${shortId.slice(0, 8)}`;
  const summary = buildSummary(config);

  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      "https://w3id.org/security/v1",
    ],
    id: `${baseUrl}/actor`,
    type: "Service",
    preferredUsername: username,
    name,
    summary,
    inbox: `${baseUrl}/inbox`,
    outbox: `${baseUrl}/outbox`,
    url: `${baseUrl}/actor`,
    followers: `${baseUrl}/followers`,
    following: `${baseUrl}/following`,
    publicKey: {
      id: `${baseUrl}/actor#main-key`,
      owner: `${baseUrl}/actor`,
      publicKeyPem: config.publicKeyPem,
    },
    attachment: buildAttachments(config),
    endpoints: {
      sharedInbox: `${baseUrl}/inbox`,
    },
  };
}

// ---------------------------------------------------------------------------
// Actor update
// ---------------------------------------------------------------------------

/**
 * Update actor fields that change over time (reputation, capabilities).
 */
export function updateActor(
  actor: APActor,
  updates: Partial<ActorConfig>
): APActor {
  const updated = { ...actor };

  if (updates.displayName) {
    updated.name = updates.displayName;
  }

  if (updates.reputationSummary || updates.capabilities) {
    updated.summary = buildSummary({
      capabilities: updates.capabilities || extractCapabilities(actor),
      reputationSummary: updates.reputationSummary || "",
      agentPubkey: "",
      onionAddress: "",
      publicKeyPem: "",
      displayName: updated.name,
      moneroAddress: "",
    });
  }

  if (updates.capabilities || updates.moneroAddress) {
    updated.attachment = buildAttachments({
      capabilities: updates.capabilities || extractCapabilities(actor),
      moneroAddress: updates.moneroAddress || extractMoneroAddress(actor),
      agentPubkey: "",
      onionAddress: "",
      publicKeyPem: "",
      displayName: "",
      reputationSummary: "",
    });
  }

  return updated;
}

// ---------------------------------------------------------------------------
// WebFinger resource
// ---------------------------------------------------------------------------

export interface WebFingerResource {
  subject: string;
  aliases: string[];
  links: Array<{
    rel: string;
    type: string;
    href: string;
  }>;
}

export function generateWebFingerResource(
  onionAddress: string,
  agentPubkey: string
): WebFingerResource {
  const shortId = agentPubkey.slice(0, 8);
  const baseUrl = `https://${onionAddress}`;

  return {
    subject: `acct:rird_${shortId}@${onionAddress}`,
    aliases: [
      `${baseUrl}/actor`,
    ],
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: `${baseUrl}/actor`,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSummary(config: ActorConfig): string {
  const caps = config.capabilities.join(", ");
  const rep = config.reputationSummary || "New agent";
  return `AI agent | ${caps} | ${rep}`;
}

function buildAttachments(config: ActorConfig): APPropertyValue[] {
  const attachments: APPropertyValue[] = [
    {
      type: "PropertyValue",
      name: "Protocol",
      value: "Rird Protocol v1",
    },
  ];

  if (config.capabilities.length > 0) {
    attachments.push({
      type: "PropertyValue",
      name: "Capabilities",
      value: config.capabilities.join(", "),
    });
  }

  if (config.moneroAddress) {
    attachments.push({
      type: "PropertyValue",
      name: "Monero",
      value: config.moneroAddress,
    });
  }

  return attachments;
}

function extractCapabilities(actor: APActor): string[] {
  const cap = actor.attachment.find((a) => a.name === "Capabilities");
  return cap ? cap.value.split(", ") : [];
}

function extractMoneroAddress(actor: APActor): string {
  const addr = actor.attachment.find((a) => a.name === "Monero");
  return addr ? addr.value : "";
}
