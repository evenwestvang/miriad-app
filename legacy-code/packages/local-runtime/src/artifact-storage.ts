/**
 * Artifact Storage
 *
 * SQLite-based persistent storage for channel artifacts.
 * Supports full-text search via FTS5 and compare-and-swap updates
 * for multi-agent coordination.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ulid } from "ulid";

// =============================================================================
// Types
// =============================================================================

export type ArtifactType =
  | "doc"
  | "task"
  | "code"
  | "decision"
  | "knowledgebase"
  | "system.mcp"
  | "system.agent"
  | "system.focus"
  | "system.playbook";

export type ArtifactStatus =
  // Documents
  | "draft"
  | "published"
  | "archived"
  // Tasks
  | "pending"
  | "in_progress"
  | "done"
  | "blocked";

export interface Artifact {
  id: string;
  slug: string;
  channelId: string;
  type: ArtifactType;
  title?: string;
  tldr: string;
  content: string;
  parentSlug?: string;
  path: string;
  status: ArtifactStatus;
  assignees: string[];
  labels: string[];
  refs: string[];
  props?: Record<string, unknown>;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface ArtifactFilters {
  type?: ArtifactType;
  status?: ArtifactStatus;
  assignee?: string;
  parentSlug?: string | "root";
  search?: string;
  regex?: string;
  limit?: number;
  offset?: number;
}

export interface ArtifactSummary {
  slug: string;
  path: string;
  type: ArtifactType;
  title?: string;
  status: ArtifactStatus;
  tldr: string;
  assignees: string[];
}

export interface ArtifactTreeNode {
  slug: string;
  path: string;
  type: ArtifactType;
  title?: string;
  status: ArtifactStatus;
  assignees: string[];
  children: ArtifactTreeNode[];
}

export interface CASChange {
  field: keyof Artifact;
  oldValue: unknown;
  newValue: unknown;
}

export interface CASResult {
  success: boolean;
  artifact?: Artifact;
  conflict?: {
    field: string;
    expected: unknown;
    actual: unknown;
  };
}

export interface CreateArtifactInput {
  slug: string;
  channelId: string;
  type: ArtifactType;
  tldr: string;
  content: string;
  title?: string;
  parentSlug?: string;
  status?: ArtifactStatus;
  assignees?: string[];
  labels?: string[];
  props?: Record<string, unknown>;
  createdBy: string;
}

/** Callback for artifact change events (for streaming/broadcasting) */
export type ArtifactChangeAction = "create" | "update" | "archive";
export type ArtifactChangeCallback = (action: ArtifactChangeAction, artifact: Artifact) => void;

export interface ArtifactStorageOptions {
  /** Called after successful create/update/archive operations */
  onArtifactChange?: ArtifactChangeCallback;
}

// =============================================================================
// Schema
// =============================================================================

const SCHEMA = `
-- Main artifacts table
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT,
  tldr TEXT NOT NULL,
  content TEXT NOT NULL,
  parent_slug TEXT,
  path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  assignees TEXT DEFAULT '[]',
  labels TEXT DEFAULT '[]',
  refs TEXT DEFAULT '[]',
  props TEXT DEFAULT '{}',
  version INTEGER DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_by TEXT,
  updated_at TEXT,
  UNIQUE(channel_id, slug)
);

-- Indexes for fast lookups
CREATE INDEX IF NOT EXISTS idx_artifacts_channel ON artifacts(channel_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(channel_id, type);
CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(channel_id, status);
CREATE INDEX IF NOT EXISTS idx_artifacts_parent ON artifacts(channel_id, parent_slug);
CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(channel_id, path);

-- FTS5 virtual table for full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
  slug,
  title,
  tldr,
  content,
  content='artifacts',
  content_rowid='rowid'
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS artifacts_ai AFTER INSERT ON artifacts BEGIN
  INSERT INTO artifacts_fts(rowid, slug, title, tldr, content)
  VALUES (new.rowid, new.slug, new.title, new.tldr, new.content);
END;

CREATE TRIGGER IF NOT EXISTS artifacts_ad AFTER DELETE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, slug, title, tldr, content)
  VALUES ('delete', old.rowid, old.slug, old.title, old.tldr, old.content);
END;

CREATE TRIGGER IF NOT EXISTS artifacts_au AFTER UPDATE ON artifacts BEGIN
  INSERT INTO artifacts_fts(artifacts_fts, rowid, slug, title, tldr, content)
  VALUES ('delete', old.rowid, old.slug, old.title, old.tldr, old.content);
  INSERT INTO artifacts_fts(rowid, slug, title, tldr, content)
  VALUES (new.rowid, new.slug, new.title, new.tldr, new.content);
END;
`;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extract [[slug]] references from content
 */
