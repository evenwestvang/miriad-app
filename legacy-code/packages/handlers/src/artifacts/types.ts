/**
 * Artifact Handler Types
 *
 * Type definitions for artifact CRUD operations.
 * Platform-agnostic - works with both sync (SQLite) and async (DynamoDB) storage.
 */

/**
 * Artifact status values
 */
export type ArtifactStatus = 'draft' | 'published' | 'archived' | 'pending' | 'in_progress' | 'done' | 'blocked';

/**
 * Artifact type values
 */
export type ArtifactType = 'doc' | 'code' | 'task' | 'decision' | 'system.playbook' | 'system.agent' | 'system.mcp' | 'system.focus' | string;

/**
 * Full artifact data shape
 */
export interface Artifact {
  id: string;
  slug: string;
  channelId: string;
  type: ArtifactType;
  title?: string;
  tldr: string;
  content: string;
  status: ArtifactStatus;
  parentSlug?: string;
  assignees?: string[];
  labels?: string[];
  props?: Record<string, unknown>;
  refs?: string[];
  orderKey?: string;
  createdBy: string;
  createdAt: string;
  updatedBy?: string;
  updatedAt?: string;
  version: number;
  versions?: ArtifactVersion[];
}

/**
 * Artifact version snapshot
 */
export interface ArtifactVersion {
  version: string;
  tldr: string;
  content: string;
  createdBy: string;
  createdAt: string;
  message?: string;
}

/**
 * Input for creating an artifact
 */
export interface CreateArtifactInput {
  slug: string;
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

/**
 * Input for updating an artifact (simple mode)
 */
export interface UpdateArtifactInput {
  title?: string;
  tldr?: string;
  content?: string;
  status?: ArtifactStatus;
  parentSlug?: string | null;
  assignees?: string[];
  labels?: string[];
  props?: Record<string, unknown>;
}

/**
 * Compare-and-swap change for atomic updates
 */
export interface CASChange {
  field: string;
  oldValue?: unknown;
  newValue?: unknown;
}

/**
 * Result of a CAS update operation
 */
export interface CASUpdateResult {
  success: boolean;
  artifact?: Artifact;
  conflict?: {
    field: string;
    expected: unknown;
    actual: unknown;
  };
}

/**
 * Filters for listing artifacts
 */
export interface ListArtifactFilters {
  type?: string;
  status?: string;
  assignee?: string;
  parentSlug?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

/**
 * Artifact storage interface - abstracts storage access.
 * Both sync (SQLite) and async (DynamoDB) implementations can satisfy this.
 */
export interface ArtifactStorage {
  /**
   * Create a new artifact
   */
  create(input: CreateArtifactInput & { channelId: string }): Artifact | Promise<Artifact>;

  /**
   * Read an artifact by slug
   */
  read(channelId: string, slug: string): Artifact | null | undefined | Promise<Artifact | null | undefined>;

  /**
   * List artifacts with filters
   */
  list(channelId: string, filters?: ListArtifactFilters): Artifact[] | Promise<Artifact[]>;

  /**
   * Glob pattern matching for artifact tree view
   */
  glob(channelId: string, pattern: string): string | Promise<string>;

  /**
   * Update artifact (simple mode)
   */
  update(channelId: string, slug: string, fields: UpdateArtifactInput, updatedBy: string): Artifact | Promise<Artifact>;

  /**
   * Update artifact with compare-and-swap
   */
  updateWithCAS(channelId: string, slug: string, changes: CASChange[], updatedBy: string): CASUpdateResult | Promise<CASUpdateResult>;

  /**
   * Archive (soft delete) an artifact
   */
  archive(channelId: string, slug: string, updatedBy: string): Artifact | Promise<Artifact>;
}

/**
 * Channel verifier interface - checks channel exists and belongs to space
 */
export interface ChannelVerifier {
  /**
   * Verify channel exists and return it, or null if not found
   */
  verifyChannel(spaceId: string, channelId: string): { id: string; name: string } | null | undefined | Promise<{ id: string; name: string } | null | undefined>;
}

/**
 * Broadcast function type for WebSocket notifications
 */
export type BroadcastFn = (channelId: string, frame: string) => void | Promise<void>;

/**
 * Optional KB indexer for semantic search
 */
export interface KBIndexer {
  indexArtifact?(spaceId: string, artifact: Artifact): void | Promise<void>;
  removeFromIndex?(spaceId: string, artifact: Artifact): void | Promise<void>;
}

/**
 * Handler context - dependencies injected into handlers
 */
export interface ArtifactHandlerContext {
  storage: ArtifactStorage;
  channelVerifier: ChannelVerifier;
  broadcast: BroadcastFn;
  spaceId: string;
  kbIndexer?: KBIndexer;
  validateProps?: (type: string, props: Record<string, unknown>) => { error: string } | null;
}

/**
 * Handler result - standardized response
 */
export interface HandlerResult<T = unknown> {
  status: number;
  body: T;
}
