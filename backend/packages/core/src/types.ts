/**
 * @cast/core - Shared Types
 *
 * Core domain models for the Cast platform.
 */

// =============================================================================
// Message Types (Phase 1 - Minimal)
// =============================================================================

export type ParticipantType = 'user' | 'agent';

export type StoredMessageType =
  | 'user'
  | 'agent'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'status'
  | 'error'
  | 'idle'
  | 'structured_ask'
  | 'attachment';

/**
 * A message as stored in the database.
 * This is the persistent form - differs from wire format (TymbalFrame).
 */
export interface StoredMessage {
  /** Unique message identifier (ULID for ordering) */
  id: string;

  /** Space this message belongs to */
  spaceId: string;

  /** Channel this message belongs to */
  channelId: string;

  /** Who sent this message */
  sender: string;

  /** Type of sender */
  senderType: ParticipantType;

  /** Message type discriminator */
  type: StoredMessageType;

  /** Message content (shape depends on type) */
  content: unknown;

  /** ISO timestamp */
  timestamp: string;

  /** Whether the message is complete (for streaming) */
  isComplete: boolean;

  /**
   * Agents this message was addressed/routed to.
   * - ["fox", "bear"] → Routed to specific agents (@fox, @bear)
   * - ["channel"] → Broadcast to all agents (@channel, system messages)
   * - [] or undefined → Logged but not routed to any agent
   */
  addressedAgents?: string[];

  /**
   * Turn identifier for grouping messages from a single agentic loop invocation.
   * All messages (assistant, tool_call, tool_result) from one turn share this ID.
   */
  turnId?: string;

  /** JSONB metadata for extensibility */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new message
 */
export interface CreateMessageInput {
  id?: string;
  spaceId: string;
  channelId: string;
  sender: string;
  senderType: ParticipantType;
  type: StoredMessageType;
  content: unknown;
  isComplete?: boolean;
  addressedAgents?: string[];
  turnId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Parameters for querying messages
 */
export interface GetMessagesParams {
  /** Return messages after this ID (ULID - for sync) */
  since?: string;
  /** Return messages before this ID (ULID - for pagination) */
  before?: string;
  /** Maximum number of messages to return */
  limit?: number;
}

// =============================================================================
// Channel Types (Phase 2)
// =============================================================================

/**
 * A channel as stored in the database.
 */
export interface StoredChannel {
  /** Unique channel identifier (ULID) */
  id: string;

  /** Space this channel belongs to */
  spaceId: string;

  /** Channel name (slug-like) */
  name: string;

  /** Short description */
  tagline?: string;

  /** Longer mission/purpose statement */
  mission?: string;

  /** Whether the channel is archived */
  archived: boolean;

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Input for creating a new channel
 */
export interface CreateChannelInput {
  id?: string;
  spaceId: string;
  name: string;
  tagline?: string;
  mission?: string;
}

/**
 * Input for updating a channel
 */
export interface UpdateChannelInput {
  name?: string;
  tagline?: string;
  mission?: string;
  archived?: boolean;
}

/**
 * Parameters for listing channels
 */
export interface ListChannelsParams {
  /** Include archived channels (default: false) */
  includeArchived?: boolean;
  /** Maximum number of channels to return */
  limit?: number;
}

// =============================================================================
// Roster Types (Phase 2)
// =============================================================================

export type RosterStatus = 'active' | 'idle' | 'busy' | 'offline';

/**
 * A roster entry (agent in a channel) as stored in the database.
 */
export interface RosterEntry {
  /** Unique roster entry identifier (ULID) */
  id: string;

  /** Channel this roster entry belongs to */
  channelId: string;

  /** Agent's callsign in this channel */
  callsign: string;

  /** Type of agent (definition slug) */
  agentType: string;

  /** Current status */
  status: RosterStatus;

  /** ISO timestamp of when agent joined */
  createdAt: string;

  /** Callback URL for message delivery (set by container checkin) */
  callbackUrl?: string;

  /** Last delivered message ID (for tracking what's been pushed to agent) */
  readmark?: string;
}

/**
 * Input for adding an agent to a roster
 */
export interface AddToRosterInput {
  id?: string;
  channelId: string;
  callsign: string;
  agentType: string;
  status?: RosterStatus;
}

/**
 * Input for updating a roster entry
 */
export interface UpdateRosterInput {
  status?: RosterStatus;
  /** Callback URL for message delivery */
  callbackUrl?: string;
  /** Last delivered message ID */
  readmark?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isStoredMessage(value: unknown): value is StoredMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredMessage).id === 'string' &&
    typeof (value as StoredMessage).channelId === 'string' &&
    typeof (value as StoredMessage).sender === 'string'
  );
}

export function isStoredChannel(value: unknown): value is StoredChannel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredChannel).id === 'string' &&
    typeof (value as StoredChannel).spaceId === 'string' &&
    typeof (value as StoredChannel).name === 'string'
  );
}

export function isRosterEntry(value: unknown): value is RosterEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RosterEntry).id === 'string' &&
    typeof (value as RosterEntry).channelId === 'string' &&
    typeof (value as RosterEntry).callsign === 'string'
  );
}

