/**
 * Social - WebFinger Discovery
 *
 * Implements RFC 7033 WebFinger for agent discovery.
 * Endpoint: /.well-known/webfinger?resource=acct:agent@address
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebFingerResponse {
  subject: string;
  aliases: string[];
  links: WebFingerLink[];
}

export interface WebFingerLink {
  rel: string;
  type?: string;
  href?: string;
  template?: string;
}

export interface WebFingerConfig {
  onionAddress: string;
  agentPubkey: string;
  actorUrl: string;
}

// ---------------------------------------------------------------------------
// WebFinger handler
// ---------------------------------------------------------------------------

export function createWebFingerHandler(config: WebFingerConfig) {
  const shortId = config.agentPubkey.slice(0, 8);
  const username = `rird_${shortId}`;
  const domain = config.onionAddress;

  const validAccounts = new Set([
    `acct:${username}@${domain}`,
    `acct:rird_${config.agentPubkey.slice(0, 16)}@${domain}`,
    `https://${domain}/actor`,
  ]);

  return {
    /**
     * Handle a WebFinger request.
     * @param resource - The resource query parameter
     * @returns WebFinger response or null if not found
     */
    handle(resource: string): WebFingerResponse | null {
      // Validate the resource
      if (!resource) {
        return null;
      }

      // Check if this is a request for our agent
      if (!validAccounts.has(resource)) {
        // Also check bare username format
        if (
          !resource.startsWith(`acct:`) ||
          !resource.endsWith(`@${domain}`)
        ) {
          return null;
        }

        // Extract username portion
        const acctPart = resource.slice(5); // remove "acct:"
        const atIdx = acctPart.indexOf("@");
        const requestedUser = atIdx > 0 ? acctPart.slice(0, atIdx) : acctPart;

        if (requestedUser !== username) {
          return null;
        }
      }

      return {
        subject: `acct:${username}@${domain}`,
        aliases: [config.actorUrl],
        links: [
          {
            rel: "self",
            type: "application/activity+json",
            href: config.actorUrl,
          },
          {
            rel: "http://webfinger.net/rel/profile-page",
            type: "text/html",
            href: config.actorUrl,
          },
        ],
      };
    },

    /**
     * Get the canonical account identifier for this agent.
     */
    getAccount(): string {
      return `${username}@${domain}`;
    },

    /**
     * Get the full acct: URI for this agent.
     */
    getAcctUri(): string {
      return `acct:${username}@${domain}`;
    },
  };
}

// ---------------------------------------------------------------------------
// WebFinger client (for resolving remote actors)
// ---------------------------------------------------------------------------

/**
 * Resolve a remote actor via WebFinger.
 * @param acct - Account identifier (user@domain or acct:user@domain)
 * @returns The actor URL, or null if not found
 */
export async function resolveWebFinger(
  acct: string
): Promise<string | null> {
  // Normalize the account identifier
  const normalized = acct.startsWith("acct:") ? acct : `acct:${acct}`;
  const atIdx = normalized.indexOf("@");
  if (atIdx === -1) return null;

  const domain = normalized.slice(atIdx + 1);
  const url = `https://${domain}/.well-known/webfinger?resource=${encodeURIComponent(normalized)}`;

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/jrd+json, application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as WebFingerResponse;

    // Find the self link with AP type
    const selfLink = data.links.find(
      (link) =>
        link.rel === "self" &&
        (link.type === "application/activity+json" ||
          link.type === "application/ld+json; profile=\"https://www.w3.org/ns/activitystreams\"")
    );

    return selfLink?.href || null;
  } catch (err) {
    console.error(`[webfinger] Failed to resolve ${acct}: ${err}`);
    return null;
  }
}
