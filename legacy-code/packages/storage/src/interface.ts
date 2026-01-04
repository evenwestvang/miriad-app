/**
 * Storage Interface
 *
 * Abstract interface for Cikada storage backends.
 * Implementations: SQLite (local dev), DynamoDB (AWS).
 */

import type {
  Space,
  Channel,
  RosterEntry,
  StoredMessage,
  ChannelStatus,
  Attachment,
  KBMetadata,
  KBDocument,
  KBSearchOptions,
  KBSearchResult,
  EmbeddingSearchResult,
  StructuredAskFormData,
} from '@cikada/core';

// =============================================================================
// Artifact Types
// =============================================================================

export type ArtifactType =
  | 'doc'
  | 'task'
  | 'code'
  | 'decision'
  | 'knowledgebase'
  | 'system.mcp'
  | 'system.agent'
  | 'system.focus'
  | 'system.playbook';

export type ArtifactStatus =
  // Documents
  | 'draft'
  | 'published'
  | 'archived'
  // Tasks
  | 'pending'
  | 'in_progress'
  | 'done'
  | 'blocked';

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

export interface ArtifactVersion {
  slug: string;
  versionName: string;
  versionMessage?: string;
  versionCreatedAt: string;
  versionCreatedBy: string;
  tldr: string;
  content: string;
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

// =============================================================================
// Storage Interface
// =============================================================================

export interface Storage {
  // ---------------------------------------------------------------------------
  // Space Operations
  // ---------------------------------------------------------------------------

  /**
   * Create a new space.
   */
  createSpace(params: CreateSpaceParams): Promise<Space>;

  /**
   * Get a space by ID.
   */
  getSpace(spaceId: string): Promise<Space | null>;

  /**
   * Get a space by owner ID.
   */
  getSpaceByOwnerId(ownerId: string): Promise<Space | null>;

  /**
   * Get or create a space for an owner (for auto-provisioning on first login).
   */
  getOrCreateSpace(ownerId: string, name?: string): Promise<Space>;

  /**
   * List all spaces (for mock auth account picker).
   */
  listSpaces(): Promise<Space[]>;

  // ---------------------------------------------------------------------------
  // Channel Operations
  // ---------------------------------------------------------------------------

  /**
   * Create a new channel.
   */
  createChannel(spaceId: string, params: CreateChannelParams): Promise<Channel>;

  /**
   * Get a channel by ID within a space.
   */
  getChannel(spaceId: string, channelId: string): Promise<Channel | null>;

  /**
   * Get a channel by name within a space.
   */
  getChannelByName(spaceId: string, name: string): Promise<Channel | null>;

  /**
   * List all channels in a space.
   */
  listChannels(spaceId: string, params?: ListChannelsParams): Promise<Channel[]>;

  /**
   * Update channel status (e.g., archive).
   */
  updateChannelStatus(spaceId: string, channelId: string, status: ChannelStatus): Promise<void>;

  // ---------------------------------------------------------------------------
  // Roster Operations
  // ---------------------------------------------------------------------------

  /**
   * Add a participant to a channel's roster.
   */
  addToRoster(spaceId: string, channelId: string, entry: RosterEntry): Promise<void>;

  /**
   * Remove a participant from a channel's roster.
   */
  removeFromRoster(spaceId: string, channelId: string, participantId: string): Promise<void>;

  /**
   * Get all roster entries for a channel.
   */
  getRoster(spaceId: string, channelId: string): Promise<RosterEntry[]>;

  /**
   * Get a specific roster entry.
   */
  getRosterEntry(spaceId: string, channelId: string, participantId: string): Promise<RosterEntry | null>;

  /**
   * Update a roster entry (e.g., status change).
   */
  updateRosterEntry(spaceId: string, channelId: string, participantId: string, update: Partial<RosterEntry>): Promise<void>;

  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  /**
   * Save a message.
   */
  saveMessage(spaceId: string, message: StoredMessage): Promise<void>;

  /**
   * Get a message by ID.
   */
  getMessage(spaceId: string, messageId: string): Promise<StoredMessage | null>;

  /**
   * Get messages for a channel.
   */
  getMessages(spaceId: string, channelId: string, params?: GetMessagesParams): Promise<StoredMessage[]>;

  /**
   * Update a message (e.g., mark complete after streaming).
   */
  updateMessage(spaceId: string, messageId: string, update: Partial<StoredMessage>): Promise<void>;

  /**
   * Delete a message.
   */
  deleteMessage(spaceId: string, messageId: string): Promise<void>;

  /**
   * Get conversation history for a specific agent.
   * Returns messages where:
   * - The agent's callsign is in addressedAgents, OR
   * - 'channel' is in addressedAgents (broadcast messages)
   * AND
   * - timestamp >= agent's joinedAt (instance startTime)
   */
  getAgentHistory(spaceId: string, channelId: string, params: GetAgentHistoryParams): Promise<StoredMessage[]>;