// =============================================================================
// Artifact Types (Phase A)
// =============================================================================

/**
 * Artifact type discriminator.
 * - doc, folder, task, code, decision: User content types
 * - knowledgebase: Searchable documentation
 * - asset: Binary files (images, PDFs, etc.)
 * - system.*: System configuration types
 */
export type ArtifactType =
  | 'doc'
  | 'folder'
  | 'task'
  | 'code'
  | 'decision'
  | 'knowledgebase'
  | 'asset'
  | 'system.mcp'
  | 'system.agent'
  | 'system.focus'
  | 'system.playbook';

/**
 * Artifact status values.
 * - draft/published/archived: For documents
 * - pending/in_progress/done/blocked: For tasks
 */
export type ArtifactStatus =
  | 'draft'
  | 'published'
  | 'archived'
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked';

/**
 * An artifact as stored in the database.
 * Artifacts are persistent work products scoped to a channel.
 */
export interface StoredArtifact {
  /** Unique artifact identifier (ULID) */
  id: string;

  /** Channel this artifact belongs to */
  channelId: string;

  /** Human-readable identifier, IMMUTABLE after creation */
  slug: string;

  /** Artifact type */
  type: ArtifactType;

  /** Optional display title */
  title?: string;

  /** Optional summary (1-3 sentences) */
  tldr?: string;

  /** Main content (markdown for docs, raw code for code artifacts) */
  content: string;

  /** Parent artifact slug for tree hierarchy (mutable) */
  parentSlug?: string;

  /** Computed hierarchical path (e.g., "planning.phase_1.auth_spec" in ltree format) */
  path: string;

  /** Lexicographic sort key for sibling ordering */
  orderKey: string;

  /** Current status */
  status: ArtifactStatus;

  /** Assigned agent callsigns (for tasks) */
  assignees: string[];

  /** Freeform tags */
  labels: string[];

  /** Auto-extracted [[slug]] cross-references */
  refs: string[];

  /** Type-specific properties (e.g., MCP config, agent definition) */
  props?: Record<string, unknown>;

  /** MIME type for binary assets (e.g., 'image/png') */
  contentType?: string;

  /** File size in bytes for binary assets */
  fileSize?: number;

  /** Optimistic concurrency version (auto-incremented on update) */
  version: number;

  /** Who created this artifact */
  createdBy: string;

  /** ISO timestamp of creation */
  createdAt: string;

  /** Who last updated this artifact */
  updatedBy?: string;

  /** ISO timestamp of last update */
  updatedAt?: string;
}

/**
 * Input for creating a new artifact.
 */
export interface CreateArtifactInput {
  /** Human-readable identifier (immutable after creation) */
  slug: string;

  /** Channel this artifact belongs to */
  channelId: string;

  /** Artifact type */
  type: ArtifactType;

  /** Optional display title */
  title?: string;

  /** Optional summary */
  tldr?: string;

  /** Main content */
  content: string;

  /** Parent artifact slug for tree hierarchy */
  parentSlug?: string;

  /** Initial status (defaults based on type) */
  status?: ArtifactStatus;

  /** Assigned agent callsigns */
  assignees?: string[];

  /** Freeform tags */
  labels?: string[];

  /** Type-specific properties */
  props?: Record<string, unknown>;

  /** MIME type for binary assets */
  contentType?: string;

  /** File size in bytes for binary assets */
  fileSize?: number;

  /** Who is creating this artifact */
  createdBy: string;
}

/**
 * A single field change for compare-and-swap updates.
 */
export interface ArtifactCASChange {
  /** Field to update */
  field: 'title' | 'tldr' | 'status' | 'parentSlug' | 'orderKey' | 'assignees' | 'labels' | 'props';

  /** Expected current value (null if field should be unset) */
  oldValue: unknown;

  /** New value to set */
  newValue: unknown;
}

/**
 * Result of a compare-and-swap update operation.
 */
export interface ArtifactCASResult {
  /** Whether the update succeeded */
  success: boolean;

  /** Updated artifact (if success) */
  artifact?: StoredArtifact;

  /** Conflict details (if failed) */
  conflict?: {
    field: string;
    expected: unknown;
    actual: unknown;
  };
}

/**
 * Item archived during a recursive archive operation.
 * Contains info needed for undo.
 */
export interface ArchivedItem {
  /** Artifact slug */
  slug: string;

  /** Previous status before archiving (for undo) */
  previousStatus: ArtifactStatus;
}

/**
 * Result of a recursive archive operation.
 */
export interface RecursiveArchiveResult {
  /** List of all archived items with their previous statuses */
  archived: ArchivedItem[];

  /** Total count of archived items */
  count: number;
}

/**
 * Input for surgical content edit (find-replace).
 */
export interface ArtifactEditInput {
  /** Text to find (must match exactly once) */
  oldString: string;

  /** Replacement text */
  newString: string;

  /** Who is performing the edit */
  updatedBy: string;
}

/**
 * Parameters for listing artifacts.
 */
export interface ListArtifactsParams {
  /** Filter by artifact type */
  type?: ArtifactType;

  /** Filter by status */
  status?: ArtifactStatus;

