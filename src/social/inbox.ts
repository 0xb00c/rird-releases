/**
 * Social - ActivityPub Inbox
 *
 * Receives Follow requests, DMs from humans, and other AP activities.
 * DMs are treated as potential task requests.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface APInboxActivity {
  "@context"?: string | string[];
  id: string;
  type: string;
  actor: string;
  object?: unknown;
  content?: string;
  to?: string[];
  cc?: string[];
}

export interface InboxHandler {
  receive(activity: APInboxActivity): Promise<InboxResult>;
  getFollowers(): string[];
  isFollower(actorId: string): boolean;
}

export interface InboxResult {
  accepted: boolean;
  responseType?: string;
  responseBody?: Record<string, unknown>;
  error?: string;
}

export interface FollowRecord {
  actorId: string;
  followedAt: number;
  displayName?: string;
}

export type TaskRequestHandler = (
  fromActor: string,
  message: string
) => Promise<string>;

// ---------------------------------------------------------------------------
// Inbox implementation
// ---------------------------------------------------------------------------

export function createInboxHandler(
  onionAddress: string,
  agentPubkey: string,
  onTaskRequest?: TaskRequestHandler
): InboxHandler {
  const followers = new Map<string, FollowRecord>();
  const baseUrl = `https://${onionAddress}`;
  const actorUrl = `${baseUrl}/actor`;

  return {
    async receive(activity: APInboxActivity): Promise<InboxResult> {
      console.log(
        `[inbox] Received ${activity.type} from ${activity.actor}`
      );

      switch (activity.type) {
        case "Follow":
          return handleFollow(activity, actorUrl, followers);

        case "Undo":
          return handleUndo(activity, followers);

        case "Create":
          return handleCreate(activity, agentPubkey, onTaskRequest);

        case "Like":
          return handleLike(activity);

        case "Announce":
          return handleAnnounce(activity);

        case "Delete":
          // Acknowledge but don't act
          return { accepted: true };

        default:
          console.log(`[inbox] Unhandled activity type: ${activity.type}`);
          return {
            accepted: false,
            error: `unsupported activity type: ${activity.type}`,
          };
      }
    },

    getFollowers(): string[] {
      return Array.from(followers.keys());
    },

    isFollower(actorId: string): boolean {
      return followers.has(actorId);
    },
  };
}

// ---------------------------------------------------------------------------
// Activity handlers
// ---------------------------------------------------------------------------

async function handleFollow(
  activity: APInboxActivity,
  actorUrl: string,
  followers: Map<string, FollowRecord>
): Promise<InboxResult> {
  const followerActor = activity.actor;

  // Auto-accept all follows
  followers.set(followerActor, {
    actorId: followerActor,
    followedAt: Date.now(),
  });

  console.log(
    `[inbox] Accepted follow from ${followerActor} (total: ${followers.size})`
  );

  // Generate Accept activity response
  return {
    accepted: true,
    responseType: "Accept",
    responseBody: {
      "@context": "https://www.w3.org/ns/activitystreams",
      id: `${actorUrl}/accept/${Date.now()}`,
      type: "Accept",
      actor: actorUrl,
      object: activity,
    },
  };
}

async function handleUndo(
  activity: APInboxActivity,
  followers: Map<string, FollowRecord>
): Promise<InboxResult> {
  const obj = activity.object as { type?: string } | undefined;

  if (obj?.type === "Follow") {
    followers.delete(activity.actor);
    console.log(
      `[inbox] Removed follower ${activity.actor} (total: ${followers.size})`
    );
    return { accepted: true };
  }

  return { accepted: true };
}

async function handleCreate(
  activity: APInboxActivity,
  _agentPubkey: string,
  onTaskRequest?: TaskRequestHandler
): Promise<InboxResult> {
  // Check if this is a DM (direct message) by inspecting the 'to' field
  const obj = activity.object as Record<string, unknown> | undefined;
  if (!obj) {
    return { accepted: false, error: "no object in Create activity" };
  }

  const content = (obj.content as string) || "";

  // Strip HTML tags from content for processing
  const plainText = content.replace(/<[^>]*>/g, "").trim();

  if (!plainText) {
    return { accepted: false, error: "empty message content" };
  }

  // Check if this looks like a DM (not addressed to public)
  const to = (obj.to as string[]) || [];
  const isPublic = to.includes("https://www.w3.org/ns/activitystreams#Public");

  if (!isPublic && onTaskRequest) {
    // Treat as task request
    console.log(
      `[inbox] DM from ${activity.actor}: ${plainText.slice(0, 100)}...`
    );

    try {
      const response = await onTaskRequest(activity.actor, plainText);
      return {
        accepted: true,
        responseType: "Create",
        responseBody: {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "Create",
          object: {
            type: "Note",
            content: response,
            to: [activity.actor],
            inReplyTo: obj.id,
          },
        },
      };
    } catch (err) {
      console.error(`[inbox] Task request handler error: ${err}`);
      return {
        accepted: true,
        responseType: "Create",
        responseBody: {
          "@context": "https://www.w3.org/ns/activitystreams",
          type: "Create",
          object: {
            type: "Note",
            content: "I encountered an error processing your request. Please try again.",
            to: [activity.actor],
            inReplyTo: obj.id,
          },
        },
      };
    }
  }

  // Public mention or non-DM -- acknowledge
  return { accepted: true };
}

async function handleLike(activity: APInboxActivity): Promise<InboxResult> {
  console.log(`[inbox] Received like from ${activity.actor}`);
  return { accepted: true };
}

async function handleAnnounce(
  activity: APInboxActivity
): Promise<InboxResult> {
  console.log(`[inbox] Received boost from ${activity.actor}`);
  return { accepted: true };
}
