/**
 * @cast/core - Shared Types
 *
 * Core domain models for the Cast platform.
 */

// =============================================================================
// Message Types (Phase 1 - Minimal)
// =============================================================================

export type ParticipantType = 'user' | 'agent' | 'system';

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
  | 'attachment'
  | 'event';

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

  /**
   * State for stateful message types (e.g., structured_ask).
   * Values: "pending", "completed", "dismissed"
   */
  state?: string;
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
  state?: string;
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
  /** If true, fetch newest messages first (for initial sync) - results still returned in chronological order */
  newestFirst?: boolean;
  /** Keyword search - case-insensitive substring match on content and sender */
  search?: string;
  /** Filter by sender callsign (exact match) */
  sender?: string;
  /** If true, include tool call messages (default: false - only text messages) */
  includeToolCalls?: boolean;
  /** Filter by message type (e.g., 'structured_ask') */
  type?: string;
  /** Filter by message state (e.g., 'pending') */
  state?: string;
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

  /** ISO timestamp of last user activity (message sent) */
  lastActiveAt: string;
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
  /** Update lastActiveAt timestamp (set to now when user sends a message) */
  lastActiveAt?: string;
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

export type RosterStatus = 'active' | 'idle' | 'busy' | 'offline' | 'paused' | 'archived';

// =============================================================================
// Runtime Types
// =============================================================================

/**
 * Runtime type identifier.
 */
export type RuntimeType = 'local' | 'docker' | 'fly';

/**
 * Runtime connection status.
 */
export type RuntimeStatus = 'online' | 'offline';

/**
 * Configuration for local runtimes.
 */
export interface LocalRuntimeConfig {
  /** Current WebSocket connection ID (null if offline) */
  wsConnectionId: string | null;
  /** Machine metadata */
  machineInfo?: {
    os: string;
    hostname: string;
  };
  /** Fly.io volume ID for persistent storage (Miriad Cloud only) */
  flyVolumeId?: string;
}

/**
 * A runtime record as stored in the database.
 */
export interface StoredRuntime {
  /** Unique runtime identifier (ULID) */
  id: string;
  /** Space this runtime belongs to */
  spaceId: string;
  /** Server credential ID (FK to local_agent_servers) */
  serverId: string | null;
  /** Display name (e.g., "simen-macbook") */
  name: string;
  /** Runtime type */
  type: RuntimeType;
  /** Connection status */
  status: RuntimeStatus;
  /** Type-specific configuration */
  config: LocalRuntimeConfig | null;
  /** ISO timestamp of creation */
  createdAt: string;
  /** ISO timestamp of last activity */
  lastSeenAt: string | null;
}

/**
 * Input for creating a runtime.
 */
export interface CreateRuntimeInput {
  id?: string;
  spaceId: string;
  serverId?: string;
  name: string;
  type: RuntimeType;
  status?: RuntimeStatus;
  config?: LocalRuntimeConfig;
}

/**
 * Input for updating a runtime.
 */
export interface UpdateRuntimeInput {
  name?: string;
  status?: RuntimeStatus;
  config?: LocalRuntimeConfig;
  lastSeenAt?: string;
}

/**
 * Ephemeral state tracked on roster entries.
 * Contains real-time info about what the agent is doing right now.
 */
