/**
 * SQLite Storage for Durable Execution
 *
 * Provides persistence for durable agent execution:
 * - Execution state tracking
 * - Step checkpointing
 * - Map progress for incremental recovery
 * - Callback resolution
 */

import Database from "better-sqlite3";
import { ulid } from "ulid";

// =============================================================================
// Types
// =============================================================================

export interface Execution {
  id: string;
  threadId: string;
  agentName: string;
  status: "running" | "waiting" | "completed" | "error";
  callbackId: string | null;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface Checkpoint {
  id: number;
  executionId: string;
  stepName: string;
  stepType: "step" | "parallel" | "map";
  resultJson: string | null;
  completedAt: string;
}

export interface MapProgress {
  id: number;
  executionId: string;
  mapName: string;
  itemIndex: number;
  resultJson: string | null;
  completedAt: string;
}

export interface Callback {
  id: string;
  executionId: string;
  createdAt: string;
  resolvedAt: string | null;
  payloadJson: string | null;
}

// =============================================================================
// Schema
// =============================================================================

const SCHEMA = `
-- Execution state for each durable run
CREATE TABLE IF NOT EXISTS executions (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  callback_id TEXT,
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  error TEXT,
  UNIQUE(thread_id, agent_name)
);

-- Checkpoints for step() calls
CREATE TABLE IF NOT EXISTS checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  step_name TEXT NOT NULL,
  step_type TEXT NOT NULL DEFAULT 'step',
  result_json TEXT,
  completed_at TEXT NOT NULL,
  UNIQUE(execution_id, step_name)
);

-- Map item progress (for incremental map recovery)
CREATE TABLE IF NOT EXISTS map_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  map_name TEXT NOT NULL,
  item_index INTEGER NOT NULL,
  result_json TEXT,
  completed_at TEXT NOT NULL,
  UNIQUE(execution_id, map_name, item_index)
);

-- Pending callbacks (for waitForCallback)
CREATE TABLE IF NOT EXISTS callbacks (
  id TEXT PRIMARY KEY,
  execution_id TEXT NOT NULL REFERENCES executions(id),
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  payload_json TEXT
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_checkpoints_execution ON checkpoints(execution_id);
CREATE INDEX IF NOT EXISTS idx_map_progress_execution ON map_progress(execution_id, map_name);
CREATE INDEX IF NOT EXISTS idx_callbacks_execution ON callbacks(execution_id);
CREATE INDEX IF NOT EXISTS idx_executions_thread ON executions(thread_id);
`;

// =============================================================================
// DurableSqliteStorage
// =============================================================================

export class DurableSqliteStorage {
  private db: Database.Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.init();
  }

  /**
   * Initialize schema
   */
  private init(): void {
    this.db.exec(SCHEMA);
  }

  /**
   * Close the database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Clear all data (for testing)
   */
  clear(): void {
    this.db.exec(`
      DELETE FROM callbacks;
      DELETE FROM map_progress;
      DELETE FROM checkpoints;
      DELETE FROM executions;
    `);
  }

  // ---------------------------------------------------------------------------
  // Execution Operations
  // ---------------------------------------------------------------------------

  /**
   * Get execution by thread and agent name
   */
  getExecution(threadId: string, agentName: string): Execution | null {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, agent_name, status, callback_id, started_at,
                updated_at, completed_at, error
         FROM executions
         WHERE thread_id = ? AND agent_name = ?`
      )
      .get(threadId, agentName) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      agentName: row.agent_name as string,
      status: row.status as Execution["status"],
      callbackId: row.callback_id as string | null,
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      completedAt: row.completed_at as string | null,
      error: row.error as string | null,
    };
  }

  /**
   * Get execution by ID
   */
  getExecutionById(id: string): Execution | null {
    const row = this.db
      .prepare(
        `SELECT id, thread_id, agent_name, status, callback_id, started_at,
                updated_at, completed_at, error
         FROM executions
         WHERE id = ?`
      )
      .get(id) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      threadId: row.thread_id as string,
      agentName: row.agent_name as string,
      status: row.status as Execution["status"],
      callbackId: row.callback_id as string | null,
      startedAt: row.started_at as string,
      updatedAt: row.updated_at as string,
      completedAt: row.completed_at as string | null,
      error: row.error as string | null,
    };
  }

  /**
   * Create a new execution
   */
  createExecution(threadId: string, agentName: string): Execution {
    const id = ulid();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO executions (id, thread_id, agent_name, status, started_at, updated_at)
         VALUES (?, ?, ?, 'running', ?, ?)`
      )
      .run(id, threadId, agentName, now, now);