  // ---------------------------------------------------------------------------
  // Structured Ask Operations
  // ---------------------------------------------------------------------------

  /**
   * Save a structured ask message.
   */
  saveStructuredAsk(spaceId: string, params: SaveStructuredAskParams): Promise<StoredMessage>;

  /**
   * Submit a response to a structured ask.
   * Returns null if the message doesn't exist or is already submitted.
   */
  submitStructuredAskResponse(spaceId: string, params: SubmitStructuredAskParams): Promise<StoredMessage | null>;

  // ---------------------------------------------------------------------------
  // Attachment Operations
  // ---------------------------------------------------------------------------

  /**
   * Save an attachment metadata record.
   */
  saveAttachment(spaceId: string, attachment: Attachment): Promise<void>;

  /**
   * Get an attachment by ID.
   */
  getAttachment(spaceId: string, attachmentId: string): Promise<Attachment | null>;

  /**
   * Get attachments for a channel.
   */
  getAttachments(spaceId: string, channelId: string, params?: GetAttachmentsParams): Promise<Attachment[]>;

  /**
   * Get attachments linked to a specific message.
   */
  getMessageAttachments(spaceId: string, messageId: string): Promise<Attachment[]>;

  /**
   * Link attachments to a message (after message is created).
   */
  linkAttachmentsToMessage(spaceId: string, messageId: string, attachmentIds: string[]): Promise<void>;