export interface RosterCurrent {
  /** Agent's current status text (e.g., "implementing feature X") */
  status?: string;
}

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

  /**
   * Tunnel hash for HTTP tunnel access.
   * 32+ char hex string, used as subdomain: {tunnelHash}.containers.domain.com
   * Generated on agent spawn, persists across container restarts.
   */
  tunnelHash?: string;

  /**
   * ISO timestamp of last heartbeat from container.
   * Used to determine if agent is online (stale = offline).
   */
  lastHeartbeat?: string;

  /**
   * Routing hints from container checkin (v3.0+).
   * Opaque JSON object echoed as HTTP headers when pushing messages.
   * Used for platform-specific routing (e.g., Fly-Replay for Fly.io).
   */
  routeHints?: Record<string, string> | null;

  /**
   * Ephemeral state about what the agent is currently doing.
   * Includes status text, and will expand to include todo lists, role context, etc.
   */
  current?: RosterCurrent;

  /**
   * ISO timestamp of when last message was routed to this agent.
   * Used to track "pending" state between message routing and first frame.
   */
  lastMessageRoutedAt?: string;

  /**
   * Runtime ID this agent is bound to.
   * NULL = CAST Cloud (FlyRuntime)
   * Non-null = user-registered runtime (LocalRuntime)
   */
  runtimeId?: string | null;

  /**
   * Runtime name for display (populated from runtime record via JOIN).
   * Only present when runtimeId is set.
   */
  runtimeName?: string;

  /**
   * Runtime connection status (populated from runtime record via JOIN).
   * Agent is considered online when runtime is online.
   */
  runtimeStatus?: RuntimeStatus;

  /**
   * Persistent engine-specific properties.
   * Used to store state like Letta agent IDs, session data, etc.
   * Unlike 'current' (ephemeral), this persists across sessions.
   */
  props?: Record<string, unknown>;
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
  /** Runtime ID to bind agent to (null = CAST Cloud) */
  runtimeId?: string | null;
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
  /** Tunnel hash (for rotation) */
  tunnelHash?: string;
  /** Last heartbeat timestamp (ISO 8601) */
  lastHeartbeat?: string;
  /** Routing hints (v3.0+) - opaque object echoed as HTTP headers */
  routeHints?: Record<string, string> | null;
  /** Ephemeral current state (status text, etc.) */
  current?: RosterCurrent;
  /** Timestamp when a message was last routed to this agent (ISO 8601) */
  lastMessageRoutedAt?: string;
  /** Runtime ID to bind agent to (null = CAST Cloud) */
  runtimeId?: string | null;
  /** Persistent engine-specific properties */
  props?: Record<string, unknown>;
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
// User Types (Spaces & Auth)
// =============================================================================

/**
 * A user as stored in the database.
 */
export interface StoredUser {
  /** Unique user identifier (ULID) */
  id: string;

  /** External identity provider ID (e.g., WorkOS user_id) */
  externalId: string;

  /** Display name in chat (e.g., "simen") */
  callsign: string;

  /** User's email address */
  email?: string;

  /** URL to user's avatar image */
  avatarUrl?: string;

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of last update */
  updatedAt: string;

  /** Version of disclaimer user has accepted (null if not yet accepted) */
  disclaimerAcceptedVersion?: string;
}

/**
 * Input for creating a new user.
 */
export interface CreateUserInput {
  /** Optional ID (will generate ULID if not provided) */
  id?: string;

  /** External identity provider ID */
  externalId: string;

  /** Display name in chat */
  callsign: string;

  /** User's email address */
  email?: string;

  /** URL to user's avatar image */
  avatarUrl?: string;
}

// =============================================================================
// Space Types (Spaces & Auth)
// =============================================================================

/**
 * A space (tenant workspace) as stored in the database.
 */
export interface StoredSpace {
  /** Unique space identifier (ULID) */
  id: string;

  /** User ID of the space owner */
  ownerId: string;

  /** Display name for the space */
  name?: string;

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Input for creating a new space.
 */
export interface CreateSpaceInput {
  /** Optional ID (will generate ULID if not provided) */
  id?: string;

  /** User ID of the space owner */
  ownerId: string;

  /** Display name for the space */
  name?: string;
}

// =============================================================================
// User/Space Type Guards
// =============================================================================

export function isStoredUser(value: unknown): value is StoredUser {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredUser).id === 'string' &&
    typeof (value as StoredUser).externalId === 'string' &&
    typeof (value as StoredUser).callsign === 'string'
  );
}

export function isStoredSpace(value: unknown): value is StoredSpace {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredSpace).id === 'string' &&
    typeof (value as StoredSpace).ownerId === 'string'
  );
}

// =============================================================================
// Artifact Secrets Types (App Integrations)
// =============================================================================

/**
 * Secret metadata returned by API (values are never exposed).
 */
export interface SecretMetadata {
  /** ISO timestamp when secret was set */
  setAt: string;

  /** ISO timestamp when secret expires (optional) */
  expiresAt?: string;
}

/**
 * Internal storage format for encrypted secrets (never exposed via API).
 */
export interface StoredSecret {
  /** ISO timestamp when secret was set */
  setAt: string;

  /** ISO timestamp when secret expires (optional) */
  expiresAt?: string;

