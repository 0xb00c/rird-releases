/**
 * Activity Store - SQLite Storage
 *
 * Persistent storage for activity records using better-sqlite3.
 * Provides insert, query by type/agent/time, and deduplication.
 */

import Database from "better-sqlite3";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, existsSync } from "node:fs";
import type { ActivityRecord } from "./record.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ActivityStore {
  insert(record: ActivityRecord): void;
  getById(id: string): ActivityRecord | null;
  queryByType(type: string, limit?: number): ActivityRecord[];
  queryByAgent(agent: string, limit?: number): ActivityRecord[];
  queryByTimeRange(start: number, end: number, limit?: number): ActivityRecord[];
  queryByTypeAndAgent(type: string, agent: string, limit?: number): ActivityRecord[];
  count(): number;
  close(): void;
}

interface RecordRow {
  id: string;
  v: number;
  agent: string;
  type: string;
  data: string; // JSON
  ts: number;
  sig: string;
  refs: string; // JSON array
  inserted_at: number;
}

// ---------------------------------------------------------------------------
// Store creation
// ---------------------------------------------------------------------------

export function createActivityStore(dbPath?: string): ActivityStore {
  const actualPath = dbPath || defaultDbPath();

  // Ensure directory exists
  const dir = join(actualPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const db = new Database(actualPath);

  // Enable WAL mode for better concurrent read performance
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  // Create tables
  initializeSchema(db);

  // Prepare statements
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO activity_records (id, v, agent, type, data, ts, sig, refs, inserted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getByIdStmt = db.prepare(`
    SELECT * FROM activity_records WHERE id = ?
  `);

  const queryByTypeStmt = db.prepare(`
    SELECT * FROM activity_records WHERE type = ? ORDER BY ts DESC LIMIT ?
  `);

  const queryByAgentStmt = db.prepare(`
    SELECT * FROM activity_records WHERE agent = ? ORDER BY ts DESC LIMIT ?
  `);

  const queryByTimeRangeStmt = db.prepare(`
    SELECT * FROM activity_records WHERE ts >= ? AND ts <= ? ORDER BY ts DESC LIMIT ?
  `);

  const queryByTypeAndAgentStmt = db.prepare(`
    SELECT * FROM activity_records WHERE type = ? AND agent = ? ORDER BY ts DESC LIMIT ?
  `);

  const countStmt = db.prepare(`
    SELECT COUNT(*) as cnt FROM activity_records
  `);

  return {
    insert(record: ActivityRecord): void {
      try {
        insertStmt.run(
          record.id,
          record.v,
          record.agent,
          record.type,
          JSON.stringify(record.data),
          record.ts,
          record.sig,
          JSON.stringify(record.refs),
          Math.floor(Date.now() / 1000)
        );
      } catch (err) {
        // Ignore duplicate key errors (OR IGNORE handles this)
        console.error(`[store] Insert error: ${err}`);
      }
    },

    getById(id: string): ActivityRecord | null {
      const row = getByIdStmt.get(id) as RecordRow | undefined;
      return row ? rowToRecord(row) : null;
    },

    queryByType(type: string, limit: number = 50): ActivityRecord[] {
      const rows = queryByTypeStmt.all(type, limit) as RecordRow[];
      return rows.map(rowToRecord);
    },

    queryByAgent(agent: string, limit: number = 50): ActivityRecord[] {
      const rows = queryByAgentStmt.all(agent, limit) as RecordRow[];
      return rows.map(rowToRecord);
    },

    queryByTimeRange(
      start: number,
      end: number,
      limit: number = 100
    ): ActivityRecord[] {
      const rows = queryByTimeRangeStmt.all(start, end, limit) as RecordRow[];
      return rows.map(rowToRecord);
    },

    queryByTypeAndAgent(
      type: string,
      agent: string,
      limit: number = 50
    ): ActivityRecord[] {
      const rows = queryByTypeAndAgentStmt.all(type, agent, limit) as RecordRow[];
      return rows.map(rowToRecord);
    },

    count(): number {
      const result = countStmt.get() as { cnt: number };
      return result.cnt;
    },

    close(): void {
      db.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS activity_records (
      id TEXT PRIMARY KEY,
      v INTEGER NOT NULL,
      agent TEXT NOT NULL,
      type TEXT NOT NULL,
      data TEXT NOT NULL,
      ts INTEGER NOT NULL,
      sig TEXT NOT NULL,
      refs TEXT NOT NULL DEFAULT '[]',
      inserted_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_records_type ON activity_records(type);
    CREATE INDEX IF NOT EXISTS idx_records_agent ON activity_records(agent);
    CREATE INDEX IF NOT EXISTS idx_records_ts ON activity_records(ts);
    CREATE INDEX IF NOT EXISTS idx_records_type_agent ON activity_records(type, agent);
  `);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToRecord(row: RecordRow): ActivityRecord {
  return {
    v: row.v as 1,
    id: row.id,
    agent: row.agent,
    type: row.type as ActivityRecord["type"],
    data: JSON.parse(row.data),
    ts: row.ts,
    sig: row.sig,
    refs: JSON.parse(row.refs),
  };
}

function defaultDbPath(): string {
  return join(homedir(), ".rird", "data", "activity.db");
}
