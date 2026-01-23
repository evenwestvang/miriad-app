/**
 * Storage Interface
 *
 * Abstract interface for Cast storage backends.
 * Phase 1: Messages
 * Phase 2: Channels + Roster
 * Phase A: Artifacts
 */

import type {
  StoredMessage,
  CreateMessageInput,
  GetMessagesParams,
  StoredChannel,
  CreateChannelInput,
  UpdateChannelInput,
  ListChannelsParams,
  RosterEntry,
  AddToRosterInput,
  UpdateRosterInput,
  // User/Space types (Spaces & Auth)
  StoredUser,
  CreateUserInput,
  StoredSpace,
  CreateSpaceInput,
  // Artifact types (Phase A)
  StoredArtifact,
  CreateArtifactInput,
  ArtifactCASChange,
  ArtifactCASResult,
  ArtifactEditInput,
  ListArtifactsParams,
  ArtifactSummary,
  ArtifactTreeNode,
  ArtifactVersion,
  CreateArtifactVersionInput,
  RecursiveArchiveResult,
  // Secrets types (App Integrations)
  SecretMetadata,
  // Local Agent Server types (Stage 3)
  StoredLocalAgentServer,
  CreateLocalAgentServerInput,
  // Bootstrap Token types (Stage 3)
  StoredBootstrapToken,
  CreateBootstrapTokenInput,
  // Cost tracking types
  StoredCostRecord,
  CreateCostRecordInput,
  CostTally,
  // WebSocket connection types
  StoredConnection,
  ConnectionProtocol,
  // Runtime types
  StoredRuntime,
  CreateRuntimeInput,
  UpdateRuntimeInput,
} from '@cast/core';

// =============================================================================
// Secret Types
// =============================================================================

/**
 * Input for setting a secret on an artifact.
 */
export interface SetSecretInput {
  /** The secret value (plaintext - will be encrypted) */
  value: string;

  /** Optional expiry time (ISO 8601) */
  expiresAt?: string;
}

// =============================================================================
// Storage Interface
// =============================================================================

export interface Storage {
  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  /**
   * Save a message.
   */
  saveMessage(message: CreateMessageInput): Promise<StoredMessage>;

  /**
   * Get a message by ID.
   */
  getMessage(spaceId: string, messageId: string): Promise<StoredMessage | null>;

  /**
   * Get messages for a channel.
   */
  getMessages(
    spaceId: string,
    channelId: string,
    params?: GetMessagesParams
  ): Promise<StoredMessage[]>;

  /**
   * Get messages by channel ID only (no spaceId needed since channelId is globally unique).
   * More efficient for sync operations where spaceId isn't readily available.
   */
  getMessagesByChannelId(
    channelId: string,
    params?: GetMessagesParams
  ): Promise<StoredMessage[]>;

  /**
   * Update a message (e.g., mark complete after streaming).
   */
  updateMessage(
    spaceId: string,
    messageId: string,
    update: Partial<StoredMessage>
  ): Promise<void>;

