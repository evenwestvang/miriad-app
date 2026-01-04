import type DatabaseConstructor from "better-sqlite3";
import { v4 as uuid } from "uuid";
import { generateKeyBetween } from "fractional-indexing";
import path from "path";
import os from "os";
import fs from "fs";
import { assertValidProps, validateArtifactProps, type PropsValidationError } from "../shared/artifact-schemas.js";
import * as sqliteVec from "sqlite-vec";

// Load better-sqlite3 with helpful error message if it fails
let Database: typeof DatabaseConstructor;
try {
  Database = (await import("better-sqlite3")).default;
} catch (err) {
  console.error(`
\u274C Failed to load SQLite module

This usually means prebuilt binaries aren't available for your platform.

Troubleshooting:
1. Ensure you have build tools installed:
   - macOS: xcode-select --install
   - Ubuntu: sudo apt install build-essential python3
   - Windows: npm install -g windows-build-tools

2. Try reinstalling: npm rebuild better-sqlite3

See: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md
`);
  process.exit(1);
}

export type SubscriptionCallback = () => void;

export interface ChannelMetadata {
  tagline?: string;
  mission?: string;
  playbookId?: string;
  specialInstructions?: string;
  [key: string]: unknown; // Allow future fields
}

export interface Channel {
  name: string;
  createdAt: string;
  archived?: boolean;
  hidden?: boolean;        // Hidden from sidebar (e.g., #root channel)
  metadata?: ChannelMetadata;
  lastActivity?: string; // ISO timestamp of last user message
}

export interface Message {
  id: string;
  type: "message";
  channel: string;
  sender: string;
  timestamp: string;
  content: string;
}

// Proposed agent for summon_request field
export interface SummonRequestAgent {
  callsign: string;       // e.g., "fox"
  definitionSlug: string; // e.g., "engineer"
  purpose: string;        // e.g., "Frontend React components"
}

// Structured ask field types
export interface StructuredAskField {
  id: string;
  label: string;
  description?: string;
  type: "radio" | "checkbox" | "text" | "textarea" | "select" | "summon_request";
  options?: Array<{ value: string; label: string }>;
  agents?: SummonRequestAgent[];  // For summon_request: proposed agents with purposes
  required?: boolean;
  placeholder?: string;
}

// Structured ask form data
export interface StructuredAskFormData {
  prompt: string;
  fields: StructuredAskField[];
  submitLabel?: string;
  to: string[];  // Recipients (callsigns)
}

// Structured ask response data (key-value pairs from form submission)
export interface StructuredAskResponse {
  [fieldId: string]: string | string[];  // string for single values, string[] for checkboxes
}

// Structured ask message type
export interface StructuredAskMessage {
  id: string;
  type: "structured_ask";
  channel: string;
  sender: string;
  timestamp: string;
  content: string;  // The prompt text
  formData: StructuredAskFormData;
  formState: "pending" | "submitted";
  response?: StructuredAskResponse;
  respondedBy?: string;
  respondedAt?: string;
}

// Union type for all message types
export type AnyMessage = Message | StructuredAskMessage;

export interface ChannelAgent {
  channel: string;
  name: string;
  agentSlug?: string;      // References system.agent artifact slug
  engine: string;          // Provider engine: "claude", "codex", etc.
  createdAt: string;
  dismissed?: boolean;     // Agent is dismissed from channel (archived but can be re-summoned)
}

// Artifact types
// Base statuses for all types
export type ArtifactStatus = "draft" | "published" | "archived";
// Task-specific statuses (only valid when type === "task")
export type TaskStatus = "pending" | "in_progress" | "done" | "blocked";
// Combined status type - validated based on artifact type
export type Status = ArtifactStatus | TaskStatus;

export interface Artifact {
  // Identity
  id: string;              // UUID, internal DB key only
  slug: string;            // Immutable human-readable identifier: "auth-api-spec"
  channel: string;         // Channel scope
  path: string;            // Cached full path: "/auth-system/api-endpoints/login.ts"

  // Display
  title?: string;          // Mutable display name: "Authentication API Specification"
  tldr?: string;           // Summary (1-3 sentences) - optional for file uploads

  // Content
  type: string;            // Freeform: "doc", "task", "decision", "code", "system.playbook", "system.agent"
  content: string;         // Markdown body (or base64 for binary assets)
  contentType?: string;    // MIME hint: "text/markdown", "application/json", "image/png"
  encoding?: string;       // "base64" for binary assets, undefined for text

  // Auto-populated
  refs: string[];          // Extracted [[slug]] and [[#channel/slug]] references

  // Lifecycle - unified status field with type-dependent validation
  status: Status;          // Default: "published"

  // Relationships
  parentSlug?: string;     // Parent artifact slug (for tree structure)
  orderKey: string;        // Lexicographic sort key for ordering within parent

  // Metadata
  labels?: string[];       // Freeform tags: ["urgent", "needs-review"]
  assignees?: string[];    // Agent callsigns (for tasks)
  props?: Record<string, unknown>;  // Type-specific properties (e.g., engine, model for system.agent)
  needsDescription?: boolean; // Flag for file uploads awaiting tldr enrichment

  // Audit
  createdBy: string;       // Creator callsign
  createdAt: string;       // ISO timestamp
  updatedBy?: string;      // Last modifier
  updatedAt?: string;      // Last modification time
  version: number;         // Internal version for optimistic locking
}

// Artifact version snapshot (immutable once created)
export interface ArtifactVersion {
  id: string;
  artifactId: string;
  versionName: string;     // "v1.0", "draft-2", "final"
  message?: string;        // "Addressed security feedback"
  content: string;         // Snapshot of content at this version
  tldr?: string;           // Snapshot of tldr (optional for file uploads)
  createdBy: string;
  createdAt: string;
  mentions: string[];      // @callsigns found in content
}

// Store data in ~/.cast/ folder (with fallback to legacy ~/.powpow/ env vars)
const CAST_DIR = process.env.CAST_DIR || process.env.POWPOW_DIR || path.join(os.homedir(), ".cast");
if (!fs.existsSync(CAST_DIR)) {
  fs.mkdirSync(CAST_DIR, { recursive: true });
}
const DB_PATH = process.env.CAST_DATABASE || process.env.POWPOW_DB || path.join(CAST_DIR, "cast.db");
const ASSETS_DIR = path.join(CAST_DIR, "assets");

// File size limit for uploads (50MB default, configurable via env)
export const MAX_FILE_SIZE_BYTES = parseInt(process.env.CAST_MAX_FILE_SIZE || "52428800", 10);

// File size validation utility - shared between HTTP endpoint and MCP tool
export interface FileSizeValidationResult {
  valid: boolean;
  error?: string;
  size?: number;
}

export function validateFileSize(sizeInBytes: number): FileSizeValidationResult {
  if (sizeInBytes > MAX_FILE_SIZE_BYTES) {
    const maxMB = Math.round(MAX_FILE_SIZE_BYTES / 1024 / 1024);
    const actualMB = (sizeInBytes / 1024 / 1024).toFixed(2);
    return {
      valid: false,
      error: `File size ${actualMB}MB exceeds maximum allowed size of ${maxMB}MB`,
      size: sizeInBytes,
    };
  }
  return { valid: true, size: sizeInBytes };
}