  /**
   * Delete an attachment metadata record.
   */
  deleteAttachment(spaceId: string, attachmentId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Knowledge Base Operations
  // ---------------------------------------------------------------------------

  /**
   * List all published knowledge bases in a space.
   */
  listKnowledgeBases(spaceId: string): Promise<KBMetadata[]>;

  /**
   * Get a KB document by channel and path.
   */
  getKBDocument(spaceId: string, channel: string, path: string): Promise<KBDocument | null>;

  /**
   * Search KB content using FTS5 or semantic search.
   */
  searchKB(spaceId: string, channel: string, query: string, options?: KBSearchOptions): Promise<KBSearchResult[]>;

  /**
   * Index a KB document for search (FTS5).
   */
  indexKBDocument(spaceId: string, doc: KBDocument): Promise<void>;

  /**
   * Remove a KB document from search index.
   */
  removeKBDocument(spaceId: string, channel: string, path: string): Promise<void>;

  /**
   * Store an embedding for semantic search.
   */
  storeEmbedding(spaceId: string, artifactId: string, channel: string, embedding: number[]): Promise<void>;

  /**
   * Search by embedding similarity.
   */
  searchByEmbedding(spaceId: string, embedding: number[], options?: EmbeddingSearchOptions): Promise<EmbeddingSearchResult[]>;

  /**
   * Delete an embedding.
   */
  deleteEmbedding(spaceId: string, artifactId: string): Promise<boolean>;

  /**
   * Check if an embedding exists.
   */
  hasEmbedding(spaceId: string, artifactId: string): Promise<boolean>;

  // ---------------------------------------------------------------------------
  // Artifact Operations
  // ---------------------------------------------------------------------------

  /**
   * Create a new artifact.
   */
  createArtifact(spaceId: string, channelId: string, input: CreateArtifactInput): Promise<Artifact>;

  /**
   * Get an artifact by slug.
   */
  getArtifact(spaceId: string, channelId: string, slug: string): Promise<Artifact | null>;

  /**
   * Update an artifact (simple update, overwrites fields).
   */
  updateArtifact(
    spaceId: string,
    channelId: string,
    slug: string,
    update: UpdateArtifactInput,
    updatedBy: string
  ): Promise<Artifact>;

  /**
   * Update an artifact with compare-and-swap (CAS) for atomic updates.
   * Returns conflict info if any oldValue doesn't match current value.
   */
  updateArtifactWithCAS(
    spaceId: string,
    channelId: string,
    slug: string,
    changes: CASChange[],
    updatedBy: string
  ): Promise<CASResult>;

  /**
   * Archive an artifact (soft delete).
   */
  archiveArtifact(spaceId: string, channelId: string, slug: string, updatedBy: string): Promise<Artifact>;

  /**
   * List artifacts with optional filters.
   */
  listArtifacts(spaceId: string, channelId: string, filters?: ListArtifactsParams): Promise<ArtifactSummary[]>;

  /**
   * Get artifacts matching a glob pattern as a tree structure.
   */
  globArtifacts(spaceId: string, channelId: string, pattern: string): Promise<ArtifactTreeNode[]>;

  /**
   * Create a named version snapshot of an artifact.
   */
  checkpointArtifact(
    spaceId: string,
    channelId: string,
    slug: string,
    versionName: string,
    message: string | undefined,
    createdBy: string
  ): Promise<ArtifactVersion>;

  /**
   * Get a specific version of an artifact.
   */
  getArtifactVersion(
    spaceId: string,
    channelId: string,
    slug: string,
    versionName: string
  ): Promise<ArtifactVersion | null>;

  /**
   * List all versions of an artifact.
   */
  listArtifactVersions(spaceId: string, channelId: string, slug: string): Promise<ArtifactVersion[]>;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize storage (create tables, etc.).
   */
  initialize(): Promise<void>;

  /**
   * Close storage connections.
   */
  close(): Promise<void>;
}

// =============================================================================
// Parameter Types
// =============================================================================

export interface CreateSpaceParams {
  /** Space ID (ULID) - if not provided, will be generated */
  id?: string;
  /** Owner's external identity (e.g., Sanity user ID) */
  ownerId: string;
  /** Optional display name for the space */
  name?: string;
}

export interface CreateChannelParams {
  id: string;
  name: string;
  description?: string;
  focusSlug?: string;
  tagline?: string;
  mission?: string;
  /** Callsign of the channel leader (receives unaddressed human messages) */
  leader?: string;
}

export interface ListChannelsParams {
  /** Include archived channels */
  includeArchived?: boolean;
  /** Limit number of results */
  limit?: number;
}

export interface GetMessagesParams {
  /** Return messages after this ID (ULID - for sync) */
  since?: string;
  /** Return messages before this ID (ULID - for pagination) */
  before?: string;
  /** Maximum number of messages to return */
  limit?: number;
}

export interface GetAgentHistoryParams {
  /** Agent's callsign */
  agentCallsign: string;
  /** Agent's instance start time (joinedAt from roster) */
  sinceTimestamp: string;
  /** Maximum number of messages to return */
  limit?: number;
}

export interface GetAttachmentsParams {
  /** Filter by uploader */
  uploadedBy?: string;
  /** Maximum number of attachments to return */
  limit?: number;
}

export interface EmbeddingSearchOptions {
  /** Filter by channel */
  channel?: string;
  /** Maximum number of results */
  limit?: number;
}

export interface SaveStructuredAskParams {
  /** Channel ID */
  channelId: string;
  /** Who is creating this structured ask */
  sender: string;
  /** The prompt text */
  prompt: string;
  /** Form definition */
  formData: StructuredAskFormData;
}

export interface SubmitStructuredAskParams {
  /** Message ID of the structured ask */
  messageId: string;
  /** Field responses keyed by field id */
  response: Record<string, unknown>;
  /** Who is submitting */
  respondedBy: string;
}

export interface CreateArtifactInput {
  /** Immutable slug identifier */
  slug: string;
  /** Artifact type */
  type: ArtifactType;
  /** Optional display title */
  title?: string;
  /** Required summary (1-3 sentences) */
  tldr: string;
  /** Main content (markdown for docs, raw code for code artifacts) */
  content: string;
  /** Parent artifact slug for tree structure */
  parentSlug?: string;
  /** Initial status (defaults to 'published' for docs, 'pending' for tasks) */
  status?: ArtifactStatus;
  /** Assigned agents (for tasks) */
  assignees?: string[];
  /** Freeform tags */
  labels?: string[];
  /** Type-specific properties */
  props?: Record<string, unknown>;
  /** Creator callsign */
  createdBy: string;
}

export interface UpdateArtifactInput {
  /** Optional display title */
  title?: string;
  /** Summary */
  tldr?: string;
  /** Main content */
  content?: string;
  /** Parent artifact slug */
  parentSlug?: string | null;
  /** Status */
  status?: ArtifactStatus;
  /** Assigned agents */
  assignees?: string[];
  /** Freeform tags */
  labels?: string[];
  /** Type-specific properties */
  props?: Record<string, unknown>;
}

export interface ListArtifactsParams {
  /** Filter by type */
  type?: ArtifactType;
  /** Filter by status */
  status?: ArtifactStatus;
  /** Filter by assignee */
  assignee?: string;
  /** Filter by parent slug ('root' for top-level only) */
  parentSlug?: string;
  /** Keyword search (slug, title, tldr, content) */
  search?: string;
  /** Regex pattern search */
  regex?: string;
  /** Maximum number of results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

// =============================================================================
// Factory Types
// =============================================================================

export interface StorageOptions {
  /** Storage backend type */
  type: 'sqlite' | 'dynamodb';
  /** SQLite options */
  sqlite?: {
    /** Database file path (or :memory: for in-memory) */
    path: string;
  };
  /** DynamoDB options */
  dynamodb?: {
    /** AWS region */
    region: string;
    /** Table name */
    tableName: string;
    /** Optional endpoint (for local development) */
    endpoint?: string;
  };
}