  /** Base64-encoded encrypted value */
  encrypted: string;

  /** Base64-encoded initialization vector */
  iv: string;

  /** Base64-encoded authentication tag */
  tag: string;
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
 *
 * ⚠️  SYNC WARNING: Keep aligned with ArtifactType in frontend/src/types.ts
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
  | 'system.environment'
  | 'system.focus'
  | 'system.playbook'
  | 'system.app';

/**
 * Artifact status values.
 * - draft/active/archived: For documents (non-tasks)
 * - pending/in_progress/done/blocked: For tasks
 *
 * ⚠️  SYNC WARNING: Keep aligned with ArtifactStatus in frontend/src/types.ts
 */
export type ArtifactStatus =
  | 'draft'
  | 'active'
  | 'archived'
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked'
  | 'published'; // Legacy - use 'active' for new artifacts

/**
 * An artifact as stored in the database.
 * Artifacts are persistent work products scoped to a channel.
 *
 * ⚠️  SYNC WARNING: Keep aligned with Artifact in frontend/src/types.ts
 *     The frontend type omits computed fields (path, refs) and uses
 *     optional arrays for assignees/labels (backend defaults to []).
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

  /** Secret metadata (keys and expiry, values never exposed) */
  secrets?: Record<string, SecretMetadata>;

  /** MIME type for binary assets (e.g., 'image/png') */
  contentType?: string;

  /** File size in bytes for binary assets */
  fileSize?: number;

  /** If set, this asset is attached to a message and hidden from the board */
  attachedToMessageId?: string;

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

  /** If set, this asset is attached to a message and hidden from the board */
  attachedToMessageId?: string;

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
  /** Channel ID (needed for app integrations to locate secrets) */
  channelId: string;
  /** Type-specific props (needed for app integrations to get provider info) */
  props?: Record<string, unknown>;
}

/**
 * Tree node for hierarchical artifact views.
 *
 * ⚠️  SYNC WARNING: Keep aligned with ArtifactTreeNode in frontend/src/types.ts
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
      'folder',
      'task',
      'code',
      'decision',
      'knowledgebase',
      'asset',
      'system.mcp',
      'system.agent',
      'system.environment',
      'system.focus',
      'system.playbook',
      'system.app',
    ].includes(value)
  );
}

export function isArtifactStatus(value: unknown): value is ArtifactStatus {
  return (
    typeof value === 'string' &&
    [
      'draft',
      'active',
      'archived',
      'pending',
      'in_progress',
      'done',
      'blocked',
      'published', // Legacy - use 'active' for new artifacts
    ].includes(value)
  );
}

/**
 * Get the default status for an artifact type.
 * @param type - The artifact type
 * @param createdBy - Who is creating the artifact ('user' for humans, agent callsign for agents)
 */
export function getDefaultArtifactStatus(
  type: ArtifactType,
  createdBy?: string
): ArtifactStatus {
  if (type === 'task') {
    return 'pending';
  }
  if (type.startsWith('system.')) {
    return 'active';
  }
  // Human-created defaults to 'active', agent-created defaults to 'draft'
  // 'user' is the identifier for human users
  if (createdBy === 'user') {
    return 'active';
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
 * Maximum file size for asset uploads (500 MB).
 * Single source of truth used by all storage backends and frontend.
 */
export const MAX_ASSET_FILE_SIZE = 500 * 1024 * 1024;

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

// =============================================================================
// Local Agent Server Types (Stage 3)
// =============================================================================

/**
 * A local agent server credential as stored in the database.
 * These credentials allow local agent servers to authenticate with CAST
 * and request agent tokens for specific channels.
 */
export interface StoredLocalAgentServer {
  /** Unique server identifier (srv_ULID format) */
  serverId: string;

  /** Space this server is authorized for */
  spaceId: string;

  /** User who registered this server */
  userId: string;

  /** HMAC-signed secret for authentication */
  secret: string;

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of revocation (null if active) */
  revokedAt: string | null;
}

/**
 * Input for creating a new local agent server credential.
 */
export interface CreateLocalAgentServerInput {
  /** Server ID (srv_ULID format) */
  serverId: string;

  /** Space ID */
  spaceId: string;

  /** User ID who registered this server */
  userId: string;

  /** HMAC-signed secret */
  secret: string;
}

/**
 * Type guard for StoredLocalAgentServer.
 */
export function isStoredLocalAgentServer(value: unknown): value is StoredLocalAgentServer {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredLocalAgentServer).serverId === 'string' &&
    typeof (value as StoredLocalAgentServer).spaceId === 'string' &&
    typeof (value as StoredLocalAgentServer).userId === 'string' &&
    typeof (value as StoredLocalAgentServer).secret === 'string'
  );
}

