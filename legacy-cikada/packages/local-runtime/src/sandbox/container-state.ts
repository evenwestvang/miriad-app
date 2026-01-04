/**
 * SQLite Container State Store
 *
 * Persists container state for local Docker orchestration.
 * Same schema as the DynamoDB version for Fargate.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

// =============================================================================
// Types
// =============================================================================

export type ContainerStatus = "starting" | "running" | "stopping" | "stopped";

export interface ContainerState {
  threadId: string;
  containerId: string;
  port: number;
  status: ContainerStatus;
  lastActivity: string;
  createdAt: string;
}

// =============================================================================
// Container State Store
// =============================================================================

export class ContainerStateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure directory exists
    const dir = dirname(dbPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Open database
    this.db = new Database(dbPath);

    // Create table if not exists
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS container_state (
        threadId TEXT PRIMARY KEY,
        containerId TEXT NOT NULL,
        port INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'starting',
        lastActivity TEXT NOT NULL,
        createdAt TEXT NOT NULL
      )
    `);

    // Create index on status for fast lookup of running containers
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_container_status ON container_state(status)
    `);

    console.log(`[ContainerStateStore] Database initialized at ${dbPath}`);
  }

  // ---------------------------------------------------------------------------
  // State Operations
  // ---------------------------------------------------------------------------

  /**
   * Get container state for a thread.
   */
  getState(threadId: string): ContainerState | null {
    const row = this.db
      .prepare("SELECT * FROM container_state WHERE threadId = ?")
      .get(threadId) as ContainerState | undefined;

    return row ?? null;
  }

  /**
   * Set container state for a thread.
   */
  setState(threadId: string, state: Omit<ContainerState, "threadId" | "createdAt" | "lastActivity">): void {
    const now = new Date().toISOString();

    this.db
      .prepare(`
        INSERT INTO container_state (threadId, containerId, port, status, lastActivity, createdAt)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(threadId) DO UPDATE SET
          containerId = excluded.containerId,
          port = excluded.port,
          status = excluded.status,
          lastActivity = excluded.lastActivity
      `)
      .run(threadId, state.containerId, state.port, state.status, now, now);
  }

  /**
   * Update container status.
   */
  setStatus(threadId: string, status: ContainerStatus): void {
    const now = new Date().toISOString();

    this.db
      .prepare("UPDATE container_state SET status = ?, lastActivity = ? WHERE threadId = ?")
      .run(status, now, threadId);
  }

  /**
   * Touch last activity timestamp.
   */
  touchActivity(threadId: string): void {
    const now = new Date().toISOString();

    this.db
      .prepare("UPDATE container_state SET lastActivity = ? WHERE threadId = ?")
      .run(now, threadId);
  }

  /**
   * Delete container state.
   */
  deleteState(threadId: string): void {
    this.db.prepare("DELETE FROM container_state WHERE threadId = ?").run(threadId);
  }

  /**
   * Get all running containers.
   */
  getAllRunning(): ContainerState[] {
    const rows = this.db
      .prepare("SELECT * FROM container_state WHERE status = 'running'")
      .all() as ContainerState[];

    return rows;
  }

  /**
   * Get all containers.
   */
  getAll(): ContainerState[] {
    const rows = this.db
      .prepare("SELECT * FROM container_state ORDER BY createdAt DESC")
      .all() as ContainerState[];

    return rows;
  }

  /**
   * Close database connection.
   */
  close(): void {
    this.db.close();
  }
}
