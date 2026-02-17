/**
 * Network - Private Direct Streams
 *
 * Agent-to-agent streams for private communication:
 * - Bids (only the requester sees them)
 * - Negotiation (counter-offers, acceptance)
 * - Delivery (work product transfer)
 * - Escrow coordination
 *
 * All streams use Noise encryption on top of Tor.
 */

import type { NetworkNode } from "./node.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StreamMessage {
  type: PrivateRecordType;
  data: Record<string, unknown>;
  from: string; // agent pubkey
  ts: number;
}

export type PrivateRecordType =
  | "task.bid"
  | "task.counter"
  | "task.accept"
  | "task.deliver"
  | "escrow.coordinate";

export type StreamHandler = (message: StreamMessage) => Promise<void>;

export interface StreamManager {
  send(peerId: string, message: StreamMessage): Promise<void>;
  onMessage(type: PrivateRecordType, handler: StreamHandler): void;
  removeHandler(type: PrivateRecordType): void;
  getActiveStreams(): string[];
}

// ---------------------------------------------------------------------------
// Protocol identifier
// ---------------------------------------------------------------------------

const STREAM_PROTOCOL = "/rird/stream/1.0.0";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const messageHandlers = new Map<PrivateRecordType, StreamHandler>();
const activeStreams = new Set<string>();

// ---------------------------------------------------------------------------
// Stream manager
// ---------------------------------------------------------------------------

export function createStreamManager(node: NetworkNode): StreamManager {
  // Register protocol handler for incoming streams
  registerIncomingHandler(node);

  return {
    async send(peerId: string, message: StreamMessage): Promise<void> {
      try {
        const stream = await openStream(node, peerId);
        const payload = JSON.stringify(message);
        const encoder = new TextEncoder();
        const bytes = encoder.encode(payload + "\n");

        // Write to stream
        if (stream && stream.sink) {
          await writeToStream(stream, bytes);
        }

        activeStreams.add(peerId);
        console.log(
          `[streams] Sent ${message.type} to ${peerId.slice(0, 12)}... (${bytes.length} bytes)`
        );
      } catch (err) {
        console.error(
          `[streams] Failed to send ${message.type} to ${peerId.slice(0, 12)}...: ${err}`
        );
        throw err;
      }
    },

    onMessage(type: PrivateRecordType, handler: StreamHandler): void {
      messageHandlers.set(type, handler);
      console.log(`[streams] Registered handler for ${type}`);
    },

    removeHandler(type: PrivateRecordType): void {
      messageHandlers.delete(type);
    },

    getActiveStreams(): string[] {
      return Array.from(activeStreams);
    },
  };
}

// ---------------------------------------------------------------------------
// Stream operations
// ---------------------------------------------------------------------------

interface StreamLike {
  sink: unknown;
  source: AsyncIterable<Uint8Array>;
}

function registerIncomingHandler(node: NetworkNode): void {
  // TODO: Register protocol handler with libp2p
  // node.libp2p.handle(STREAM_PROTOCOL, async ({ stream, connection }) => {
  //   await handleIncomingStream(stream, connection.remotePeer.toString());
  // });

  // For now, log that we're ready
  console.log(`[streams] Registered incoming handler for ${STREAM_PROTOCOL}`);
  // Suppress unused variable warning in reference impl
  void node;
}

async function openStream(
  _node: NetworkNode,
  _peerId: string
): Promise<StreamLike | null> {
  // TODO: Implement actual libp2p stream opening
  // const peerId = peerIdFromString(peerIdStr);
  // const stream = await node.libp2p.dialProtocol(peerId, STREAM_PROTOCOL);
  // return stream;

  console.log("[streams] TODO: Implement libp2p.dialProtocol for direct streams");
  return null;
}

async function writeToStream(
  _stream: StreamLike,
  _data: Uint8Array
): Promise<void> {
  // TODO: Write data to the libp2p stream
  // The stream.sink expects an AsyncIterable<Uint8Array>
  // await pipe([data], stream.sink);
}

async function handleIncomingStream(
  stream: StreamLike,
  remotePeer: string
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of stream.source) {
      buffer += decoder.decode(chunk, { stream: true });

      // Process complete lines
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (line.length === 0) continue;

        try {
          const message: StreamMessage = JSON.parse(line);
          message.from = remotePeer;
          await dispatchMessage(message);
        } catch (err) {
          console.error(`[streams] Failed to parse message from ${remotePeer.slice(0, 12)}...: ${err}`);
        }
      }
    }
  } catch (err) {
    console.error(`[streams] Stream error from ${remotePeer.slice(0, 12)}...: ${err}`);
  } finally {
    activeStreams.delete(remotePeer);
  }
}

async function dispatchMessage(message: StreamMessage): Promise<void> {
  const handler = messageHandlers.get(message.type);
  if (!handler) {
    console.warn(`[streams] No handler for message type: ${message.type}`);
    return;
  }

  try {
    await handler(message);
  } catch (err) {
    console.error(`[streams] Handler error for ${message.type}: ${err}`);
  }
}

// Export for testing
export { handleIncomingStream, dispatchMessage };