  /** Filter by assignee (for tasks) */
  assignee?: string;

  /** Filter by parent slug ('root' for top-level only) */
  parentSlug?: string | 'root';

  /** Keyword search (FTS with BM25 ranking) */
  search?: string;

  /** Regex pattern matching on slug/title/tldr/content */
  regex?: string;

  /** Maximum results (default: 50) */
  limit?: number;

  /** Pagination offset */
  offset?: number;
}

/**
 * Summary view of an artifact (for list responses).
 */
export interface ArtifactSummary {
  slug: string;
  type: ArtifactType;
  title?: string;
  tldr?: string;
  status: ArtifactStatus;
  path: string;
  orderKey: string;
  assignees: string[];
  parentSlug?: string;
}

/**
 * Tree node for hierarchical artifact views.
 */
export interface ArtifactTreeNode {
  slug: string;
  type: ArtifactType;
  title?: string;
  status: ArtifactStatus;
  path: string;
  orderKey: string;
  assignees: string[];
  children: ArtifactTreeNode[];
}

/**
 * A named version snapshot of an artifact.
 */
export interface ArtifactVersion {
  /** Artifact slug */
  slug: string;

  /** Channel ID */
  channelId: string;

  /** Version name (e.g., "v1.0", "draft-2") */
  versionName: string;

  /** Optional version message */
  versionMessage?: string;

  /** Snapshot of tldr at version time */
  tldr: string;

  /** Snapshot of content at version time */
  content: string;

  /** Who created this version */
  versionCreatedBy: string;

  /** ISO timestamp of version creation */
  versionCreatedAt: string;
}

/**
 * Input for creating a version checkpoint.
 */
export interface CreateArtifactVersionInput {
  /** Version name (e.g., "v1.0") */
  versionName: string;

  /** Optional version message */
  versionMessage?: string;

  /** Who is creating this version */
  createdBy: string;
}

// =============================================================================
// Artifact Type Guards
// =============================================================================

export function isStoredArtifact(value: unknown): value is StoredArtifact {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredArtifact).id === 'string' &&
    typeof (value as StoredArtifact).channelId === 'string' &&
    typeof (value as StoredArtifact).slug === 'string' &&
    typeof (value as StoredArtifact).type === 'string'
  );
}

export function isArtifactType(value: unknown): value is ArtifactType {
  return (
    typeof value === 'string' &&
    [
      'doc',
      'task',
      'code',
      'decision',
      'knowledgebase',
      'asset',
      'system.mcp',
      'system.agent',
      'system.focus',
      'system.playbook',
    ].includes(value)
  );
}

export function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return (
    typeof value === 'string' &&
    [
      'draft',
      'published',
      'archived',
      'pending',
      'in_progress',
      'done',
      'blocked',
    ].includes(value)
  );
}

/**
 * Get the default status for an artifact type.
 */
export function getDefaultArtifactStatus(type: ArtifactType): ArtifactStatus {
  if (type === 'task') {
    return 'pending';
  }
  if (type.startsWith('system.')) {
    return 'published';
  }
  return 'draft';
}

/**
 * Convert a slug to ltree path segment format.
 * Hyphens become underscores (ltree doesn't allow hyphens).
 */
export function slugToPathSegment(slug: string): string {
  return slug.replace(/-/g, '_').replace(/\./g, '_');
}

/**
 * Convert an ltree path segment back to slug format.
 * Note: This is lossy - can't distinguish original hyphens from underscores.
 */
export function pathSegmentToSlug(segment: string): string {
  return segment.replace(/_/g, '-');
}

/**
 * Extract [[slug]] references from content.
 */
export function extractRefs(content: string): string[] {
  const regex = /\[\[([a-z0-9-]+(?:\.[a-z0-9]+)*)\]\]/g;
  const refs: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (!refs.includes(match[1])) {
      refs.push(match[1]);
    }
  }
  return refs;
}

// =============================================================================
// Asset/MIME Type Utilities (Phase E)
// =============================================================================

/**
 * Extension to MIME type mapping for supported asset types.
 * Based on PowPow's supported file types.
 */
export const ASSET_MIME_TYPES: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  // Audio
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  // Video
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // Documents
  '.pdf': 'application/pdf',
  // Fonts
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  // Archives
  '.zip': 'application/zip',
  // Code
  '.wasm': 'application/wasm',
  '.json': 'application/json',
  // Text (for artifact content serving)
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.md': 'text/markdown',
  '.html': 'text/html',
  '.css': 'text/css',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

/**
 * Get MIME type from file extension or slug.
 * Returns 'application/octet-stream' for unknown types.
 */
export function getMimeType(filenameOrSlug: string): string {
  const ext = filenameOrSlug.includes('.')
    ? '.' + filenameOrSlug.split('.').pop()!.toLowerCase()
    : '';
  return ASSET_MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Check if an extension/slug is a supported asset type.
 */
export function isSupportedAssetType(filenameOrSlug: string): boolean {
  const ext = filenameOrSlug.includes('.')
    ? '.' + filenameOrSlug.split('.').pop()!.toLowerCase()
    : '';
  return ext in ASSET_MIME_TYPES;
}