// Validate file size from a file path (for MCP tool)
export function validateFileSizeFromPath(filePath: string): FileSizeValidationResult {
  try {
    const stats = fs.statSync(filePath);
    return validateFileSize(stats.size);
  } catch (err) {
    return {
      valid: false,
      error: `Failed to read file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// Helper: Get path to asset file
export function getAssetPath(channel: string, slug: string): string {
  return path.join(ASSETS_DIR, channel, slug);
}

// Helper: Save binary asset to file
export function saveAsset(channel: string, slug: string, data: Buffer): void {
  const assetDir = path.join(ASSETS_DIR, channel);
  if (!fs.existsSync(assetDir)) {
    fs.mkdirSync(assetDir, { recursive: true });
  }
  fs.writeFileSync(getAssetPath(channel, slug), data);
}

// Helper: Read binary asset from file
export function readAsset(channel: string, slug: string): Buffer | null {
  const assetPath = getAssetPath(channel, slug);
  if (!fs.existsSync(assetPath)) return null;
  return fs.readFileSync(assetPath);
}

// Helper: Delete asset file
export function deleteAsset(channel: string, slug: string): boolean {
  const assetPath = getAssetPath(channel, slug);
  if (!fs.existsSync(assetPath)) return false;
  fs.unlinkSync(assetPath);
  return true;
}

class Store {
  private db: DatabaseConstructor.Database;
  private messageSubscribers: Map<string, Set<SubscriptionCallback>> = new Map();
  private artifactSubscribers: Map<string, Set<SubscriptionCallback>> = new Map();

  constructor() {
    this.db = new Database(DB_PATH);
    this.db.pragma("journal_mode = WAL"); // Better concurrent access

    // Load sqlite-vec extension for vector search
    sqliteVec.load(this.db);

    // Register REGEXP function for regex search support
    this.db.function("regexp", (pattern: string, value: string) => {
      if (!pattern || !value) return 0;
      try {
        const regex = new RegExp(pattern, "i"); // Case-insensitive by default
        return regex.test(value) ? 1 : 0;
      } catch {
        return 0; // Invalid regex returns no match
      }
    });

    this.init();
    console.error(`[powpow] Database: ${DB_PATH}`);
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS channels (
        name TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0,
        metadata TEXT,
        last_activity TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (channel) REFERENCES channels(name)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);

      CREATE TABLE IF NOT EXISTS channel_agents (
        channel TEXT NOT NULL,
        name TEXT NOT NULL,
        agent_slug TEXT,
        engine TEXT NOT NULL DEFAULT 'claude',
        created_at TEXT NOT NULL,
        dismissed INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel, name),
        FOREIGN KEY (channel) REFERENCES channels(name)
      );

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        slug TEXT NOT NULL,
        channel TEXT NOT NULL,
        path TEXT NOT NULL,
        title TEXT,
        tldr TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        content_type TEXT,
        encoding TEXT,             -- "base64" for binary assets, NULL for text
        refs TEXT,                 -- JSON array of referenced slugs
        status TEXT NOT NULL DEFAULT 'published',
        parent_slug TEXT,
        order_key TEXT NOT NULL DEFAULT 'a0',  -- Lexicographic sort key within parent
        labels TEXT,               -- JSON array
        assignees TEXT,            -- JSON array
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_by TEXT,
        updated_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        UNIQUE(channel, slug),
        UNIQUE(channel, path),
        FOREIGN KEY (channel) REFERENCES channels(name)
      );

      CREATE INDEX IF NOT EXISTS idx_artifacts_channel ON artifacts(channel);
      CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(channel, type);
      CREATE INDEX IF NOT EXISTS idx_artifacts_parent ON artifacts(parent_slug);
      CREATE INDEX IF NOT EXISTS idx_artifacts_status ON artifacts(channel, status);
      CREATE INDEX IF NOT EXISTS idx_artifacts_refs ON artifacts(refs);
      CREATE INDEX IF NOT EXISTS idx_artifacts_path ON artifacts(channel, path);

      -- Named versions (version history)
      CREATE TABLE IF NOT EXISTS artifact_versions (
        id TEXT PRIMARY KEY,
        artifact_id TEXT NOT NULL,
        version_name TEXT NOT NULL,
        message TEXT,
        content TEXT NOT NULL,
        tldr TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        mentions TEXT,             -- JSON array of @callsigns found in content
        FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
        UNIQUE(artifact_id, version_name)
      );

      CREATE INDEX IF NOT EXISTS idx_versions_artifact ON artifact_versions(artifact_id);
    `);

    // Migration: add archived column if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE channels ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists, ignore
    }

    // Migration: add metadata column if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE channels ADD COLUMN metadata TEXT`);
    } catch {
      // Column already exists, ignore
    }

    // Migration: add last_activity column if it doesn't exist
    try {
      this.db.exec(`ALTER TABLE channels ADD COLUMN last_activity TEXT`);
    } catch {
      // Column already exists, ignore
    }

    // Migration: add hidden column to channels for system channels like #root
    try {
      this.db.exec(`ALTER TABLE channels ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists, ignore
    }

    // Migration: artifacts table - rename name to slug, add new columns
    try {
      this.db.exec(`ALTER TABLE artifacts RENAME COLUMN name TO slug`);
    } catch {
      // Column already renamed or doesn't exist
    }
    try {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN title TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN tldr TEXT NOT NULL DEFAULT ''`);
      // Derive tldr from first sentence of content for existing rows
      this.db.exec(`
        UPDATE artifacts
        SET tldr = CASE
          WHEN instr(content, '.') > 0 THEN substr(content, 1, instr(content, '.'))
          WHEN length(content) > 100 THEN substr(content, 1, 100) || '...'
          ELSE content
        END
        WHERE tldr = ''
      `);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN path TEXT NOT NULL DEFAULT ''`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN refs TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE artifacts RENAME COLUMN parent_id TO parent_slug`);
    } catch {
      // Column already renamed or doesn't exist
    }
    // Drop old columns that are no longer needed
    // Note: SQLite doesn't support DROP COLUMN in older versions, so we leave task_status and message_ref
    // They'll just be unused in the new schema

    // Migration: add engine column to channel_agents (default 'claude' for existing rows)
    try {
      this.db.exec(`ALTER TABLE channel_agents ADD COLUMN engine TEXT NOT NULL DEFAULT 'claude'`);
    } catch {
      // Column already exists
    }

    // Migration: add dismissed column to channel_agents
    try {
      this.db.exec(`ALTER TABLE channel_agents ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Migration: add agent_slug column to channel_agents for artifact-based definitions
    try {
      this.db.exec(`ALTER TABLE channel_agents ADD COLUMN agent_slug TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: drop hat_id column and migrate data to agent_slug
    // Old schema had hat_id column (possibly with FK to hats table).
    // We migrate any hat_id data to agent_slug, then drop the column.
    try {
      const tableInfo = this.db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='channel_agents'`).get() as { sql: string } | undefined;
      if (tableInfo?.sql?.includes('hat_id')) {
        console.error('[migration] Migrating hat_id to agent_slug and dropping hat_id column...');

        // First, migrate any hat_id values to agent_slug (if agent_slug is empty)
        this.db.exec(`
          UPDATE channel_agents
          SET agent_slug = hat_id
          WHERE agent_slug IS NULL AND hat_id IS NOT NULL AND hat_id != ''
        `);

        // Create new table without hat_id
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS channel_agents_new (
            channel TEXT NOT NULL,
            name TEXT NOT NULL,
            agent_slug TEXT,
            engine TEXT NOT NULL DEFAULT 'claude',
            created_at TEXT NOT NULL,
            dismissed INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (channel, name),
            FOREIGN KEY (channel) REFERENCES channels(name)
          )
        `);

        // Copy data (excluding hat_id)
        this.db.exec(`
          INSERT INTO channel_agents_new (channel, name, agent_slug, engine, created_at, dismissed)
          SELECT channel, name, agent_slug, COALESCE(engine, 'claude'), created_at, COALESCE(dismissed, 0) FROM channel_agents
        `);

        // Drop old table and rename
        this.db.exec(`DROP TABLE channel_agents`);
        this.db.exec(`ALTER TABLE channel_agents_new RENAME TO channel_agents`);

        console.error('[migration] Dropped hat_id column from channel_agents');
      }
    } catch (e) {
      console.error('[migration] hat_id migration error (may be ok):', e);
    }

    // Migration: add encoding column to artifacts for binary assets
    try {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN encoding TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: add props column to artifacts for type-specific properties
    try {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN props TEXT`);
    } catch {
      // Column already exists
    }

    // Migration: add order_key column to artifacts for lexicographic ordering
    try {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN order_key TEXT NOT NULL DEFAULT 'a0'`);
      // Assign unique orderKeys to existing artifacts (grouped by parent)
      const artifacts = this.db.prepare(`
        SELECT id, channel, parent_slug FROM artifacts ORDER BY channel, parent_slug, created_at
      `).all() as { id: string; channel: string; parent_slug: string | null }[];

      // Group by channel+parent and assign sequential keys
      let currentGroup = '';
      let orderKey: string | null = null;
      for (const art of artifacts) {
        const group = `${art.channel}:${art.parent_slug || ''}`;
        if (group !== currentGroup) {
          currentGroup = group;
          orderKey = null; // Reset for new group
        }
        orderKey = generateKeyBetween(orderKey, null);
        this.db.prepare(`UPDATE artifacts SET order_key = ? WHERE id = ?`).run(orderKey, art.id);
      }
      console.error(`[migration] Assigned unique orderKeys to ${artifacts.length} existing artifacts`);
    } catch {
      // Column already exists
    }

    // Create order_key index (after migration ensures column exists)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_order ON artifacts(channel, parent_slug, order_key)`);

    // Fix duplicate orderKeys: check if any group has duplicates
    const duplicates = this.db.prepare(`
      SELECT channel, parent_slug, order_key, COUNT(*) as cnt
      FROM artifacts
      GROUP BY channel, parent_slug, order_key
      HAVING COUNT(*) > 1
    `).all() as { channel: string; parent_slug: string | null; order_key: string; cnt: number }[];

    console.error(`[migration] Checking orderKeys: found ${duplicates.length} groups with duplicates`);

    if (duplicates.length > 0) {
      console.error(`[migration] Fixing duplicate orderKeys...`);
      const artifacts = this.db.prepare(`
        SELECT id, channel, parent_slug FROM artifacts ORDER BY channel, parent_slug, created_at
      `).all() as { id: string; channel: string; parent_slug: string | null }[];

      let currentGroup = '';
      let orderKey: string | null = null;
      for (const art of artifacts) {
        const group = `${art.channel}:${art.parent_slug || ''}`;
        if (group !== currentGroup) {
          currentGroup = group;
          orderKey = null;
        }
        orderKey = generateKeyBetween(orderKey, null);
        this.db.prepare(`UPDATE artifacts SET order_key = ? WHERE id = ?`).run(orderKey, art.id);
      }
      console.error(`[migration] Fixed orderKeys for ${artifacts.length} artifacts`);
    }

    // Migration: add structured_ask columns to messages table
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN type TEXT NOT NULL DEFAULT 'message'`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN form_data TEXT`);  // JSON: StructuredAskFormData
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN form_state TEXT`);  // 'pending' | 'submitted'
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN response TEXT`);  // JSON: StructuredAskResponse
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN responded_by TEXT`);
    } catch {
      // Column already exists
    }
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN responded_at TEXT`);
    } catch {
      // Column already exists
    }

    // Index for pending forms
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_form_state ON messages(channel, form_state)`);

    // Migration: add needs_description column to artifacts for file uploads awaiting tldr
    try {
      this.db.exec(`ALTER TABLE artifacts ADD COLUMN needs_description INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Column already exists
    }

    // Index for artifacts needing description (for future enrichment workflows)
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_artifacts_needs_description ON artifacts(channel, needs_description)`);

    // FTS5 full-text search for artifacts
    // Using porter tokenizer for English stemming, external content table
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
          slug,
          title,
          tldr,
          content,
          channel UNINDEXED,
          content='artifacts',
          content_rowid='rowid',
          tokenize='porter'
        )
      `);

      // Sync triggers to keep FTS index in sync with artifacts table
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_insert AFTER INSERT ON artifacts BEGIN
          INSERT INTO artifacts_fts(rowid, slug, title, tldr, content, channel)
          VALUES (new.rowid, new.slug, COALESCE(new.title, ''), new.tldr, new.content, new.channel);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_update AFTER UPDATE ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, slug, title, tldr, content, channel)
          VALUES ('delete', old.rowid, old.slug, COALESCE(old.title, ''), old.tldr, old.content, old.channel);
          INSERT INTO artifacts_fts(rowid, slug, title, tldr, content, channel)
          VALUES (new.rowid, new.slug, COALESCE(new.title, ''), new.tldr, new.content, new.channel);
        END
      `);

      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS artifacts_fts_delete AFTER DELETE ON artifacts BEGIN
          INSERT INTO artifacts_fts(artifacts_fts, rowid, slug, title, tldr, content, channel)
          VALUES ('delete', old.rowid, old.slug, COALESCE(old.title, ''), old.tldr, old.content, old.channel);
        END
      `);

      // Rebuild FTS index from existing data (safe to run multiple times)
      // Only rebuild if the FTS table is empty
      const ftsCount = this.db.prepare(`SELECT COUNT(*) as count FROM artifacts_fts`).get() as { count: number };
      const artifactCount = this.db.prepare(`SELECT COUNT(*) as count FROM artifacts`).get() as { count: number };
      if (ftsCount.count === 0 && artifactCount.count > 0) {
        console.error(`[migration] Rebuilding FTS5 index for ${artifactCount.count} artifacts...`);
        this.db.exec(`INSERT INTO artifacts_fts(artifacts_fts) VALUES('rebuild')`);
        console.error(`[migration] FTS5 index rebuilt`);
      }
    } catch (e) {
      console.error('[migration] FTS5 setup error:', e);
    }

    // sqlite-vec virtual table for KB document embeddings
    // Using 1536 dimensions (OpenAI text-embedding-3-small default)
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS kb_embeddings USING vec0(
          artifact_id TEXT PRIMARY KEY,
          channel TEXT NOT NULL,
          embedding FLOAT[1536]
        )
      `);
    } catch (e) {
      console.error('[migration] sqlite-vec setup error:', e);
    }
  }

  private parseChannelRow(row: { name: string; createdAt: string; archived: number; hidden: number; metadata: string | null; last_activity: string | null }): Channel {
    let metadata: ChannelMetadata | undefined;
    if (row.metadata) {
      try {
        metadata = JSON.parse(row.metadata);
      } catch {
        // Invalid JSON, ignore
      }
    }
    return {
      name: row.name,
      createdAt: row.createdAt,
      archived: !!row.archived,
      hidden: !!row.hidden,
      metadata,
      lastActivity: row.last_activity || undefined,
    };
  }

  // Channels
  createChannel(name: string, metadata?: ChannelMetadata): Channel {
    const existing = this.getChannel(name);
    if (existing) return existing;

    const channel: Channel = {
      name,
      createdAt: new Date().toISOString(),
      archived: false,
      metadata,
    };

    this.db
      .prepare("INSERT INTO channels (name, created_at, archived, metadata) VALUES (?, ?, 0, ?)")
      .run(name, channel.createdAt, metadata ? JSON.stringify(metadata) : null);

    return channel;
  }

  getOrCreateChannel(name: string): Channel {
    const existing = this.db
      .prepare("SELECT name, created_at as createdAt, archived, hidden, metadata, last_activity FROM channels WHERE name = ?")
      .get(name) as { name: string; createdAt: string; archived: number; hidden: number; metadata: string | null; last_activity: string | null } | undefined;

    if (existing) return this.parseChannelRow(existing);

    const channel: Channel = {
      name,
      createdAt: new Date().toISOString(),
      archived: false,
    };

    this.db
      .prepare("INSERT INTO channels (name, created_at, archived) VALUES (?, ?, 0)")
      .run(name, channel.createdAt);

    return channel;
  }

  getChannel(name: string): Channel | undefined {
    const row = this.db
      .prepare("SELECT name, created_at as createdAt, archived, hidden, metadata, last_activity FROM channels WHERE name = ?")
      .get(name) as { name: string; createdAt: string; archived: number; hidden: number; metadata: string | null; last_activity: string | null } | undefined;
    if (!row) return undefined;
    return this.parseChannelRow(row);
  }

  channelExists(name: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM channels WHERE name = ?")
      .get(name);
    return !!row;
  }

  listChannels(options: { includeArchived?: boolean; includeHidden?: boolean } = {}): Channel[] {
    const { includeArchived = false, includeHidden = false } = options;
    let sql = "SELECT name, created_at as createdAt, archived, hidden, metadata, last_activity FROM channels";
    const conditions: string[] = [];
    if (!includeArchived) conditions.push("archived = 0");
    if (!includeHidden) conditions.push("hidden = 0");
    if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY COALESCE(last_activity, created_at) DESC";
    const rows = this.db.prepare(sql).all() as { name: string; createdAt: string; archived: number; hidden: number; metadata: string | null; last_activity: string | null }[];
    return rows.map(row => this.parseChannelRow(row));
  }

  archiveChannel(name: string): boolean {
    const result = this.db
      .prepare("UPDATE channels SET archived = 1 WHERE name = ?")
      .run(name);
    return result.changes > 0;
  }

  unarchiveChannel(name: string): boolean {
    const result = this.db
      .prepare("UPDATE channels SET archived = 0 WHERE name = ?")
      .run(name);
    return result.changes > 0;
  }

  setChannelHidden(name: string, hidden: boolean): boolean {
    const result = this.db
      .prepare("UPDATE channels SET hidden = ? WHERE name = ?")
      .run(hidden ? 1 : 0, name);
    return result.changes > 0;
  }

  // Create the #root channel if it doesn't exist (hidden system channel)
  // Also adds the custodian agent to the roster if channel is newly created
  ensureRootChannel(): { channel: Channel; created: boolean } {
    const existing = this.getChannel("root");
    if (existing) return { channel: existing, created: false };

    const channel: Channel = {
      name: "root",
      createdAt: new Date().toISOString(),
      archived: false,
      hidden: true,
    };

    this.db
      .prepare("INSERT INTO channels (name, created_at, archived, hidden) VALUES (?, ?, 0, 1)")
      .run(channel.name, channel.createdAt);

    return { channel, created: true };
  }

  // Add custodian to #root roster (called after seeding artifacts)
  ensureRootCustodian(): void {
    const existing = this.getChannelAgent("root", "custodian");
    if (existing) return;

    this.addChannelAgent({
      channel: "root",
      name: "custodian",
      agentSlug: "custodian",
      engine: "claude",
      createdAt: new Date().toISOString(),
    });
  }

  getChannelMetadata(name: string): ChannelMetadata | undefined {
    const channel = this.getChannel(name);
    return channel?.metadata;
  }

  updateChannelMetadata(name: string, metadata: ChannelMetadata): boolean {
    // Merge with existing metadata
    const existing = this.getChannelMetadata(name) || {};
    const merged = { ...existing, ...metadata };
    const result = this.db
      .prepare("UPDATE channels SET metadata = ? WHERE name = ?")
      .run(JSON.stringify(merged), name);
    return result.changes > 0;
  }

  // Messages
  addMessage(channelName: string, sender: string, content: string, isUserMessage = false): Message {
    // Auto-create channel if it doesn't exist
    this.getOrCreateChannel(channelName);

    const message: Message = {
      id: uuid(),
      type: "message",
      channel: channelName,
      sender,
      timestamp: new Date().toISOString(),
      content,
    };

    this.db
      .prepare("INSERT INTO messages (id, channel, sender, content, timestamp, type) VALUES (?, ?, ?, ?, ?, 'message')")
      .run(message.id, message.channel, message.sender, message.content, message.timestamp);

    // Update channel's last activity if this is a user message (not from an agent)
    if (isUserMessage) {
      this.db
        .prepare("UPDATE channels SET last_activity = ? WHERE name = ?")
        .run(message.timestamp, channelName);
    }

    this.notifySubscribers(channelName);
    return message;
  }

  // Structured ask messages
  addStructuredAsk(channelName: string, sender: string, formData: StructuredAskFormData): StructuredAskMessage {
    // Auto-create channel if it doesn't exist
    this.getOrCreateChannel(channelName);

    const message: StructuredAskMessage = {
      id: uuid(),
      type: "structured_ask",
      channel: channelName,
      sender,
      timestamp: new Date().toISOString(),
      content: formData.prompt,
      formData,
      formState: "pending",
    };

    this.db
      .prepare(`
        INSERT INTO messages (id, channel, sender, content, timestamp, type, form_data, form_state)
        VALUES (?, ?, ?, ?, ?, 'structured_ask', ?, 'pending')
      `)
      .run(message.id, message.channel, message.sender, message.content, message.timestamp, JSON.stringify(formData));

    this.notifySubscribers(channelName);
    return message;
  }

  // Submit a structured ask response
  submitStructuredAskResponse(
    messageId: string,
    respondedBy: string,
    response: StructuredAskResponse
  ): StructuredAskMessage | null {
    const now = new Date().toISOString();

    // Update the message
    const result = this.db
      .prepare(`
        UPDATE messages
        SET form_state = 'submitted', response = ?, responded_by = ?, responded_at = ?
        WHERE id = ? AND type = 'structured_ask' AND form_state = 'pending'
      `)
      .run(JSON.stringify(response), respondedBy, now, messageId);

    if (result.changes === 0) {
      return null;  // Message not found, not a structured_ask, or already submitted
    }

    // Fetch and return the updated message
    const row = this.db
      .prepare(`
        SELECT id, channel, sender, content, timestamp, type, form_data, form_state, response, responded_by, responded_at
        FROM messages WHERE id = ?
      `)
      .get(messageId) as {
        id: string; channel: string; sender: string; content: string; timestamp: string;
        type: string; form_data: string; form_state: string; response: string;
        responded_by: string; responded_at: string;
      } | undefined;

    if (!row) return null;

    const message: StructuredAskMessage = {
      id: row.id,
      type: "structured_ask",
      channel: row.channel,
      sender: row.sender,
      timestamp: row.timestamp,
      content: row.content,
      formData: JSON.parse(row.form_data),
      formState: row.form_state as "pending" | "submitted",
      response: row.response ? JSON.parse(row.response) : undefined,
      respondedBy: row.responded_by,
      respondedAt: row.responded_at,
    };

    this.notifySubscribers(row.channel);
    return message;
  }

  // Get a single structured ask message by ID
  getStructuredAsk(messageId: string): StructuredAskMessage | null {
    const row = this.db
      .prepare(`
        SELECT id, channel, sender, content, timestamp, type, form_data, form_state, response, responded_by, responded_at
        FROM messages WHERE id = ? AND type = 'structured_ask'
      `)
      .get(messageId) as {
        id: string; channel: string; sender: string; content: string; timestamp: string;
        type: string; form_data: string; form_state: string; response: string | null;
        responded_by: string | null; responded_at: string | null;
      } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      type: "structured_ask",
      channel: row.channel,
      sender: row.sender,
      timestamp: row.timestamp,
      content: row.content,
      formData: JSON.parse(row.form_data),
      formState: row.form_state as "pending" | "submitted",
      response: row.response ? JSON.parse(row.response) : undefined,
      respondedBy: row.responded_by || undefined,
      respondedAt: row.responded_at || undefined,
    };
  }

  getMessages(channelName: string, limit?: number): AnyMessage[] {
    const sql = limit && limit > 0
      ? "SELECT id, channel, sender, content, timestamp, type, form_data, form_state, response, responded_by, responded_at FROM messages WHERE channel = ? ORDER BY timestamp DESC LIMIT ?"
      : "SELECT id, channel, sender, content, timestamp, type, form_data, form_state, response, responded_by, responded_at FROM messages WHERE channel = ? ORDER BY timestamp ASC";

    const rows = limit && limit > 0
      ? this.db.prepare(sql).all(channelName, limit) as Array<{
          id: string; channel: string; sender: string; content: string; timestamp: string;
          type: string | null; form_data: string | null; form_state: string | null;
          response: string | null; responded_by: string | null; responded_at: string | null;
        }>
      : this.db.prepare(sql).all(channelName) as Array<{
          id: string; channel: string; sender: string; content: string; timestamp: string;
          type: string | null; form_data: string | null; form_state: string | null;
          response: string | null; responded_by: string | null; responded_at: string | null;
        }>;

    // Parse messages based on type
    const messages: AnyMessage[] = rows.map(r => {
      if (r.type === "structured_ask" && r.form_data) {
        return {
          id: r.id,
          type: "structured_ask" as const,
          channel: r.channel,
          sender: r.sender,
          timestamp: r.timestamp,
          content: r.content,
          formData: JSON.parse(r.form_data),
          formState: (r.form_state || "pending") as "pending" | "submitted",
          response: r.response ? JSON.parse(r.response) : undefined,
          respondedBy: r.responded_by || undefined,
          respondedAt: r.responded_at || undefined,
        };
      }
      return {
        id: r.id,
        type: "message" as const,
        channel: r.channel,
        sender: r.sender,
        timestamp: r.timestamp,
        content: r.content,
      };
    });

    return limit && limit > 0 ? messages.reverse() : messages;
  }

  // Subscriptions for real-time updates (still in-memory, these don't need persistence)
  subscribeToMessages(channelName: string, callback: SubscriptionCallback): () => void {
    if (!this.messageSubscribers.has(channelName)) {
      this.messageSubscribers.set(channelName, new Set());
    }
    this.messageSubscribers.get(channelName)!.add(callback);
    return () => this.messageSubscribers.get(channelName)?.delete(callback);
  }

  private notifySubscribers(channelName: string) {
    this.messageSubscribers.get(channelName)?.forEach((cb) => cb());
  }

  // Channel Agents
  listChannelAgents(channel: string, includeDismissed = false): ChannelAgent[] {
    const sql = includeDismissed
      ? "SELECT channel, name, agent_slug, engine, created_at, dismissed FROM channel_agents WHERE channel = ?"
      : "SELECT channel, name, agent_slug, engine, created_at, dismissed FROM channel_agents WHERE channel = ? AND dismissed = 0";
    const rows = this.db.prepare(sql).all(channel) as {
      channel: string;
      name: string;
      agent_slug: string | null;
      engine: string;
      created_at: string;
      dismissed: number;
    }[];
    return rows.map(row => ({
      channel: row.channel,
      name: row.name,
      agentSlug: row.agent_slug || undefined,
      engine: row.engine,
      createdAt: row.created_at,
      dismissed: !!row.dismissed,
    }));
  }

  getChannelAgent(channel: string, name: string): ChannelAgent | undefined {
    const row = this.db.prepare("SELECT channel, name, agent_slug, engine, created_at, dismissed FROM channel_agents WHERE channel = ? AND name = ?").get(channel, name) as {
      channel: string;
      name: string;
      agent_slug: string | null;
      engine: string;
      created_at: string;
      dismissed: number;
    } | undefined;
    if (!row) return undefined;
    return {
      channel: row.channel,
      name: row.name,
      agentSlug: row.agent_slug || undefined,
      engine: row.engine,
      createdAt: row.created_at,
      dismissed: !!row.dismissed,
    };
  }

  addChannelAgent(agent: ChannelAgent): void {
    this.db
      .prepare("INSERT OR REPLACE INTO channel_agents (channel, name, agent_slug, engine, created_at, dismissed) VALUES (?, ?, ?, ?, ?, ?)")
      .run(agent.channel, agent.name, agent.agentSlug || null, agent.engine, agent.createdAt, agent.dismissed ? 1 : 0);
  }

  updateChannelAgent(channel: string, name: string, updates: Partial<Pick<ChannelAgent, 'agentSlug' | 'engine'>>): boolean {
    const sets: string[] = [];
    const values: (string | null)[] = [];

    if (updates.agentSlug !== undefined) {
      sets.push("agent_slug = ?");
      values.push(updates.agentSlug || null);
    }
    if (updates.engine !== undefined) {
      sets.push("engine = ?");
      values.push(updates.engine);
    }

    if (sets.length === 0) return false;

    values.push(channel, name);
    const result = this.db.prepare(`UPDATE channel_agents SET ${sets.join(", ")} WHERE channel = ? AND name = ?`).run(...values);
    return result.changes > 0;
  }

  dismissChannelAgent(channel: string, name: string): boolean {
    const result = this.db.prepare("UPDATE channel_agents SET dismissed = 1 WHERE channel = ? AND name = ?").run(channel, name);
    return result.changes > 0;
  }

  undismissChannelAgent(channel: string, name: string): boolean {
    const result = this.db.prepare("UPDATE channel_agents SET dismissed = 0 WHERE channel = ? AND name = ?").run(channel, name);
    return result.changes > 0;
  }

  removeChannelAgent(channel: string, name: string): boolean {
    const result = this.db.prepare("DELETE FROM channel_agents WHERE channel = ? AND name = ?").run(channel, name);
    return result.changes > 0;
  }

  removeAllChannelAgents(channel: string): number {
    const result = this.db.prepare("DELETE FROM channel_agents WHERE channel = ?").run(channel);
    return result.changes;
  }

  // Artifacts

  // Event callback types for SSE integration
  private artifactEventSubscribers: Map<string, Set<(event: { action: string; artifact: Artifact }) => void>> = new Map();
  private versionEventSubscribers: Map<string, Set<(event: { slug: string; version: string; message?: string; mentions: string[] }) => void>> = new Map();

  private parseArtifactRow(row: {
    id: string;
    slug: string;
    channel: string;
    path: string;
    title: string | null;
    tldr: string | null;
    type: string;
    content: string;
    content_type: string | null;
    encoding: string | null;
    refs: string | null;
    status: string;
    parent_slug: string | null;
    order_key: string;
    labels: string | null;
    assignees: string | null;
    props: string | null;
    needs_description: number;
    created_by: string;
    created_at: string;
    updated_by: string | null;
    updated_at: string | null;
    version: number;
  }): Artifact {
    return {
      id: row.id,
      slug: row.slug,
      channel: row.channel,
      path: row.path,
      title: row.title || undefined,
      tldr: row.tldr || undefined,
      type: row.type,
      content: row.content,
      contentType: row.content_type || undefined,
      encoding: row.encoding || undefined,
      refs: row.refs ? JSON.parse(row.refs) : [],
      status: row.status as Status,
      parentSlug: row.parent_slug || undefined,
      orderKey: row.order_key,
      labels: row.labels ? JSON.parse(row.labels) : [],
      assignees: row.assignees ? JSON.parse(row.assignees) : [],
      props: row.props ? JSON.parse(row.props) : undefined,
      needsDescription: row.needs_description === 1 ? true : undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedBy: row.updated_by || undefined,
      updatedAt: row.updated_at || undefined,
      version: row.version,
    };
  }

  // Extract [[slug]] and [[#channel/slug]] references from content
  private extractRefs(content: string): string[] {
    const refs: string[] = [];
    const regex = /\[\[([^\]]+)\]\]/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      refs.push(match[1]);
    }
    return [...new Set(refs)]; // Deduplicate
  }

  // Extract @mentions from content
  private extractMentions(content: string): string[] {
    const mentions: string[] = [];
    const regex = /@([\w-]+)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (match[1] !== 'channel') { // Skip @channel
        mentions.push(match[1]);
      }
    }
    return [...new Set(mentions)]; // Deduplicate
  }

  // Compute path from parentSlug chain
  private computePath(channel: string, slug: string, parentSlug?: string): string {
    if (!parentSlug) {
      return `/${slug}`;
    }
    const parent = this.getArtifact(channel, parentSlug);
    if (!parent) {
      return `/${slug}`;
    }
    return `${parent.path}/${slug}`;
  }

  // Validate status based on artifact type
  private validateStatus(type: string, status: Status): boolean {
    const baseStatuses: Status[] = ["draft", "published", "archived"];
    const taskStatuses: Status[] = ["pending", "in_progress", "done", "blocked"];

    if (type === "task") {
      return [...baseStatuses, ...taskStatuses].includes(status);
    }
    return baseStatuses.includes(status);
  }

// Validate props based on artifact type using Zod schemas + additional checks
  // For system.focus, strict validation only applies when status is "published"
  private validateProps(type: string, props?: Record<string, unknown>, parentSlug?: string, status?: Status): void {
    // Use Zod-based validation for types with schemas (system.mcp, system.agent)
    // This throws with a formatted error message if validation fails
    assertValidProps(type, props);

    // Additional validation for system.agent: cannot be child of system.focus
    if (type === "system.agent" && parentSlug) {
      const parent = this.getArtifact("root", parentSlug);
      if (parent?.type === "system.focus") {
        throw new Error("system.agent cannot be a child of system.focus. Use props.agents to specify agents.");
      }
    }

    // system.focus requires props.agents array (only enforced when published)
    if (type === "system.focus") {
      const isPublished = status === "published";

      // Strict validation only for published focus artifacts
      if (isPublished) {
        if (!props) {
          throw new Error("system.focus requires props with 'agents' array specified");
        }
        if (!props.agents || !Array.isArray(props.agents)) {
          throw new Error("system.focus requires props.agents as an array");
        }
        if (props.agents.length === 0) {
          throw new Error("system.focus props.agents must be non-empty");
        }

        // Validate each agent slug references a valid system.agent in #root
        const validAgents = this.listArtifacts("root", { type: "system.agent" });
        const validSlugs = new Set(validAgents.map(a => a.slug));

        for (const agentSlug of props.agents) {
          if (typeof agentSlug !== "string") {
            throw new Error("system.focus props.agents must contain string slugs");
          }
          if (!validSlugs.has(agentSlug)) {
            throw new Error(`system.focus props.agents contains invalid agent slug '${agentSlug}'. Must reference a system.agent in #root.`);
          }
        }
      }

      // Type validation for optional fields (always check if present)
      if (props) {
        if (props.agents !== undefined && !Array.isArray(props.agents)) {
          throw new Error("system.focus props.agents must be an array");
        }
        if (props.defaultTagline !== undefined && typeof props.defaultTagline !== "string") {
          throw new Error("system.focus props.defaultTagline must be a string");
        }
        if (props.defaultMission !== undefined && typeof props.defaultMission !== "string") {
          throw new Error("system.focus props.defaultMission must be a string");
        }
        if (props.initialPrompt !== undefined && typeof props.initialPrompt !== "string") {
          throw new Error("system.focus props.initialPrompt must be a string");
        }
      }
    }
    // system.playbook has no required props (content is the playbook)
    // Other types don't have required props validation
  }

  // Get structured validation error for props (for MCP tool responses)
  validatePropsStructured(type: string, props?: Record<string, unknown>): PropsValidationError | undefined {
    return validateArtifactProps(type, props);
  }

  createArtifact(artifact: Omit<Artifact, "id" | "createdAt" | "version" | "path" | "refs" | "orderKey"> & { encoding?: string }): Artifact {
    // Ensure channel exists
    this.getOrCreateChannel(artifact.channel);

    // Validate knowledgebase type constraints
    if (artifact.type === "knowledgebase") {
      // Constraint 1: slug must be 'knowledgebase'
      if (artifact.slug !== "knowledgebase") {
        throw new Error("Knowledgebase artifact must have slug 'knowledgebase'");
      }
      // Constraint 2: only one per channel
      const existing = this.getArtifact(artifact.channel, "knowledgebase");
      if (existing) {
        throw new Error(`Channel '${artifact.channel}' already has a knowledgebase`);
      }
    }

    // Validate that children of knowledgebase are doc type only
    if (artifact.parentSlug === "knowledgebase") {
      const parent = this.getArtifact(artifact.channel, "knowledgebase");
      if (parent && parent.type === "knowledgebase" && artifact.type !== "doc") {
        throw new Error("Children of knowledgebase must be type 'doc'");
      }
    }

    // Validate status based on type
    // system.focus defaults to draft (requires configuration before publishing)
    const defaultStatus = artifact.type === "system.focus" ? "draft" : "published";
    const status = artifact.status || defaultStatus;
    if (!this.validateStatus(artifact.type, status)) {
      throw new Error(`Invalid status '${status}' for artifact type '${artifact.type}'`);
    }

    // Validate props based on type
    this.validateProps(artifact.type, artifact.props, artifact.parentSlug, status);

    const now = new Date().toISOString();
    const refs = this.extractRefs(artifact.content);
    const path = this.computePath(artifact.channel, artifact.slug, artifact.parentSlug);

    // Generate orderKey - append after last sibling
    const siblings = this.listArtifacts(artifact.channel, { parentSlug: artifact.parentSlug || null });
    const lastSiblingKey = siblings.length > 0 ? siblings[siblings.length - 1].orderKey : null;
    const orderKey = generateKeyBetween(lastSiblingKey, null);

    const newArtifact: Artifact = {
      ...artifact,
      id: uuid(),
      path,
      refs,
      status,
      orderKey,
      createdAt: now,
      version: 1,
    };

    this.db
      .prepare(`
        INSERT INTO artifacts (
          id, slug, channel, path, title, tldr, type, content, content_type, encoding,
          refs, status, parent_slug, order_key, labels, assignees, props, needs_description,
          created_by, created_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        newArtifact.id,
        newArtifact.slug,
        newArtifact.channel,
        newArtifact.path,
        newArtifact.title || null,
        newArtifact.tldr || null,
        newArtifact.type,
        newArtifact.content,
        newArtifact.contentType || null,
        newArtifact.encoding || null,
        JSON.stringify(newArtifact.refs),
        newArtifact.status,
        newArtifact.parentSlug || null,
        newArtifact.orderKey,
        JSON.stringify(newArtifact.labels || []),
        JSON.stringify(newArtifact.assignees || []),
        newArtifact.props ? JSON.stringify(newArtifact.props) : null,
        newArtifact.needsDescription ? 1 : 0,
        newArtifact.createdBy,
        newArtifact.createdAt,
        newArtifact.version
      );

    this.notifyArtifactEventSubscribers(artifact.channel, "created", newArtifact);

    // Emit system message for task creation with assignees
    if (newArtifact.type === "task" && newArtifact.assignees && newArtifact.assignees.length > 0) {
      const mentions = newArtifact.assignees.map(a => `@${a}`).join(" ");
      this.addMessage(artifact.channel, "system", `@${newArtifact.createdBy} assigned [[${newArtifact.slug}]] to ${mentions}`);
    }

    return newArtifact;
  }

  getArtifact(channel: string, slug: string): Artifact | undefined {
    const row = this.db
      .prepare(`
        SELECT id, slug, channel, path, title, tldr, type, content, content_type, encoding,
               refs, status, parent_slug, order_key, labels, assignees, props, needs_description,
               created_by, created_at, updated_by, updated_at, version
        FROM artifacts WHERE channel = ? AND slug = ?
      `)
      .get(channel, slug) as any;
    if (!row) return undefined;
    return this.parseArtifactRow(row);
  }

  getArtifactById(id: string): Artifact | undefined {
    const row = this.db
      .prepare(`
        SELECT id, slug, channel, path, title, tldr, type, content, content_type, encoding,
               refs, status, parent_slug, order_key, labels, assignees, props, needs_description,
               created_by, created_at, updated_by, updated_at, version
        FROM artifacts WHERE id = ?
      `)
      .get(id) as any;
    if (!row) return undefined;
    return this.parseArtifactRow(row);
  }

  getArtifactByPath(channel: string, path: string): Artifact | undefined {
    const row = this.db
      .prepare(`
        SELECT id, slug, channel, path, title, tldr, type, content, content_type, encoding,
               refs, status, parent_slug, order_key, labels, assignees, props, needs_description,
               created_by, created_at, updated_by, updated_at, version
        FROM artifacts WHERE channel = ? AND path = ?
      `)
      .get(channel, path) as any;
    if (!row) return undefined;
    return this.parseArtifactRow(row);
  }

  listArtifacts(channel: string, filters?: {
    type?: string;
    status?: Status;
    assignee?: string;
    parentSlug?: string | null;  // null = root artifacts only, string = children of that parent
    search?: string;  // Basic LIKE search on slug, tldr, content, and labels
    regex?: string;  // Regex search on slug, title, tldr, content, and labels
    limit?: number;
    offset?: number;
  }): Artifact[] {
    let sql = `
      SELECT id, slug, channel, path, title, tldr, type, content, content_type, encoding,
             refs, status, parent_slug, order_key, labels, assignees, props, needs_description,
             created_by, created_at, updated_by, updated_at, version
      FROM artifacts WHERE channel = ?
    `;
    const params: any[] = [channel];

    if (filters?.type) {
      sql += " AND type = ?";
      params.push(filters.type);
    }
    if (filters?.status) {
      sql += " AND status = ?";
      params.push(filters.status);
    }
    if (filters?.assignee) {
      // Search in JSON array
      sql += " AND assignees LIKE ?";
      params.push(`%"${filters.assignee}"%`);
    }
    if (filters?.parentSlug !== undefined) {
      if (filters.parentSlug === null) {
        // Root artifacts only (no parent)
        sql += " AND parent_slug IS NULL";
      } else {
        // Children of specific parent
        sql += " AND parent_slug = ?";
        params.push(filters.parentSlug);
      }
    }
    if (filters?.search) {
      // Basic LIKE search on slug, tldr, content, and labels
      sql += " AND (slug LIKE ? OR tldr LIKE ? OR content LIKE ? OR labels LIKE ?)";
      const pattern = `%${filters.search}%`;
      params.push(pattern, pattern, pattern, pattern);
    }
    if (filters?.regex) {
      // Regex search on slug, title, tldr, content, and labels
      sql += " AND (regexp(?, slug) OR regexp(?, COALESCE(title, '')) OR regexp(?, COALESCE(tldr, '')) OR regexp(?, COALESCE(content, '')) OR regexp(?, COALESCE(labels, '')))";
      params.push(filters.regex, filters.regex, filters.regex, filters.regex, filters.regex);
    }

    // Sort by parent then order_key for proper tree ordering
    sql += " ORDER BY COALESCE(parent_slug, '') ASC, order_key ASC";

    if (filters?.limit) {
      sql += " LIMIT ?";
      params.push(filters.limit);
      if (filters?.offset) {
        sql += " OFFSET ?";
        params.push(filters.offset);
      }
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map(row => this.parseArtifactRow(row));
  }

  // Full-text search using FTS5 with BM25 ranking
  // Column weights: title 10x, tldr 5x, content 1x, slug 2x
  searchArtifactsFTS(query: string, options?: {
    channel?: string;       // Filter by channel (optional - searches all if not specified)
    type?: string;          // Filter by artifact type
    status?: Status;        // Filter by status
    limit?: number;         // Max results (default 50)
    offset?: number;        // Pagination offset
    highlight?: boolean;    // Include highlighted snippets
  }): (Artifact & { rank: number; snippet?: string })[] {
    if (!query || query.trim() === '') {
      return [];
    }

    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    // Build the FTS5 query
    // BM25 weights: slug(2), title(10), tldr(5), content(1)
    let sql = `
      SELECT
        a.id, a.slug, a.channel, a.path, a.title, a.tldr, a.type, a.content,
        a.content_type, a.encoding, a.refs, a.status, a.parent_slug, a.order_key,
        a.labels, a.assignees, a.props, a.created_by, a.created_at,
        a.updated_by, a.updated_at, a.version,
        bm25(artifacts_fts, 2.0, 10.0, 5.0, 1.0, 0.0) as rank
    `;

    if (options?.highlight) {
      sql += `,
        snippet(artifacts_fts, 3, '<mark>', '</mark>', '...', 32) as snippet
      `;
    }

    sql += `
      FROM artifacts a
      JOIN artifacts_fts ON artifacts_fts.rowid = a.rowid
      WHERE artifacts_fts MATCH ?
    `;

    const params: any[] = [query];

    if (options?.channel) {
      sql += ` AND a.channel = ?`;
      params.push(options.channel);
    }

    if (options?.type) {
      sql += ` AND a.type = ?`;
      params.push(options.type);
    }

    if (options?.status) {
      sql += ` AND a.status = ?`;
      params.push(options.status);
    }

    // Order by relevance (lower BM25 score = more relevant)
    sql += ` ORDER BY rank`;

    sql += ` LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    try {
      const rows = this.db.prepare(sql).all(...params) as any[];
      return rows.map(row => ({
        ...this.parseArtifactRow(row),
        rank: row.rank,
        snippet: row.snippet,
      }));
    } catch (e) {
      // FTS5 query syntax error - return empty results
      console.error('[FTS5] Search error:', e);
      return [];
    }
  }

  updateArtifact(
    channel: string,
    slug: string,
    updates: Partial<Pick<Artifact, "title" | "tldr" | "content" | "contentType" | "status" | "parentSlug" | "orderKey" | "labels" | "assignees" | "props" | "needsDescription">> & { updatedBy: string },
    expectedVersion?: number
  ): Artifact | null {
    const existing = this.getArtifact(channel, slug);
    if (!existing) return null;

    // Optimistic locking: check version if provided
    if (expectedVersion !== undefined && existing.version !== expectedVersion) {
      throw new Error(`Version conflict: expected ${expectedVersion}, got ${existing.version}`);
    }

    // Validate knowledgebase children constraint when reparenting
    if (updates.parentSlug !== undefined && updates.parentSlug === "knowledgebase") {
      const parent = this.getArtifact(channel, "knowledgebase");
      if (parent && parent.type === "knowledgebase" && existing.type !== "doc") {
        throw new Error("Children of knowledgebase must be type 'doc'");
      }
    }

    // Validate status if provided
    if (updates.status && !this.validateStatus(existing.type, updates.status)) {
      throw new Error(`Invalid status '${updates.status}' for artifact type '${existing.type}'`);
    }

    // Validate props - either when props are updated OR when status changes to published
    const newStatus = updates.status ?? existing.status;
    const parentSlugForValidation = updates.parentSlug !== undefined ? updates.parentSlug : existing.parentSlug;
    const propsToValidate = updates.props !== undefined ? updates.props : existing.props;

    // Always validate when publishing, or when props are explicitly updated
    if (updates.props !== undefined || (updates.status === "published" && existing.status !== "published")) {
      this.validateProps(existing.type, propsToValidate, parentSlugForValidation, newStatus);
    }

    const now = new Date().toISOString();
    const newVersion = existing.version + 1;

    // Re-extract refs if content changed
    const newContent = updates.content ?? existing.content;
    const refs = updates.content ? this.extractRefs(newContent) : existing.refs;

    // Recompute path if parentSlug changed
    const newParentSlug = updates.parentSlug !== undefined ? updates.parentSlug : existing.parentSlug;
    const path = updates.parentSlug !== undefined
      ? this.computePath(channel, slug, newParentSlug)
      : existing.path;

    // Handle orderKey: use provided value, or generate new one if parent changed
    let orderKey = existing.orderKey;
    if (updates.orderKey !== undefined) {
      orderKey = updates.orderKey;
    } else if (updates.parentSlug !== undefined && updates.parentSlug !== existing.parentSlug) {
      // Parent changed, append to end of new siblings
      const newSiblings = this.listArtifacts(channel, { parentSlug: newParentSlug || null })
        .filter(a => a.slug !== slug); // Exclude self
      const lastSiblingKey = newSiblings.length > 0 ? newSiblings[newSiblings.length - 1].orderKey : null;
      orderKey = generateKeyBetween(lastSiblingKey, null);
    }

    this.db
      .prepare(`
        UPDATE artifacts SET
          title = COALESCE(?, title),
          tldr = COALESCE(?, tldr),
          content = COALESCE(?, content),
          content_type = COALESCE(?, content_type),
          refs = ?,
          status = COALESCE(?, status),
          parent_slug = ?,
          path = ?,
          order_key = ?,
          labels = COALESCE(?, labels),
          assignees = COALESCE(?, assignees),
          props = COALESCE(?, props),
          needs_description = COALESCE(?, needs_description),
          updated_by = ?,
          updated_at = ?,
          version = ?
        WHERE channel = ? AND slug = ?
      `)
      .run(
        updates.title ?? null,
        updates.tldr ?? null,
        updates.content ?? null,
        updates.contentType ?? null,
        JSON.stringify(refs),
        updates.status ?? null,
        newParentSlug ?? null,
        path,
        orderKey,
        updates.labels ? JSON.stringify(updates.labels) : null,
        updates.assignees ? JSON.stringify(updates.assignees) : null,
        updates.props ? JSON.stringify(updates.props) : null,
        updates.needsDescription !== undefined ? (updates.needsDescription ? 1 : 0) : null,
        updates.updatedBy,
        now,
        newVersion,
        channel,
        slug
      );

    const updated = this.getArtifact(channel, slug)!;

    // Update descendant paths if parentSlug changed
    if (updates.parentSlug !== undefined) {
      this.updateDescendantPaths(channel, slug);
    }

    this.notifyArtifactEventSubscribers(channel, "updated", updated);

    // Emit system messages for task status/assignee changes
    if (existing.type === "task") {
      const updater = updates.updatedBy;
      const currentAssignees = updated.assignees || [];
      const mentions = currentAssignees.length > 0 ? " " + currentAssignees.map(a => `@${a}`).join(" ") : "";

      // Status change
      if (updates.status && updates.status !== existing.status) {
        this.addMessage(channel, "system", `@${updater} changed [[${slug}]]: ${existing.status} → ${updates.status}${mentions}`);
      }

      // Assignee change
      if (updates.assignees !== undefined) {
        const oldAssignees = existing.assignees || [];
        const newAssignees = updates.assignees || [];
        const added = newAssignees.filter(a => !oldAssignees.includes(a));
        const removed = oldAssignees.filter(a => !newAssignees.includes(a));

        if (added.length > 0) {
          const addedMentions = added.map(a => `@${a}`).join(" ");
          this.addMessage(channel, "system", `@${updater} assigned [[${slug}]] to ${addedMentions}`);
        }
        if (removed.length > 0) {
          const removedMentions = removed.map(a => `@${a}`).join(" ");
          this.addMessage(channel, "system", `@${updater} unassigned ${removedMentions} from [[${slug}]]`);
        }
      }
    }

    return updated;
  }

  // Update paths for all descendants of an artifact
  private updateDescendantPaths(channel: string, parentSlug: string): void {
    const children = this.listArtifacts(channel, { parentSlug });
    for (const child of children) {
      const newPath = this.computePath(channel, child.slug, parentSlug);
      this.db
        .prepare(`UPDATE artifacts SET path = ? WHERE channel = ? AND slug = ?`)
        .run(newPath, channel, child.slug);
      // Recursively update children
      this.updateDescendantPaths(channel, child.slug);
    }
  }

  archiveArtifact(channel: string, slug: string, archivedBy: string): boolean {
    const existing = this.getArtifact(channel, slug);
    if (!existing) return false;

    const result = this.updateArtifact(channel, slug, {
      status: "archived",
      updatedBy: archivedBy,
    });
    return result !== null;
  }

  deleteArtifact(channel: string, slug: string): boolean {
    const existing = this.getArtifact(channel, slug);
    if (!existing) return false;

    const result = this.db
      .prepare("DELETE FROM artifacts WHERE channel = ? AND slug = ?")
      .run(channel, slug);
    if (result.changes > 0) {
      this.notifyArtifactEventSubscribers(channel, "deleted", existing);
      return true;
    }
    return false;
  }

  // Backwards-compatible upsert method (deprecated - use createArtifact or replaceArtifact)
  // This maintains compatibility with existing MCP tools until they're replaced
  publishArtifact(
    artifact: {
      channel: string;
      name: string;  // Maps to slug
      type: string;
      content: string;
      contentType?: string;
      status?: Status;
      taskStatus?: TaskStatus;  // Mapped to status for task types
      labels?: string[];
      assignees?: string[];
      parentId?: string;  // Maps to parentSlug
      messageRef?: string;  // Ignored in new schema
      createdBy: string;
    }
  ): Artifact & { name: string; taskStatus?: TaskStatus; parentId?: string; messageRef?: string } {
    const existing = this.getArtifact(artifact.channel, artifact.name);

    // Map taskStatus to status for task types
    // system.focus defaults to draft, others to published
    const defaultStatus: Status = artifact.type === "system.focus" ? "draft" : "published";
    let status: Status = artifact.status || defaultStatus;
    if (artifact.type === "task" && artifact.taskStatus) {
      status = artifact.taskStatus;
    }

    // Generate tldr from first line of content
    const tldr = artifact.content.split('\n')[0].slice(0, 200) || artifact.content.slice(0, 200);

    if (existing) {
      // Update existing
      const updated = this.updateArtifact(artifact.channel, artifact.name, {
        content: artifact.content,
        contentType: artifact.contentType,
        status,
        labels: artifact.labels,
        assignees: artifact.assignees,
        parentSlug: artifact.parentId,
        tldr,
        updatedBy: artifact.createdBy,
      })!;
      // Return with backwards-compatible fields
      return {
        ...updated,
        name: updated.slug,
        taskStatus: updated.type === "task" ? updated.status as TaskStatus : undefined,
        parentId: updated.parentSlug,
        messageRef: undefined,
      };
    } else {
      // Create new
      const created = this.createArtifact({
        slug: artifact.name,
        channel: artifact.channel,
        type: artifact.type,
        content: artifact.content,
        contentType: artifact.contentType,
        status,
        tldr,
        labels: artifact.labels,
        assignees: artifact.assignees,
        parentSlug: artifact.parentId,
        createdBy: artifact.createdBy,
      });
      // Return with backwards-compatible fields
      return {
        ...created,
        name: created.slug,
        taskStatus: created.type === "task" ? created.status as TaskStatus : undefined,
        parentId: created.parentSlug,
        messageRef: undefined,
      };
    }
  }

  // Replace artifact content entirely (for create tool with replace: true)
  replaceArtifact(
    channel: string,
    slug: string,
    replacement: Omit<Artifact, "id" | "slug" | "channel" | "createdAt" | "createdBy" | "version" | "path" | "refs">,
    updatedBy: string
  ): Artifact | null {
    const existing = this.getArtifact(channel, slug);
    if (!existing) return null;

    // Validate knowledgebase type constraints
    if (replacement.type === "knowledgebase" && slug !== "knowledgebase") {
      throw new Error("Knowledgebase artifact must have slug 'knowledgebase'");
    }

    // Validate knowledgebase children constraint when reparenting
    if (replacement.parentSlug === "knowledgebase") {
      const parent = this.getArtifact(channel, "knowledgebase");
      if (parent && parent.type === "knowledgebase" && replacement.type !== "doc") {
        throw new Error("Children of knowledgebase must be type 'doc'");
      }
    }

    // Validate status
    if (!this.validateStatus(replacement.type, replacement.status)) {
      throw new Error(`Invalid status '${replacement.status}' for artifact type '${replacement.type}'`);
    }

    // Validate props
    this.validateProps(replacement.type, replacement.props, replacement.parentSlug, replacement.status);

    const now = new Date().toISOString();
    const refs = this.extractRefs(replacement.content);
    const path = this.computePath(channel, slug, replacement.parentSlug);

    // Handle orderKey: use provided or keep existing, regenerate if parent changed
    let orderKey = replacement.orderKey || existing.orderKey;
    if (!replacement.orderKey && replacement.parentSlug !== existing.parentSlug) {
      const newSiblings = this.listArtifacts(channel, { parentSlug: replacement.parentSlug || null })
        .filter(a => a.slug !== slug);
      const lastSiblingKey = newSiblings.length > 0 ? newSiblings[newSiblings.length - 1].orderKey : null;
      orderKey = generateKeyBetween(lastSiblingKey, null);
    }

    this.db
      .prepare(`
        UPDATE artifacts SET
          title = ?,
          tldr = ?,
          type = ?,
          content = ?,
          content_type = ?,
          refs = ?,
          status = ?,
          parent_slug = ?,
          path = ?,
          order_key = ?,
          labels = ?,
          assignees = ?,
          props = ?,
          needs_description = ?,
          updated_by = ?,
          updated_at = ?,
          version = version + 1
        WHERE channel = ? AND slug = ?
      `)
      .run(
        replacement.title || null,
        replacement.tldr || null,
        replacement.type,
        replacement.content,
        replacement.contentType || null,
        JSON.stringify(refs),
        replacement.status,
        replacement.parentSlug || null,
        path,
        orderKey,
        JSON.stringify(replacement.labels || []),
        JSON.stringify(replacement.assignees || []),
        replacement.props ? JSON.stringify(replacement.props) : null,
        replacement.needsDescription ? 1 : 0,
        updatedBy,
        now,
        channel,
        slug
      );

    const updated = this.getArtifact(channel, slug)!;
    this.notifyArtifactEventSubscribers(channel, "updated", updated);
    return updated;
  }

  // Subscriptions for artifact events (with action + artifact payload for SSE)
  subscribeToArtifactEvents(channelName: string, callback: (event: { action: string; artifact: Artifact }) => void): () => void {
    if (!this.artifactEventSubscribers.has(channelName)) {
      this.artifactEventSubscribers.set(channelName, new Set());
    }
    this.artifactEventSubscribers.get(channelName)!.add(callback);
    return () => this.artifactEventSubscribers.get(channelName)?.delete(callback);
  }

  private notifyArtifactEventSubscribers(channelName: string, action: string, artifact: Artifact) {
    this.artifactEventSubscribers.get(channelName)?.forEach((cb) => cb({ action, artifact }));
    // Also notify legacy subscribers
    this.artifactSubscribers.get(channelName)?.forEach((cb) => cb());
  }

  // Subscriptions for version events (for SSE artifact_version events)
  subscribeToVersionEvents(channelName: string, callback: (event: { slug: string; version: string; message?: string; mentions: string[] }) => void): () => void {
    if (!this.versionEventSubscribers.has(channelName)) {
      this.versionEventSubscribers.set(channelName, new Set());
    }
    this.versionEventSubscribers.get(channelName)!.add(callback);
    return () => this.versionEventSubscribers.get(channelName)?.delete(callback);
  }

  private notifyVersionEventSubscribers(channelName: string, event: { slug: string; version: string; message?: string; mentions: string[] }) {
    this.versionEventSubscribers.get(channelName)?.forEach((cb) => cb(event));
  }

  // Get artifact summary for injection into agent context
  getArtifactSummary(channel: string): string {
    const artifacts = this.listArtifacts(channel);
    if (artifacts.length === 0) return "";

    const lines = artifacts
      .filter(a => a.status !== "archived")
      .map(a => {
        const desc = `- ${a.path} (${a.type}, ${a.status}) - ${a.tldr}`;
        return desc;
      });

    return `## Channel Artifacts\n${lines.join("\n")}`;
  }

  // === Artifact Versions ===

  // Create a named version snapshot (checkpoint)
  createVersion(
    channel: string,
    slug: string,
    versionName: string,
    message: string | undefined,
    createdBy: string
  ): ArtifactVersion | null {
    const artifact = this.getArtifact(channel, slug);
    if (!artifact) return null;

    // Check if version name already exists
    const existing = this.getVersion(channel, slug, versionName);
    if (existing) {
      throw new Error(`Version '${versionName}' already exists for artifact '${slug}'`);
    }

    const now = new Date().toISOString();
    const mentions = this.extractMentions(artifact.content);

    const version: ArtifactVersion = {
      id: uuid(),
      artifactId: artifact.id,
      versionName,
      message,
      content: artifact.content,
      tldr: artifact.tldr,
      createdBy,
      createdAt: now,
      mentions,
    };

    this.db
      .prepare(`
        INSERT INTO artifact_versions (
          id, artifact_id, version_name, message, content, tldr, created_by, created_at, mentions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        version.id,
        version.artifactId,
        version.versionName,
        version.message || null,
        version.content,
        version.tldr || null,
        version.createdBy,
        version.createdAt,
        JSON.stringify(version.mentions)
      );

    // Notify version event subscribers
    this.notifyVersionEventSubscribers(channel, {
      slug,
      version: versionName,
      message,
      mentions,
    });

    return version;
  }

  // Get a specific version
  getVersion(channel: string, slug: string, versionName: string): ArtifactVersion | null {
    const artifact = this.getArtifact(channel, slug);
    if (!artifact) return null;

    const row = this.db
      .prepare(`
        SELECT id, artifact_id, version_name, message, content, tldr, created_by, created_at, mentions
        FROM artifact_versions
        WHERE artifact_id = ? AND version_name = ?
      `)
      .get(artifact.id, versionName) as any;

    if (!row) return null;

    return {
      id: row.id,
      artifactId: row.artifact_id,
      versionName: row.version_name,
      message: row.message || undefined,
      content: row.content,
      tldr: row.tldr || undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
      mentions: row.mentions ? JSON.parse(row.mentions) : [],
    };
  }

  // List all versions for an artifact
  listVersions(channel: string, slug: string): ArtifactVersion[] {
    const artifact = this.getArtifact(channel, slug);
    if (!artifact) return [];

    const rows = this.db
      .prepare(`
        SELECT id, artifact_id, version_name, message, content, tldr, created_by, created_at, mentions
        FROM artifact_versions
        WHERE artifact_id = ?
        ORDER BY created_at ASC
      `)
      .all(artifact.id) as any[];

    return rows.map(row => ({
      id: row.id,
      artifactId: row.artifact_id,
      versionName: row.version_name,
      message: row.message || undefined,
      content: row.content,
      tldr: row.tldr || undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
      mentions: row.mentions ? JSON.parse(row.mentions) : [],
    }));
  }

  // Get version names only (for lightweight queries)
  getVersionNames(channel: string, slug: string): string[] {
    const artifact = this.getArtifact(channel, slug);
    if (!artifact) return [];

    const rows = this.db
      .prepare(`
        SELECT version_name FROM artifact_versions
        WHERE artifact_id = ?
        ORDER BY created_at ASC
      `)
      .all(artifact.id) as { version_name: string }[];

    return rows.map(r => r.version_name);
  }

  // Copy an artifact from one channel to another
  copyArtifact(
    fromChannel: string,
    slug: string,
    toChannel: string,
    newSlug: string | undefined,
    copiedBy: string,
    parentSlug?: string  // Optional: set parent in target channel
  ): Artifact | null {
    const source = this.getArtifact(fromChannel, slug);
    if (!source) return null;

    const targetSlug = newSlug || slug;

    // Check if target already exists
    const existing = this.getArtifact(toChannel, targetSlug);
    if (existing) {
      throw new Error(`Artifact '${targetSlug}' already exists in channel '${toChannel}'`);
    }

    // Create a copy in the target channel
    return this.createArtifact({
      slug: targetSlug,
      channel: toChannel,
      title: source.title,
      tldr: source.tldr,
      type: source.type,
      content: source.content,
      contentType: source.contentType,
      status: source.status,
      labels: source.labels,
      assignees: [], // Don't copy assignees - new channel, new team
      props: source.props,
      parentSlug,  // Use provided parent (for hierarchical copies)
      createdBy: copiedBy,
    });
  }

  // Copy all children of a focus artifact to a target channel (recursive)
  // Used during channel creation with focus to copy board templates
  copyFocusChildren(
    focusSlug: string,
    targetChannel: string,
    copiedBy: string
  ): { copied: string[] } {
    const copied: string[] = [];

    // Helper function to recursively copy an artifact and its children
    const copyWithChildren = (sourceSlug: string, targetParentSlug?: string) => {
      const source = this.getArtifact("root", sourceSlug);
      if (!source) return;

      // Copy the artifact itself
      try {
        this.copyArtifact("root", sourceSlug, targetChannel, undefined, copiedBy, targetParentSlug);
        copied.push(sourceSlug);
      } catch (e) {
        // Skip if artifact already exists (idempotent)
        const error = e as Error;
        if (!error.message.includes("already exists")) {
          throw e;
        }
      }

      // Find and copy children
      const children = this.listArtifacts("root", { parentSlug: sourceSlug });
      for (const child of children) {
        copyWithChildren(child.slug, sourceSlug);
      }
    };

    // Get direct children of the focus artifact
    const focusChildren = this.listArtifacts("root", { parentSlug: focusSlug });

    for (const child of focusChildren) {
      copyWithChildren(child.slug, undefined);  // Root level in target channel
    }

    return { copied };
  }

  // Get artifact with fallback to #root channel (for system artifacts)
  getArtifactWithFallback(channel: string, slug: string): Artifact | undefined {
    const result = this.getArtifactWithFallbackAndSource(channel, slug);
    return result?.artifact;
  }

  // Get artifact with fallback to #root, returning which channel it was found in
  // This is needed for OAuth token lookup - tokens are stored per-channel where MCP lives
  getArtifactWithFallbackAndSource(channel: string, slug: string): { artifact: Artifact; sourceChannel: string } | undefined {
    // First try the local channel
    console.error(`[powpow] getArtifactWithFallback: channel=${channel}, slug=${slug}`);
    const local = this.getArtifact(channel, slug);
    if (local) {
      console.error(`[powpow] Found local artifact in channel '${channel}': type=${local.type}, title=${local.title}`);
      return { artifact: local, sourceChannel: channel };
    }

    // Fall back to #root for system artifacts
    const root = this.getArtifact("root", slug);
    if (root) {
      console.error(`[powpow] Falling back to #root artifact: type=${root.type}, title=${root.title}`);
      return { artifact: root, sourceChannel: "root" };
    }

    console.error(`[powpow] No artifact found in channel '${channel}' or #root for slug '${slug}'`);
    return undefined;
  }

  // List all available agent types for a channel (from channel + #root fallback)
  // Excludes agents already in the channel roster
  listAvailableAgentTypes(channel: string): ResolvedAgent[] {
    // Get agents from both channel and #root
    const channelAgents = this.listArtifacts(channel, { type: "system.agent" });
    const rootAgents = this.listArtifacts("root", { type: "system.agent" });

    // Merge, with channel agents taking precedence over root agents with same slug
    const agentMap = new Map<string, Artifact>();
    for (const agent of rootAgents) {
      agentMap.set(agent.slug, agent);
    }
    for (const agent of channelAgents) {
      agentMap.set(agent.slug, agent);
    }

    // Get current roster to filter out already-spawned agent types
    const roster = this.listChannelAgents(channel);
    const usedSlugs = new Set(roster.map(a => a.agentSlug).filter(Boolean));

    // Convert to ResolvedAgent format, excluding already-used slugs
    const result: ResolvedAgent[] = [];
    for (const artifact of agentMap.values()) {
      if (usedSlugs.has(artifact.slug)) continue;

      const props = (artifact.props || {}) as Record<string, unknown>;
      result.push({
        slug: artifact.slug,
        name: artifact.title || artifact.slug,
        content: artifact.content,
        engine: props.engine as string | undefined,
        model: props.model as string | undefined,
        nameTheme: props.nameTheme as string | undefined,
        agentName: props.agentName as string | undefined,
      });
    }

    return result;
  }

  // Resolve agent definition from system.agent artifact
  // Returns a normalized interface compatible with legacy hat lookups
  resolveAgentDefinition(channel: string, slug: string): ResolvedAgent | undefined {
    console.error(`[powpow] resolveAgentDefinition: channel=${channel}, slug=${slug}`);
    const artifact = this.getArtifactWithFallback(channel, slug);
    if (!artifact || artifact.type !== "system.agent") {
      console.error(`[powpow] resolveAgentDefinition: artifact not found or wrong type`);
      return undefined;
    }

    const props = (artifact.props || {}) as Record<string, unknown>;
    const mcpRefs = props.mcp as McpReference[] | undefined;

    return {
      slug: artifact.slug,
      name: artifact.title || artifact.slug,
      content: artifact.content,
      engine: props.engine as string | undefined,
      model: props.model as string | undefined,
      nameTheme: props.nameTheme as string | undefined,
      agentName: props.agentName as string | undefined,
      mcp: mcpRefs,
    };
  }

// === MCP Resolution Methods ===

  // Resolve a system.mcp artifact for an agent
  // Looks in channel first, then falls back to #root
  // Returns both the artifact and the channel where it was found (for OAuth token lookup)
  resolveMcpForAgent(channel: string, mcpSlug: string): { artifact: Artifact; sourceChannel: string } | null {
    const result = this.getArtifactWithFallbackAndSource(channel, mcpSlug);
    if (!result || result.artifact.type !== "system.mcp") {
      return null;
    }
    return result;
  }

  // Resolve all MCP configs for an agent
  // Returns configs with env vars resolved to actual values
  // Note: This method doesn't handle OAuth - use resolveMcpConfigsWithOAuth for OAuth MCPs
  resolveMcpConfigs(channel: string, mcpRefs: McpReference[]): ResolvedMcpConfig[] {
    const configs: ResolvedMcpConfig[] = [];

    for (const ref of mcpRefs) {
      const resolved = this.resolveMcpForAgent(channel, ref.slug);
      if (!resolved) {
        console.error(`[powpow] MCP not found: ${ref.slug} (checked ${channel} and root)`);
        continue;
      }

      const { artifact } = resolved;
      const props = artifact.props as Record<string, unknown>;
      const transport = props.transport as "stdio" | "http";

      const config: ResolvedMcpConfig = {
        slug: ref.slug,
        transport,
      };

      if (transport === "stdio") {
        config.command = props.command as string | undefined;
        config.args = props.args as string[] | undefined;
        config.cwd = props.cwd as string | undefined;
        // Resolve env vars
        const env = props.env as Record<string, string> | undefined;
        if (env) {
          config.env = this.resolveEnvVars(env);
        }
      } else if (transport === "http") {
        config.url = props.url as string | undefined;
        // Resolve headers
        const headers = props.headers as Record<string, string> | undefined;
        if (headers) {
          config.headers = this.resolveEnvVars(headers);
        }
      }

      configs.push(config);
    }

    return configs;
  }

  // Resolve ${VAR_NAME} references to actual environment variable values
  private resolveEnvVars(obj: Record<string, string>): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = this.resolveEnvVarString(value);
    }
    return result;
  }

  // Resolve ${VAR_NAME} in a string to actual environment variable value
  private resolveEnvVarString(value: string): string {
    return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        console.error(`[powpow] Warning: env var ${varName} not found, leaving as ${match}`);
        return match; // Keep original if not found
      }
      return envValue;
    });
  }

  // === Knowledge Base Methods ===

  // List all published knowledge bases across all channels
  listPublishedKnowledgeBases(): Array<{ channel: string; title: string; tldr: string }> {
    const rows = this.db.prepare(`
      SELECT channel, title, tldr
      FROM artifacts
      WHERE type = 'knowledgebase' AND slug = 'knowledgebase' AND status = 'published'
      ORDER BY channel ASC
    `).all() as Array<{ channel: string; title: string | null; tldr: string }>;

    return rows.map(row => ({
      channel: row.channel,
      title: row.title || row.channel,
      tldr: row.tldr,
    }));
  }

  // Get the knowledgebase manifest for a channel
  getKnowledgeBase(channel: string): Artifact | undefined {
    return this.getArtifact(channel, "knowledgebase");
  }

  // Get all content artifacts in a KB's subtree
  getKBContent(channel: string, path?: string): Artifact[] {
    const kb = this.getArtifact(channel, "knowledgebase");
    if (!kb) return [];

    // Get all artifacts that are descendants of the knowledgebase
    // Use path prefix matching for subtree queries
    const basePath = path ? `/knowledgebase${path}` : "/knowledgebase";

    const rows = this.db.prepare(`
      SELECT id, slug, channel, path, title, tldr, type, content, content_type, encoding,
             refs, status, parent_slug, order_key, labels, assignees, props, created_by, created_at,
             updated_by, updated_at, version
      FROM artifacts
      WHERE channel = ? AND path LIKE ? AND path != '/knowledgebase'
      ORDER BY path ASC
    `).all(channel, `${basePath}%`) as any[];

    return rows.map(row => this.parseArtifactRow(row));
  }

  // Get a specific doc from a KB by its path relative to the KB root
  getKBDoc(channel: string, relativePath: string): Artifact | undefined {
    // Normalize path: ensure it starts with / and doesn't have trailing /
    const normalizedPath = relativePath.startsWith("/") ? relativePath : `/${relativePath}`;
    const fullPath = `/knowledgebase${normalizedPath}`;

    return this.getArtifactByPath(channel, fullPath);
  }

  // === Embedding Methods (sqlite-vec) ===

  // Store embedding for an artifact
  storeEmbedding(artifactId: string, channel: string, embedding: number[]): void {
    if (embedding.length !== 1536) {
      throw new Error(`Expected 1536-dimensional embedding, got ${embedding.length}`);
    }

    // Convert to Float32Array for sqlite-vec
    const float32Embedding = new Float32Array(embedding);

    // Upsert: delete existing then insert
    this.db.prepare(`DELETE FROM kb_embeddings WHERE artifact_id = ?`).run(artifactId);
    this.db.prepare(`
      INSERT INTO kb_embeddings (artifact_id, channel, embedding)
      VALUES (?, ?, ?)
    `).run(artifactId, channel, float32Embedding);
  }

  // Search for similar documents by embedding vector
  searchByEmbedding(embedding: number[], options?: {
    channel?: string;
    limit?: number;
  }): Array<{ artifactId: string; channel: string; distance: number }> {
    if (embedding.length !== 1536) {
      throw new Error(`Expected 1536-dimensional embedding, got ${embedding.length}`);
    }

    const limit = options?.limit ?? 10;
    const float32Embedding = new Float32Array(embedding);

    let sql = `
      SELECT artifact_id, channel, distance
      FROM kb_embeddings
      WHERE embedding MATCH ?
    `;
    const params: any[] = [float32Embedding];

    if (options?.channel) {
      sql += ` AND channel = ?`;
      params.push(options.channel);
    }

    sql += ` ORDER BY distance LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as Array<{
      artifact_id: string;
      channel: string;
      distance: number;
    }>;

    return rows.map(row => ({
      artifactId: row.artifact_id,
      channel: row.channel,
      distance: row.distance,
    }));
  }

  // Delete embedding for an artifact
  deleteEmbedding(artifactId: string): boolean {
    const result = this.db.prepare(`DELETE FROM kb_embeddings WHERE artifact_id = ?`).run(artifactId);
    return result.changes > 0;
  }

  // Check if an artifact has an embedding
  hasEmbedding(artifactId: string): boolean {
    const row = this.db.prepare(`SELECT 1 FROM kb_embeddings WHERE artifact_id = ?`).get(artifactId);
    return !!row;
  }
}

// Resolved agent definition (compatible with legacy hat interface)
export interface ResolvedAgent {
  slug: string;        // artifact slug (was hat.id)
  name: string;        // display name (artifact title or slug)
  content: string;     // system prompt (artifact content)
  engine?: string;     // from props.engine
  model?: string;      // from props.model
  nameTheme?: string;  // from props.nameTheme
  agentName?: string;  // from props.agentName (for singletons)
  mcp?: McpReference[]; // from props.mcp
}

// MCP reference as stored in system.agent props
export interface McpReference {
  slug: string;
}

// Resolved MCP server config (ready to pass to engine)
export interface ResolvedMcpConfig {
  slug: string;
  transport: "stdio" | "http";
  // For stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // For http
  url?: string;
  headers?: Record<string, string>;
}

export const store = new Store();