function extractRefs(content: string): string[] {
  const pattern = /\[\[([a-z0-9-]+(?:\.[a-z0-9]+)*)\]\]/g;
  const refs: string[] = [];
  let match;
  while ((match = pattern.exec(content)) !== null) {
    refs.push(match[1]);
  }
  return [...new Set(refs)];
}

/**
 * Validate slug format
 */
function isValidSlug(slug: string): boolean {
  return /^[a-z0-9-]+(\.[a-z0-9]+)*$/.test(slug);
}

/**
 * Convert database row to Artifact object
 */
function rowToArtifact(row: Record<string, unknown>): Artifact {
  const propsStr = row.props as string | undefined;
  const props = propsStr ? JSON.parse(propsStr) as Record<string, unknown> : undefined;
  // Only include props if it has values (not empty object)
  const hasProps = props && Object.keys(props).length > 0;

  return {
    id: row.id as string,
    slug: row.slug as string,
    channelId: row.channel_id as string,
    type: row.type as ArtifactType,
    title: row.title as string | undefined,
    tldr: row.tldr as string,
    content: row.content as string,
    parentSlug: row.parent_slug as string | undefined,
    path: row.path as string,
    status: row.status as ArtifactStatus,
    assignees: JSON.parse(row.assignees as string) as string[],
    labels: JSON.parse(row.labels as string) as string[],
    refs: JSON.parse(row.refs as string) as string[],
    ...(hasProps && { props }),
    version: row.version as number,
    createdBy: row.created_by as string,
    createdAt: row.created_at as string,
    updatedBy: row.updated_by as string | undefined,
    updatedAt: row.updated_at as string | undefined,
  };
}

/**
 * Convert database row to ArtifactSummary
 */
function rowToSummary(row: Record<string, unknown>): ArtifactSummary {
  return {
    slug: row.slug as string,
    path: row.path as string,
    type: row.type as ArtifactType,
    title: row.title as string | undefined,
    status: row.status as ArtifactStatus,
    tldr: row.tldr as string,
    assignees: JSON.parse(row.assignees as string) as string[],
  };
}

// =============================================================================
// ArtifactStorage Class
// =============================================================================

export class ArtifactStorage {
  private db: Database.Database;
  private onArtifactChange?: ArtifactChangeCallback;

