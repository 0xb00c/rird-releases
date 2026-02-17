/**
 * Activity Stream - Incoming Record Processing Pipeline
 *
 * Validates, deduplicates, and routes incoming activity records
 * to the appropriate handlers.
 */

import type { ActivityRecord, RecordType } from "./record.js";
import { verifyRecord, isPublicType } from "./record.js";
import type { ActivityStore } from "./store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RecordProcessor = (record: ActivityRecord) => Promise<void>;

export interface StreamPipeline {
  process(record: ActivityRecord): Promise<ProcessResult>;
  addHandler(type: RecordType, handler: RecordProcessor): void;
  removeHandler(type: RecordType): void;
  getStats(): StreamStats;
}

export interface ProcessResult {
  accepted: boolean;
  reason: string;
}

export interface StreamStats {
  processed: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  invalidSig: number;
  timestampDrift: number;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const handlerRegistry = new Map<string, RecordProcessor[]>();

// ---------------------------------------------------------------------------
// Pipeline creation
// ---------------------------------------------------------------------------

export function createStreamPipeline(store: ActivityStore): StreamPipeline {
  const stats: StreamStats = {
    processed: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    invalidSig: 0,
    timestampDrift: 0,
  };

  return {
    async process(record: ActivityRecord): Promise<ProcessResult> {
      stats.processed++;

      // Step 1: Basic validation
      if (!record.v || !record.id || !record.agent || !record.type) {
        stats.rejected++;
        return { accepted: false, reason: "missing required fields" };
      }

      if (record.v !== 1) {
        stats.rejected++;
        return { accepted: false, reason: `unsupported version: ${record.v}` };
      }

      // Step 2: Duplicate check
      const existing = store.getById(record.id);
      if (existing) {
        stats.duplicates++;
        return { accepted: false, reason: "duplicate record" };
      }

      // Step 3: Timestamp drift check (1 hour)
      const now = Math.floor(Date.now() / 1000);
      const drift = Math.abs(now - record.ts);
      if (drift > 3600) {
        stats.timestampDrift++;
        stats.rejected++;
        return {
          accepted: false,
          reason: `timestamp drift too large: ${drift}s`,
        };
      }

      // Step 4: Signature verification (for public records)
      if (isPublicType(record.type)) {
        const valid = await verifyRecord(record);
        if (!valid) {
          stats.invalidSig++;
          stats.rejected++;
          return { accepted: false, reason: "invalid signature" };
        }
      }

      // Step 5: Ref validation (optional -- just check if referenced records exist)
      if (record.refs.length > 0) {
        const missingRefs = record.refs.filter((ref) => !store.getById(ref));
        if (missingRefs.length > 0) {
          // Log but don't reject -- refs might arrive out of order
          console.log(
            `[stream] Record ${record.id.slice(0, 12)}... references ${missingRefs.length} unknown records`
          );
        }
      }

      // Step 6: Store the record
      store.insert(record);
      stats.accepted++;

      // Step 7: Route to handlers
      await routeToHandlers(record);

      return { accepted: true, reason: "ok" };
    },

    addHandler(type: RecordType, handler: RecordProcessor): void {
      if (!handlerRegistry.has(type)) {
        handlerRegistry.set(type, []);
      }
      handlerRegistry.get(type)!.push(handler);
    },

    removeHandler(type: RecordType): void {
      handlerRegistry.delete(type);
    },

    getStats(): StreamStats {
      return { ...stats };
    },
  };
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function routeToHandlers(record: ActivityRecord): Promise<void> {
  const handlers = handlerRegistry.get(record.type);
  if (!handlers || handlers.length === 0) return;

  for (const handler of handlers) {
    try {
      await handler(record);
    } catch (err) {
      console.error(
        `[stream] Handler error for ${record.type} (${record.id.slice(0, 12)}...): ${err}`
      );
    }
  }

  // Also fire wildcard handlers registered as "*"
  const wildcardHandlers = handlerRegistry.get("*" as RecordType);
  if (wildcardHandlers) {
    for (const handler of wildcardHandlers) {
      try {
        await handler(record);
      } catch (err) {
        console.error(`[stream] Wildcard handler error: ${err}`);
      }
    }
  }
}