    return {
      id,
      threadId,
      agentName,
      status: "running",
      callbackId: null,
      startedAt: now,
      updatedAt: now,
      completedAt: null,
      error: null,
    };
  }

  /**
   * Update execution status
   */
  updateExecution(
    id: string,
    updates: Partial<Pick<Execution, "status" | "callbackId" | "error" | "completedAt">>
  ): void {
    const now = new Date().toISOString();
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [now];

    if (updates.status !== undefined) {
      sets.push("status = ?");
      values.push(updates.status);
    }
    if (updates.callbackId !== undefined) {
      sets.push("callback_id = ?");
      values.push(updates.callbackId);
    }
    if (updates.error !== undefined) {
      sets.push("error = ?");
      values.push(updates.error);
    }
    if (updates.completedAt !== undefined) {
      sets.push("completed_at = ?");
      values.push(updates.completedAt);
    }

    values.push(id);

    this.db.prepare(`UPDATE executions SET ${sets.join(", ")} WHERE id = ?`).run(...values);
  }

  /**
   * Delete an execution and all its checkpoints
   */
  deleteExecution(id: string): void {
    // Delete checkpoints first (foreign key)
    this.db.prepare("DELETE FROM checkpoints WHERE execution_id = ?").run(id);
    // Delete map progress
    this.db.prepare("DELETE FROM map_progress WHERE execution_id = ?").run(id);
    // Delete execution
    this.db.prepare("DELETE FROM executions WHERE id = ?").run(id);
  }

  // ---------------------------------------------------------------------------
  // Checkpoint Operations
  // ---------------------------------------------------------------------------

  /**
   * Get all checkpoints for an execution
   */
  getCheckpoints(executionId: string): Checkpoint[] {
    const rows = this.db
      .prepare(
        `SELECT id, execution_id, step_name, step_type, result_json, completed_at
         FROM checkpoints
         WHERE execution_id = ?
         ORDER BY id ASC`
      )
      .all(executionId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as number,
      executionId: row.execution_id as string,
      stepName: row.step_name as string,
      stepType: row.step_type as Checkpoint["stepType"],
      resultJson: row.result_json as string | null,
      completedAt: row.completed_at as string,
    }));
  }

  /**
   * Get a specific checkpoint by step name
   */
  getCheckpoint(executionId: string, stepName: string): Checkpoint | null {
    const row = this.db
      .prepare(
        `SELECT id, execution_id, step_name, step_type, result_json, completed_at
         FROM checkpoints
         WHERE execution_id = ? AND step_name = ?`
      )
      .get(executionId, stepName) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as number,
      executionId: row.execution_id as string,
      stepName: row.step_name as string,
      stepType: row.step_type as Checkpoint["stepType"],
      resultJson: row.result_json as string | null,
      completedAt: row.completed_at as string,
    };
  }

  /**
   * Save a checkpoint
   */
  saveCheckpoint(
    executionId: string,
    stepName: string,
    stepType: Checkpoint["stepType"],
    result: unknown
  ): Checkpoint {
    const now = new Date().toISOString();
    const resultJson = JSON.stringify(result);

    const info = this.db
      .prepare(
        `INSERT INTO checkpoints (execution_id, step_name, step_type, result_json, completed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(execution_id, step_name) DO UPDATE SET
           result_json = excluded.result_json,
           completed_at = excluded.completed_at`
      )
      .run(executionId, stepName, stepType, resultJson, now);

    return {
      id: Number(info.lastInsertRowid),
      executionId,
      stepName,
      stepType,
      resultJson,
      completedAt: now,
    };
  }

  // ---------------------------------------------------------------------------
  // Map Progress Operations
  // ---------------------------------------------------------------------------

  /**
   * Get map progress for a specific map operation
   */
  getMapProgress(executionId: string, mapName: string): MapProgress[] {
    const rows = this.db
      .prepare(
        `SELECT id, execution_id, map_name, item_index, result_json, completed_at
         FROM map_progress
         WHERE execution_id = ? AND map_name = ?
         ORDER BY item_index ASC`
      )
      .all(executionId, mapName) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as number,
      executionId: row.execution_id as string,
      mapName: row.map_name as string,
      itemIndex: row.item_index as number,
      resultJson: row.result_json as string | null,
      completedAt: row.completed_at as string,
    }));
  }

  /**
   * Save map item progress
   */
  saveMapProgress(
    executionId: string,
    mapName: string,
    itemIndex: number,
    result: unknown
  ): MapProgress {
    const now = new Date().toISOString();
    const resultJson = JSON.stringify(result);

    const info = this.db
      .prepare(
        `INSERT INTO map_progress (execution_id, map_name, item_index, result_json, completed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(execution_id, map_name, item_index) DO UPDATE SET
           result_json = excluded.result_json,
           completed_at = excluded.completed_at`
      )
      .run(executionId, mapName, itemIndex, resultJson, now);

    return {
      id: Number(info.lastInsertRowid),
      executionId,
      mapName,
      itemIndex,
      resultJson,
      completedAt: now,
    };
  }

  // ---------------------------------------------------------------------------
  // Callback Operations
  // ---------------------------------------------------------------------------

  /**
   * Get a callback by ID
   */
  getCallback(callbackId: string): Callback | null {
    const row = this.db
      .prepare(
        `SELECT id, execution_id, created_at, resolved_at, payload_json
         FROM callbacks
         WHERE id = ?`
      )
      .get(callbackId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      executionId: row.execution_id as string,
      createdAt: row.created_at as string,
      resolvedAt: row.resolved_at as string | null,
      payloadJson: row.payload_json as string | null,
    };
  }

  /**
   * Create a callback
   */
  createCallback(executionId: string, callbackId: string): Callback {
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO callbacks (id, execution_id, created_at)
         VALUES (?, ?, ?)`
      )
      .run(callbackId, executionId, now);

    return {
      id: callbackId,
      executionId,
      createdAt: now,
      resolvedAt: null,
      payloadJson: null,
    };
  }

  /**
   * Resolve a callback with payload
   */
  resolveCallback(callbackId: string, payload: unknown): void {
    const now = new Date().toISOString();
    const payloadJson = JSON.stringify(payload);

    this.db
      .prepare(
        `UPDATE callbacks
         SET resolved_at = ?, payload_json = ?
         WHERE id = ?`
      )
      .run(now, payloadJson, callbackId);
  }

  /**
   * Get pending callback for an execution
   */
  getPendingCallback(executionId: string): Callback | null {
    const row = this.db
      .prepare(
        `SELECT id, execution_id, created_at, resolved_at, payload_json
         FROM callbacks
         WHERE execution_id = ? AND resolved_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(executionId) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      id: row.id as string,
      executionId: row.execution_id as string,
      createdAt: row.created_at as string,
      resolvedAt: row.resolved_at as string | null,
      payloadJson: row.payload_json as string | null,
    };
  }
}