  constructor(dbPath: string = ":memory:", options?: ArtifactStorageOptions) {
    // Ensure directory exists for file-based databases
    if (dbPath !== ":memory:") {
      const dir = dirname(dbPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    }

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.onArtifactChange = options?.onArtifactChange;
    this.init();
  }

  private init(): void {
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /**
   * Run any necessary migrations for schema changes
   */
  private migrate(): void {
    // Check if props column exists
    const tableInfo = this.db.prepare("PRAGMA table_info(artifacts)").all() as Array<{ name: string }>;
    const hasPropsColumn = tableInfo.some((col) => col.name === "props");

    if (!hasPropsColumn) {
      // Add props column to existing database
      this.db.exec("ALTER TABLE artifacts ADD COLUMN props TEXT DEFAULT '{}'");
    }
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
      DELETE FROM artifacts;
      DELETE FROM artifacts_fts;
    `);
  }

  // ---------------------------------------------------------------------------
  // Path Computation
  // ---------------------------------------------------------------------------

  /**
   * Compute path for an artifact based on its parent chain
   */
  private computePath(channelId: string, slug: string, parentSlug?: string): string {
    if (!parentSlug) {
      return `/${slug}`;
    }

    const parent = this.read(channelId, parentSlug);
    if (!parent) {
      throw new Error(`Parent artifact not found: ${parentSlug}`);
    }

    return `${parent.path}/${slug}`;
  }

  /**
   * Get all descendants of an artifact using recursive CTE
   */
  private getDescendants(channelId: string, slug: string): Artifact[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE descendants AS (
          SELECT * FROM artifacts WHERE channel_id = ? AND parent_slug = ?
          UNION ALL
          SELECT a.* FROM artifacts a
          INNER JOIN descendants d ON a.channel_id = d.channel_id AND a.parent_slug = d.slug
        )
        SELECT * FROM descendants`
      )
      .all(channelId, slug) as Record<string, unknown>[];

    return rows.map(rowToArtifact);
  }

  /**
   * Check if moving artifact would create a cycle
   */
  private wouldCreateCycle(channelId: string, slug: string, newParentSlug: string): boolean {
    // Can't be parent of self
    if (slug === newParentSlug) {
      return true;
    }

    // Check if newParentSlug is a descendant of slug
    const descendants = this.getDescendants(channelId, slug);
    return descendants.some((d) => d.slug === newParentSlug);
  }

  /**
   * Update paths for all descendants of an artifact after parent change
   * Note: The artifact's own path is already updated by the main UPDATE
   */
  private cascadeDescendantPaths(
    channelId: string,
    slug: string,
    oldPath: string,
    newPath: string
  ): void {
    // Update all descendants' paths
    const descendants = this.getDescendants(channelId, slug);
    for (const descendant of descendants) {
      const newDescendantPath = descendant.path.replace(oldPath, newPath);
      this.db
        .prepare("UPDATE artifacts SET path = ? WHERE channel_id = ? AND slug = ?")
        .run(newDescendantPath, channelId, descendant.slug);
    }
  }

  // ---------------------------------------------------------------------------
  // CRUD Operations
  // ---------------------------------------------------------------------------

  /**
   * Create a new artifact
   */
  create(input: CreateArtifactInput): Artifact {
    // Validate slug
    if (!isValidSlug(input.slug)) {
      throw new Error(`Invalid slug format: ${input.slug}`);
    }

    // Check for duplicate
    const existing = this.read(input.channelId, input.slug);
    if (existing) {
      throw new Error(`Artifact already exists: ${input.slug}`);
    }

    // Validate parent exists
    if (input.parentSlug) {
      const parent = this.read(input.channelId, input.parentSlug);
      if (!parent) {
        throw new Error(`Parent artifact not found: ${input.parentSlug}`);
      }
    }

    const id = ulid();
    const now = new Date().toISOString();
    const path = this.computePath(input.channelId, input.slug, input.parentSlug);
    const refs = extractRefs(input.content);
    const status = input.status ?? "draft";
    const assignees = input.assignees ?? [];
    const labels = input.labels ?? [];
    const props = input.props ?? {};

    this.db
      .prepare(
        `INSERT INTO artifacts (
          id, slug, channel_id, type, title, tldr, content, parent_slug, path,
          status, assignees, labels, refs, props, version, created_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      )
      .run(
        id,
        input.slug,
        input.channelId,
        input.type,
        input.title ?? null,
        input.tldr,
        input.content,
        input.parentSlug ?? null,
        path,
        status,
        JSON.stringify(assignees),
        JSON.stringify(labels),
        JSON.stringify(refs),
        JSON.stringify(props),
        input.createdBy,
        now
      );

    // Only include props in artifact if non-empty
    const hasProps = Object.keys(props).length > 0;

    const artifact: Artifact = {
      id,
      slug: input.slug,
      channelId: input.channelId,
      type: input.type,
      title: input.title,
      tldr: input.tldr,
      content: input.content,
      parentSlug: input.parentSlug,
      path,
      status,
      assignees,
      labels,
      refs,
      ...(hasProps && { props }),
      version: 1,
      createdBy: input.createdBy,
      createdAt: now,
    };

    // Notify listeners
    this.onArtifactChange?.("create", artifact);

    return artifact;
  }

  /**
   * Read an artifact by slug
   */
  read(channelId: string, slug: string): Artifact | null {
    const row = this.db
      .prepare("SELECT * FROM artifacts WHERE channel_id = ? AND slug = ?")
      .get(channelId, slug) as Record<string, unknown> | undefined;

    return row ? rowToArtifact(row) : null;
  }

  /**
   * Update an artifact (simple update, no CAS)
   */
  update(
    channelId: string,
    slug: string,
    changes: Partial<Omit<Artifact, "id" | "slug" | "channelId" | "createdBy" | "createdAt" | "version">>,
    updatedBy: string
  ): Artifact {
    const artifact = this.read(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const now = new Date().toISOString();
    const sets: string[] = ["updated_by = ?", "updated_at = ?", "version = version + 1"];
    const values: unknown[] = [updatedBy, now];

    // Handle content update (extract refs)
    if (changes.content !== undefined) {
      sets.push("content = ?", "refs = ?");
      values.push(changes.content, JSON.stringify(extractRefs(changes.content)));
    }

    // Handle parentSlug change (with cycle detection and path cascade)
    let parentChanged = false;
    let oldPath: string | null = null;
    let newPath: string | null = null;

    if (changes.parentSlug !== undefined && changes.parentSlug !== artifact.parentSlug) {
      if (changes.parentSlug && this.wouldCreateCycle(channelId, slug, changes.parentSlug)) {
        throw new Error("Cannot move artifact: would create cycle");
      }

      parentChanged = true;
      oldPath = artifact.path;
      newPath = this.computePath(channelId, slug, changes.parentSlug ?? undefined);
      sets.push("parent_slug = ?", "path = ?");
      values.push(changes.parentSlug ?? null, newPath);
    }

    // Handle other fields
    if (changes.type !== undefined) {
      sets.push("type = ?");
      values.push(changes.type);
    }
    if (changes.title !== undefined) {
      sets.push("title = ?");
      values.push(changes.title);
    }
    if (changes.tldr !== undefined) {
      sets.push("tldr = ?");
      values.push(changes.tldr);
    }
    if (changes.status !== undefined) {
      sets.push("status = ?");
      values.push(changes.status);
    }
    if (changes.assignees !== undefined) {
      sets.push("assignees = ?");
      values.push(JSON.stringify(changes.assignees));
    }
    if (changes.labels !== undefined) {
      sets.push("labels = ?");
      values.push(JSON.stringify(changes.labels));
    }
    if (changes.props !== undefined) {
      sets.push("props = ?");
      values.push(JSON.stringify(changes.props));
    }

    values.push(channelId, slug);

    // Execute in transaction for atomicity
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE artifacts SET ${sets.join(", ")} WHERE channel_id = ? AND slug = ?`)
        .run(...values);

      // Cascade path updates if parent changed
      if (parentChanged && oldPath && newPath) {
        this.cascadeDescendantPaths(channelId, slug, oldPath, newPath);
      }
    });