  /**
   * Delete a message.
   */
  deleteMessage(spaceId: string, messageId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // User Operations (Spaces & Auth)
  // ---------------------------------------------------------------------------

  /**
   * Create a new user.
   */
  createUser(input: CreateUserInput): Promise<StoredUser>;

  /**
   * Get a user by ID.
   */
  getUser(userId: string): Promise<StoredUser | null>;

  /**
   * Get a user by external ID (e.g., WorkOS user_id).
   */
  getUserByExternalId(externalId: string): Promise<StoredUser | null>;

  /**
   * Record that a user accepted a disclaimer version.
   */
  acceptDisclaimer(userId: string, version: string): Promise<StoredUser | null>;

  // ---------------------------------------------------------------------------
  // Space Operations (Spaces & Auth)
  // ---------------------------------------------------------------------------

  /**
   * Create a new space.
   */
  createSpace(input: CreateSpaceInput): Promise<StoredSpace>;

  /**
   * Get a space by ID.
   */
  getSpace(spaceId: string): Promise<StoredSpace | null>;

  /**
   * Get all spaces owned by a user.
   */
  getSpacesByOwner(ownerId: string): Promise<StoredSpace[]>;

  /**
   * List all spaces with their owners.
   * Used for dev login screen to show available spaces.
   */
  listSpacesWithOwners(): Promise<Array<{ space: StoredSpace; owner: StoredUser }>>;

  // ---------------------------------------------------------------------------
  // Channel Operations (Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Create a new channel.
   */
  createChannel(input: CreateChannelInput): Promise<StoredChannel>;

  /**
   * Get a channel by ID (requires spaceId for scoping).
   */
  getChannel(spaceId: string, channelId: string): Promise<StoredChannel | null>;

  /**
   * Get a channel by ID only (no spaceId required).
   * Channel IDs are globally unique (ULIDs), so this is safe.
   * Returns the channel with its spaceId for access control checks.
   */
  getChannelById(channelId: string): Promise<StoredChannel | null>;

  /**
   * Get a channel by name.
   */
  getChannelByName(spaceId: string, name: string): Promise<StoredChannel | null>;

  /**
   * Resolve a channel by ID or name in a single query.
   * Tries exact ID match first, then name match.
   * More efficient than getChannelByName() || getChannel().
   */
  resolveChannel(spaceId: string, idOrName: string): Promise<StoredChannel | null>;

  /**
   * Get a channel with its roster in a single query (JOIN).
   * More efficient than getChannel() + listRoster().
   */
  getChannelWithRoster(
    spaceId: string,
    channelId: string
  ): Promise<{ channel: StoredChannel; roster: RosterEntry[] } | null>;

  /**
   * Resolve a channel by ID or name and include roster in a single operation.
   * Combines resolveChannel() + listRoster() efficiently.
   */
  resolveChannelWithRoster(
    spaceId: string,
    idOrName: string
  ): Promise<{ channel: StoredChannel; roster: RosterEntry[] } | null>;

  /**
   * List channels in a space.
   */
  listChannels(
    spaceId: string,
    params?: ListChannelsParams
  ): Promise<StoredChannel[]>;

  /**
   * Update a channel.
   */
  updateChannel(
    spaceId: string,
    channelId: string,
    update: UpdateChannelInput
  ): Promise<void>;

  /**
   * Archive a channel (soft delete).
   */
  archiveChannel(spaceId: string, channelId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Roster Operations (Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Add an agent to a channel's roster.
   */
  addToRoster(input: AddToRosterInput): Promise<RosterEntry>;

  /**
   * Get a roster entry by ID.
   */
  getRosterEntry(channelId: string, entryId: string): Promise<RosterEntry | null>;

  /**
   * Get a roster entry by callsign.
   */
  getRosterByCallsign(channelId: string, callsign: string): Promise<RosterEntry | null>;

  /**
   * List all agents in a channel's roster.
   */
  listRoster(channelId: string): Promise<RosterEntry[]>;

  /**
   * List archived agents in a channel's roster.
   * Used to detect @mentions of dismissed agents for reactivation UI.
   */
  listArchivedRoster(channelId: string): Promise<RosterEntry[]>;

  /**
   * Get all agents bound to a specific runtime.
   * Returns roster entries with channel info for display.
   *
   * @param runtimeId - Runtime ID
   * @returns Array of roster entries with channel name
   */
  getAgentsByRuntime(runtimeId: string): Promise<Array<RosterEntry & { channelName: string }>>;

  /**
   * Update a roster entry (e.g., change status).
   */
  updateRosterEntry(
    channelId: string,
    entryId: string,
    update: UpdateRosterInput
  ): Promise<void>;

  /**
   * Remove an agent from a channel's roster.
   */
  removeFromRoster(channelId: string, entryId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Artifact Operations (Phase A)
  // ---------------------------------------------------------------------------

  /**
   * Create a new artifact.
   * - Generates ULID for id
   * - Computes path from parentSlug hierarchy (using ltree format)
   * - Auto-extracts [[slug]] references into refs array
   * - Sets default status based on type if not provided
   */
  createArtifact(channelId: string, input: CreateArtifactInput): Promise<StoredArtifact>;

  /**
   * Get an artifact by slug.
   * Slug is unique per channel.
   */
  getArtifact(channelId: string, slug: string): Promise<StoredArtifact | null>;

  /**
   * Update artifact fields with compare-and-swap (CAS) for atomic multi-agent coordination.
   * Only updates if all oldValue fields match current values.
   * Returns conflict info if any value doesn't match.
   *
   * Allowed fields: title, tldr, status, parentSlug, orderKey, assignees, labels, props
   * Content changes should use editArtifact for surgical find-replace.
   */
  updateArtifactWithCAS(
    channelId: string,
    slug: string,
    changes: ArtifactCASChange[],
    updatedBy: string
  ): Promise<ArtifactCASResult>;

  /**
   * Surgical find-replace edit on artifact content.
   * - oldString must match exactly once in content
   * - Returns error if not found or ambiguous (multiple matches)
   * - Auto-updates refs array from new content
   * - Does NOT create a version snapshot (use checkpointArtifact for that)
   */
  editArtifact(
    channelId: string,
    slug: string,
    edit: ArtifactEditInput
  ): Promise<StoredArtifact>;

  /**
   * Set the attachedToMessageId on an artifact.
   * Used to link uploaded assets to messages after the fact.
   * Throws if artifact doesn't exist.
   */
  setArtifactAttachment(
    channelId: string,
    slug: string,
    messageId: string,
    updatedBy: string
  ): Promise<void>;

  /**
   * Archive an artifact (soft delete).
   * Sets status to 'archived'.
   */
  archiveArtifact(
    channelId: string,
    slug: string,
    updatedBy: string
  ): Promise<StoredArtifact>;

  /**
   * Archive an artifact and all its descendants recursively.
   * Returns list of all archived items with their previous statuses (for undo).
   * Uses ltree path for efficient hierarchical query.
   */
  archiveArtifactRecursive(
    channelId: string,
    slug: string,
    updatedBy: string
  ): Promise<RecursiveArchiveResult>;

  /**
   * Hard delete all artifacts in a channel.
   * WARNING: This is a destructive operation - artifacts cannot be recovered.
   * Used for resetting channels during development/testing.
   *
   * @returns Number of artifacts deleted
   */
  deleteAllArtifactsInChannel(channelId: string): Promise<number>;

  /**
   * List artifacts with optional filters.
   * Returns summary info (not full content) for efficiency.
   *
   * Filters:
   * - type: filter by artifact type
   * - status: filter by status
   * - assignee: filter tasks by assignee (checks JSONB array)
   * - parentSlug: filter by parent ('root' = top-level only)
   * - search: keyword search using FTS (BM25 ranking)
   * - regex: regex pattern matching on slug/title/tldr/content
   * - limit/offset: pagination
   */
  listArtifacts(
    channelId: string,
    params?: ListArtifactsParams
  ): Promise<ArtifactSummary[]>;

  /**
   * Get artifacts matching a glob pattern as a tree structure.
   * Uses ltree path for efficient hierarchical queries.
   *
   * Pattern examples:
   * - "/**" - entire tree
   * - "/auth-system/**" - subtree under auth-system
   * - "/**\/*.ts" - all .ts slugs anywhere
   * - "/*" - root level only
   */
  globArtifacts(channelId: string, pattern: string): Promise<ArtifactTreeNode[]>;

  /**
   * List all published knowledge bases in a space.
   * Returns KB metadata with channel name (single JOIN query, no N+1).
   *
   * @param spaceId - Space to search in
   * @returns Array of published KBs with channel names
   */
  listPublishedKnowledgeBases(spaceId: string): Promise<
    Array<{
      name: string;
      title?: string;
      tldr?: string;
    }>
  >;

  /**
   * Create a named version snapshot of an artifact.
   * Snapshots current content and tldr.
   * Versions are immutable once created.
   */
  checkpointArtifact(
    channelId: string,
    slug: string,
    input: CreateArtifactVersionInput
  ): Promise<ArtifactVersion>;

  /**
   * Get a specific version of an artifact.
   */
  getArtifactVersion(
    channelId: string,
    slug: string,
    versionName: string
  ): Promise<ArtifactVersion | null>;

  /**
   * List all versions of an artifact.
   * Returns versions ordered by creation time (newest first).
   */
  listArtifactVersions(
    channelId: string,
    slug: string
  ): Promise<ArtifactVersion[]>;

  /**
   * Compare two versions of an artifact, or a version against current content.
   * Returns unified diff format.
   *
   * @param fromVersion - Starting version name (required)
   * @param toVersion - Ending version name (optional, defaults to current content)
   */
  diffArtifactVersions(
    channelId: string,
    slug: string,
    fromVersion: string,
    toVersion?: string
  ): Promise<string>;

  // ---------------------------------------------------------------------------
  // Secrets Operations (App Integrations)
  // ---------------------------------------------------------------------------

  /**
   * Set a secret on an artifact.
   * The value is encrypted before storage.
   * If the secret already exists, it is overwritten.
   *
   * @param spaceId - Space ID (used for key derivation)
   * @param channelId - Channel the artifact belongs to
   * @param slug - Artifact slug
   * @param key - Secret key name
   * @param input - Secret value and optional expiry
   */
  setSecret(
    spaceId: string,
    channelId: string,
    slug: string,
    key: string,
    input: SetSecretInput
  ): Promise<void>;

  /**
   * Delete a secret from an artifact.
   *
   * @param channelId - Channel the artifact belongs to
   * @param slug - Artifact slug
   * @param key - Secret key name
   */
  deleteSecret(
    channelId: string,
    slug: string,
    key: string
  ): Promise<void>;

  /**
   * Get the decrypted value of a secret.
   * Only the server should call this - values are never exposed via API.
   *
   * @param spaceId - Space ID (used for key derivation)
   * @param channelId - Channel the artifact belongs to
   * @param slug - Artifact slug
   * @param key - Secret key name
   * @returns The decrypted value, or null if not found
   */
  getSecretValue(
    spaceId: string,
    channelId: string,
    slug: string,
    key: string
  ): Promise<string | null>;

  /**
   * Get metadata for a secret (without the value).
   *
   * @param channelId - Channel the artifact belongs to
   * @param slug - Artifact slug
   * @param key - Secret key name
   * @returns Secret metadata, or null if not found
   */
  getSecretMetadata(
    channelId: string,
    slug: string,
    key: string
  ): Promise<SecretMetadata | null>;

  // ---------------------------------------------------------------------------
  // Space Secrets Operations
  // ---------------------------------------------------------------------------

  /**
   * Set a secret on a space.
   * Secrets are encrypted using AES-256-GCM with a per-space derived key.
   *
   * @param spaceId - Space ID
   * @param key - Secret key name (e.g., "anthropic_api_key")
   * @param input - Secret value and optional expiry
   */
  setSpaceSecret(
    spaceId: string,
    key: string,
    input: SetSecretInput
  ): Promise<void>;

  /**
   * Delete a secret from a space.
   *
   * @param spaceId - Space ID
   * @param key - Secret key name
   */
  deleteSpaceSecret(
    spaceId: string,
    key: string
  ): Promise<void>;

  /**
   * Get the decrypted value of a space secret.
   * Only the server should call this - values are never exposed via API.
   *
   * @param spaceId - Space ID
   * @param key - Secret key name
   * @returns The decrypted value, or null if not found
   */
  getSpaceSecretValue(
    spaceId: string,
    key: string
  ): Promise<string | null>;

  /**
   * Get metadata for a space secret (without the value).
   *
   * @param spaceId - Space ID
   * @param key - Secret key name
   * @returns Secret metadata, or null if not found
   */
  getSpaceSecretMetadata(
    spaceId: string,
    key: string
  ): Promise<SecretMetadata | null>;

  /**
   * List all secret keys on a space (metadata only, no values).
   *
   * @param spaceId - Space ID
   * @returns Record of key names to metadata
   */
  listSpaceSecrets(
    spaceId: string
  ): Promise<Record<string, SecretMetadata>>;

  // ---------------------------------------------------------------------------
  // Local Agent Server Operations (Stage 3)
  // ---------------------------------------------------------------------------

  /**
   * Save local agent server credentials.
   * Called when a local agent server exchanges a bootstrap token for credentials.
   *
   * @param input - Server credential data
   * @returns The stored server credential
   */
  saveLocalAgentServer(input: CreateLocalAgentServerInput): Promise<StoredLocalAgentServer>;

  /**
   * Get local agent server by server ID.
   *
   * @param serverId - Server ID (srv_ULID format)
   * @returns Server credential or null if not found
   */
  getLocalAgentServer(serverId: string): Promise<StoredLocalAgentServer | null>;

  /**
   * Get local agent server by secret.
   * Used for authenticating server requests via Authorization header.
   *
   * @param secret - The HMAC-signed secret
   * @returns Server credential or null if not found/revoked
   */
  getLocalAgentServerBySecret(secret: string): Promise<StoredLocalAgentServer | null>;

  /**
   * Get all active local agent servers for a user.
   * Used for UI listing of connected servers.
   *
   * @param userId - User ID who registered the servers
   * @returns Array of active (non-revoked) server credentials
   */
  getLocalAgentServersByUser(userId: string): Promise<StoredLocalAgentServer[]>;

  /**
   * Revoke local agent server credentials.
   * Sets revokedAt timestamp, preventing further authentication.
   *
   * @param serverId - Server ID to revoke
   * @returns true if revoked, false if not found or already revoked
   */
  revokeLocalAgentServer(serverId: string): Promise<boolean>;

  // ---------------------------------------------------------------------------
  // Bootstrap Token Operations (Stage 3)
  // ---------------------------------------------------------------------------

  /**
   * Save a bootstrap token.
   * Called when UI requests a new connection string for local agent setup.
   *
   * @param input - Bootstrap token data
   * @returns The stored bootstrap token
   */
  saveBootstrapToken(input: CreateBootstrapTokenInput): Promise<StoredBootstrapToken>;

  /**
   * Get a bootstrap token by token value.
   * Returns null if not found, expired, or already consumed.
   *
   * @param token - The token value (bst_... format)
   * @returns Bootstrap token or null if not found/invalid
   */
  getBootstrapToken(token: string): Promise<StoredBootstrapToken | null>;

  /**
   * Consume a bootstrap token (mark as used).
   * Called when CLI exchanges token for server credentials.
   *
   * @param token - The token value to consume
   * @returns true if consumed, false if not found or already consumed
   */
  consumeBootstrapToken(token: string): Promise<boolean>;

  /**
   * Delete expired bootstrap tokens.
   * Called periodically for cleanup.
   *
   * @returns Number of tokens deleted
   */
  cleanupExpiredBootstrapTokens(): Promise<number>;

  // ---------------------------------------------------------------------------
  // Cost Tracking Operations
  // ---------------------------------------------------------------------------

  /**
   * Save a cost record.
   * Called when an agent completes a turn and reports cost.
   *
   * @param input - Cost record data
   * @returns The stored cost record
   */
  saveCostRecord(input: CreateCostRecordInput): Promise<StoredCostRecord>;

  /**
   * Get aggregated cost tally for a channel, broken down by callsign.
   * Used to initialize frontend cost display on channel load.
   *
   * @param channelId - Channel ID
   * @returns Array of cost tallies per agent
   */
  getChannelCostTally(channelId: string): Promise<CostTally[]>;

  // ---------------------------------------------------------------------------
  // WebSocket Connection Operations
  // ---------------------------------------------------------------------------

  /**
   * Save a WebSocket connection record.
   * Called when a client connects to the WebSocket server.
   *
   * @param connectionId - Unique connection identifier
   * @param channelId - Channel ID (use '__pending__' for connect-first-auth-later)
   * @param options - Optional connection metadata (agent, container, protocol, runtime)
   */
  saveConnection(
    connectionId: string,
    channelId: string,
    options?: {
      agentCallsign?: string;
      containerId?: string;
      protocol?: ConnectionProtocol;
      runtimeId?: string;
    }
  ): Promise<void>;

  /**
   * Get a connection record by ID.
   *
   * @param connectionId - Connection ID
   * @returns Connection record or null if not found
   */
  getConnection(connectionId: string): Promise<StoredConnection | null>;

  /**
   * Update a connection's channel (for channel switching).
   *
   * @param connectionId - Connection ID
   * @param channelId - New channel ID
   */
  updateConnectionChannel(connectionId: string, channelId: string): Promise<void>;

  /**
   * Update a runtime connection's runtimeId (for runtime_ready handshake).
   * Called when a runtime connection sends runtime_ready message.
   *
   * @param connectionId - Connection ID
   * @param runtimeId - Runtime ID to associate with this connection
   */
  updateConnectionRuntime(connectionId: string, runtimeId: string): Promise<void>;

  /**
   * Delete a connection record.
   * Called when a client disconnects.
   *
   * @param connectionId - Connection ID to remove
   */
  deleteConnection(connectionId: string): Promise<void>;

  /**
   * Get all connections for a channel.
   * Used for broadcasting messages to channel subscribers.
   *
   * @param channelId - Channel ID
   * @returns Array of connection records
   */
  getConnectionsByChannel(channelId: string): Promise<StoredConnection[]>;

  // ---------------------------------------------------------------------------
  // Runtime Operations
  // ---------------------------------------------------------------------------

  /**
   * Create a new runtime.
   * Generates ULID for id if not provided.
   *
   * @param input - Runtime data
   * @returns The stored runtime
   */
  createRuntime(input: CreateRuntimeInput): Promise<StoredRuntime>;

  /**
   * Get a runtime by ID.
   *
   * @param runtimeId - Runtime ID (ULID)
   * @returns Runtime or null if not found
   */
  getRuntime(runtimeId: string): Promise<StoredRuntime | null>;

  /**
   * Get a runtime by name within a space.
   *
   * @param spaceId - Space ID
   * @param name - Runtime name
   * @returns Runtime or null if not found
   */
  getRuntimeByName(spaceId: string, name: string): Promise<StoredRuntime | null>;

  /**
   * Get all runtimes for a space.
   *
   * @param spaceId - Space ID
   * @returns Array of runtimes (online first, then by name)
   */
  getRuntimesBySpace(spaceId: string): Promise<StoredRuntime[]>;

  /**
   * Update a runtime.
   *
   * @param runtimeId - Runtime ID
   * @param update - Fields to update
   */
  updateRuntime(runtimeId: string, update: UpdateRuntimeInput): Promise<void>;

  /**
   * Delete a runtime.
   * Also clears runtime_id from any roster entries bound to it.
   *
   * @param runtimeId - Runtime ID
   */
  deleteRuntime(runtimeId: string): Promise<void>;

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