// =============================================================================
// Bootstrap Token Types (Stage 3)
// =============================================================================

/**
 * A bootstrap token as stored in the database.
 * Bootstrap tokens are short-lived (10 min) one-time-use tokens for
 * exchanging into server credentials during local agent setup.
 */
export interface StoredBootstrapToken {
  /** The token value (bst_... format) */
  token: string;

  /** Space this token is for */
  spaceId: string;

  /** User who generated this token */
  userId: string;

  /** ISO timestamp of expiration */
  expiresAt: string;

  /** Whether the token has been consumed */
  consumed: boolean;

  /** ISO timestamp of creation */
  createdAt: string;
}

/**
 * Input for creating a new bootstrap token.
 */
export interface CreateBootstrapTokenInput {
  /** The token value (bst_... format) */
  token: string;

  /** Space ID */
  spaceId: string;

  /** User ID who generated this token */
  userId: string;

  /** Expiration timestamp */
  expiresAt: Date;
}

// =============================================================================
// Cost Tracking Types
// =============================================================================

/**
 * Usage breakdown by token type.
 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

/**
 * Usage breakdown per model.
 */
export interface ModelUsage extends TokenUsage {
  costUsd: number;
}

/**
 * A cost record as stored in the database.
 * Records cost per agent turn for billing and analytics.
 */
export interface StoredCostRecord {
  /** Unique identifier (ULID) */
  id: string;

  /** Space this cost belongs to */
  spaceId: string;

  /** Channel where the cost was incurred */
  channelId: string;

  /** Agent callsign who incurred the cost */
  callsign: string;

  /** Total cost in USD for this turn */
  costUsd: number;

  /** Turn duration in milliseconds */
  durationMs: number;

  /** Number of conversation turns */
  numTurns: number;

  /** Aggregate token usage */
  usage: TokenUsage;

  /** Per-model usage breakdown (optional) */
  modelUsage?: Record<string, ModelUsage>;

  /** ISO timestamp of when cost was recorded */
  createdAt: string;
}

/**
 * Input for creating a new cost record.
 */
export interface CreateCostRecordInput {
  /** Space ID */
  spaceId: string;

  /** Channel ID */
  channelId: string;

  /** Agent callsign */
  callsign: string;

  /** Cost in USD */
  costUsd: number;

  /** Duration in ms */
  durationMs: number;

  /** Number of turns */
  numTurns: number;

  /** Token usage */
  usage: TokenUsage;

  /** Per-model breakdown */
  modelUsage?: Record<string, ModelUsage>;
}

/**
 * Aggregated cost tally per agent for a channel.
 */
export interface CostTally {
  /** Agent callsign */
  callsign: string;

  /** Total cost in USD */
  totalCostUsd: number;

  /** Total number of turns */
  totalTurns: number;

  /** Total duration in ms */
  totalDurationMs: number;
}

// =============================================================================
// WebSocket Connection Types
// =============================================================================

/**
 * Connection protocol type.
 * - 'browser': Standard browser WebSocket connection
 * - 'runtime': LocalRuntime WebSocket connection
 */
export type ConnectionProtocol = 'browser' | 'runtime';

/**
 * A WebSocket connection record as stored in the database.
 * Used for message broadcasting to connected clients.
 */
export interface StoredConnection {
  /** Unique connection identifier */
  connectionId: string;

  /** Channel ID this connection is subscribed to ('__pending__' for unauth'd) */
  channelId: string;

  /** ISO timestamp when connection was established */
  connectedAt: string;

  /** Agent callsign if this is an agent connection */
  agentCallsign?: string;

  /** Container ID if this is a containerized agent */
  containerId?: string;

  /** Connection protocol type (defaults to 'browser') */
  protocol: ConnectionProtocol;

  /** Runtime ID for runtime connections (null until runtime_ready) */
  runtimeId?: string;
}