    transaction();

    const updated = this.read(channelId, slug)!;

    // Notify listeners
    this.onArtifactChange?.("update", updated);

    return updated;
  }

  /**
   * Update with Compare-and-Swap for multi-agent coordination
   */
  updateWithCAS(
    channelId: string,
    slug: string,
    changes: CASChange[],
    updatedBy: string
  ): CASResult {
    const artifact = this.read(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Check all CAS conditions first
    for (const change of changes) {
      const currentValue = artifact[change.field];
      const expectedValue = change.oldValue;

      // Deep comparison for arrays
      const currentStr = JSON.stringify(currentValue);
      const expectedStr = JSON.stringify(expectedValue);

      if (currentStr !== expectedStr) {
        return {
          success: false,
          conflict: {
            field: change.field,
            expected: expectedValue,
            actual: currentValue,
          },
        };
      }
    }

    // All conditions passed, apply changes
    const updateChanges: Partial<Artifact> = {};
    for (const change of changes) {
      (updateChanges as Record<string, unknown>)[change.field] = change.newValue;
    }

    const updated = this.update(channelId, slug, updateChanges, updatedBy);

    return {
      success: true,
      artifact: updated,
    };
  }

  /**
   * Archive an artifact (soft delete)
   * Notifies with "archive" action (not "update")
   */
  archive(channelId: string, slug: string, updatedBy: string): Artifact {
    const artifact = this.read(channelId, slug);
    if (!artifact) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    // Temporarily disable callback to avoid double notification
    const savedCallback = this.onArtifactChange;
    this.onArtifactChange = undefined;

    const archived = this.update(channelId, slug, { status: "archived" }, updatedBy);

    // Restore callback and notify with "archive" action
    this.onArtifactChange = savedCallback;
    this.onArtifactChange?.("archive", archived);

    return archived;
  }

  // ---------------------------------------------------------------------------
  // Query Operations
  // ---------------------------------------------------------------------------

  /**
   * List artifacts with filters
   */
  list(channelId: string, filters: ArtifactFilters = {}): ArtifactSummary[] {
    const conditions: string[] = ["a.channel_id = ?"];
    const values: unknown[] = [channelId];

    // Type filter
    if (filters.type) {
      conditions.push("a.type = ?");
      values.push(filters.type);
    }

    // Status filter
    if (filters.status) {
      conditions.push("a.status = ?");
      values.push(filters.status);
    }

    // Assignee filter
    if (filters.assignee) {
      conditions.push("a.assignees LIKE ?");
      values.push(`%"${filters.assignee}"%`);
    }

    // Parent filter
    if (filters.parentSlug === "root") {
      conditions.push("a.parent_slug IS NULL");
    } else if (filters.parentSlug) {
      conditions.push("a.parent_slug = ?");
      values.push(filters.parentSlug);
    }

    // FTS5 search
    if (filters.search) {
      conditions.push("a.rowid IN (SELECT rowid FROM artifacts_fts WHERE artifacts_fts MATCH ?)");
      values.push(filters.search);
    }

    // Regex filter (on slug, title, tldr)
    if (filters.regex) {
      conditions.push("(a.slug REGEXP ? OR a.title REGEXP ? OR a.tldr REGEXP ?)");
      values.push(filters.regex, filters.regex, filters.regex);
    }

    // Exclude archived unless explicitly requested
    if (filters.status !== "archived") {
      conditions.push("a.status != 'archived'");
    }

    const limit = filters.limit ?? 50;
    const offset = filters.offset ?? 0;

    const query = `
      SELECT a.slug, a.path, a.type, a.title, a.status, a.tldr, a.assignees
      FROM artifacts a
      WHERE ${conditions.join(" AND ")}
      ORDER BY a.path ASC
      LIMIT ? OFFSET ?
    `;

    values.push(limit, offset);

    const rows = this.db.prepare(query).all(...values) as Record<string, unknown>[];
    return rows.map(rowToSummary);
  }

  /**
   * Get tree view with glob pattern matching
   */
  glob(channelId: string, pattern: string = "/**"): ArtifactTreeNode[] {
    // Convert glob pattern to SQL LIKE pattern
    let sqlPattern: string;
    let parentPath: string | null = null;

    if (pattern === "/**") {
      // All artifacts
      sqlPattern = "/%";
    } else if (pattern === "/*") {
      // Root level only
      parentPath = "root";
      sqlPattern = "/%";
    } else if (pattern.endsWith("/**")) {
      // Subtree
      const base = pattern.slice(0, -3);
      sqlPattern = `${base}%`;
    } else if (pattern.includes("*")) {
      // Pattern with wildcard
      sqlPattern = pattern.replace(/\*/g, "%");
    } else {
      sqlPattern = pattern;
    }

    // Query artifacts
    let query: string;
    const values: unknown[] = [channelId];

    if (parentPath === "root") {
      query = `
        SELECT slug, path, type, title, status, assignees, parent_slug
        FROM artifacts
        WHERE channel_id = ? AND parent_slug IS NULL AND status != 'archived'
        ORDER BY path ASC
      `;
    } else {
      query = `
        SELECT slug, path, type, title, status, assignees, parent_slug
        FROM artifacts
        WHERE channel_id = ? AND path LIKE ? AND status != 'archived'
        ORDER BY path ASC
      `;
      values.push(sqlPattern);
    }

    const rows = this.db.prepare(query).all(...values) as Record<string, unknown>[];

    // Build tree structure
    return this.buildTree(rows);
  }

  /**
   * Build tree structure from flat rows
   */
  private buildTree(rows: Record<string, unknown>[]): ArtifactTreeNode[] {
    const nodeMap = new Map<string, ArtifactTreeNode>();
    const rootNodes: ArtifactTreeNode[] = [];

    // First pass: create all nodes
    for (const row of rows) {
      const node: ArtifactTreeNode = {
        slug: row.slug as string,
        path: row.path as string,
        type: row.type as ArtifactType,
        title: row.title as string | undefined,
        status: row.status as ArtifactStatus,
        assignees: JSON.parse(row.assignees as string) as string[],
        children: [],
      };
      nodeMap.set(node.slug, node);
    }

    // Second pass: build hierarchy
    for (const row of rows) {
      const slug = row.slug as string;
      const parentSlug = row.parent_slug as string | null;
      const node = nodeMap.get(slug)!;

      if (parentSlug && nodeMap.has(parentSlug)) {
        nodeMap.get(parentSlug)!.children.push(node);
      } else {
        rootNodes.push(node);
      }
    }

    return rootNodes;
  }

  /**
   * Search artifacts using FTS5
   */
  search(channelId: string, query: string, limit: number = 50): ArtifactSummary[] {
    const rows = this.db
      .prepare(
        `SELECT a.slug, a.path, a.type, a.title, a.status, a.tldr, a.assignees
         FROM artifacts a
         JOIN artifacts_fts f ON a.rowid = f.rowid
         WHERE a.channel_id = ? AND artifacts_fts MATCH ? AND a.status != 'archived'
         ORDER BY bm25(artifacts_fts)
         LIMIT ?`
      )
      .all(channelId, query, limit) as Record<string, unknown>[];

    return rows.map(rowToSummary);
  }

  // ---------------------------------------------------------------------------
  // Utility Operations
  // ---------------------------------------------------------------------------

  /**
   * List all artifacts in a channel (for debugging/admin)
   */
  listAll(channelId: string): Artifact[] {
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE channel_id = ? ORDER BY path ASC")
      .all(channelId) as Record<string, unknown>[];

    return rows.map(rowToArtifact);
  }

  /**
   * Move an artifact to a new parent
   */
  moveArtifact(
    channelId: string,
    slug: string,
    newParentSlug: string | null,
    updatedBy: string
  ): Artifact {
    return this.update(channelId, slug, { parentSlug: newParentSlug ?? undefined }, updatedBy);
  }

  /**
   * Get artifact count by channel
   */
  count(channelId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM artifacts WHERE channel_id = ? AND status != 'archived'")
      .get(channelId) as { count: number };

    return row.count;
  }
}

// Singleton factory for getting storage instance
let defaultStorage: ArtifactStorage | null = null;

/**
 * Get or create the default ArtifactStorage instance.
 * Options only apply when creating a new instance (first call).
 */
export function getArtifactStorage(dbPath?: string, options?: ArtifactStorageOptions): ArtifactStorage {
  if (!defaultStorage) {
    const path = dbPath ?? `${process.env.CIKADA_DATA_DIR ?? `${process.env.HOME}/.cikada`}/artifacts.db`;
    defaultStorage = new ArtifactStorage(path, options);
  }
  return defaultStorage;
}

/**
 * Reset the default storage instance (for testing)
 */
export function resetArtifactStorage(): void {
  if (defaultStorage) {
    defaultStorage.close();
    defaultStorage = null;
  }
}
