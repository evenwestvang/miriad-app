/**
 * Artifact Handlers
 *
 * Platform-agnostic business logic for artifact CRUD operations.
 * Extracted from packages/server/src/http.ts.
 */

import type {
  Artifact,
  ArtifactHandlerContext,
  CASChange,
  CreateArtifactInput,
  HandlerResult,
  ListArtifactFilters,
  UpdateArtifactInput,
} from './types.js';

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Await a potentially sync or async result
 */
async function awaitResult<T>(result: T | Promise<T>): Promise<T> {
  return result instanceof Promise ? await result : result;
}

/**
 * Build WebSocket broadcast frame for artifact events
 */
function buildArtifactFrame(action: 'created' | 'updated' | 'archived', artifact: Artifact): string {
  return JSON.stringify({
    i: `artifact:${artifact.slug}`,
    t: artifact.updatedAt || artifact.createdAt,
    v: {
      type: 'artifact',
      action,
      artifact,
    },
  });
}

/**
 * Verify channel exists and return error result if not
 */
async function verifyChannelExists(
  ctx: ArtifactHandlerContext,
  channelId: string
): Promise<HandlerResult<{ error: string }> | null> {
  const channel = await awaitResult(ctx.channelVerifier.verifyChannel(ctx.spaceId, channelId));
  if (!channel) {
    return { status: 404, body: { error: 'Channel not found' } };
  }
  return null;
}

/**
 * Index artifact for KB semantic search (async, non-blocking)
 */
function maybeIndexArtifact(ctx: ArtifactHandlerContext, artifact: Artifact): void {
  if (ctx.kbIndexer?.indexArtifact) {
    Promise.resolve(ctx.kbIndexer.indexArtifact(ctx.spaceId, artifact)).catch(() => {});
  }
}

/**
 * Remove artifact from KB index (async, non-blocking)
 */
function maybeRemoveFromIndex(ctx: ArtifactHandlerContext, artifact: Artifact): void {
  if (ctx.kbIndexer?.removeFromIndex) {
    Promise.resolve(ctx.kbIndexer.removeFromIndex(ctx.spaceId, artifact)).catch(() => {});
  }
}

// =============================================================================
// Create Artifact
// =============================================================================

export interface CreateArtifactParams {
  channelId: string;
  input: CreateArtifactInput;
}

/**
 * Create a new artifact
 *
 * POST /channels/:id/artifacts
 */
export async function createArtifact(
  ctx: ArtifactHandlerContext,
  params: CreateArtifactParams
): Promise<HandlerResult<Artifact | { error: string }>> {
  const { channelId, input } = params;

  // Verify channel exists
  const channelError = await verifyChannelExists(ctx, channelId);
  if (channelError) return channelError;

  // Validate required fields
  if (!input.slug || !input.type || !input.tldr || input.content === undefined || !input.createdBy) {
    return {
      status: 400,
      body: { error: 'Missing required fields: slug, type, tldr, content, createdBy' },
    };
  }

  // Validate props for system.* artifact types
  if (input.type.startsWith('system.') && input.props && ctx.validateProps) {
    const validationError = ctx.validateProps(input.type, input.props);
    if (validationError) {
      return { status: 400, body: validationError };
    }
  }

  // Create artifact
  const artifact = await awaitResult(ctx.storage.create({ ...input, channelId }));

  // Broadcast to WebSocket clients
  await awaitResult(ctx.broadcast(channelId, buildArtifactFrame('created', artifact)));

  // Index for KB semantic search (async)
  maybeIndexArtifact(ctx, artifact);

  return { status: 201, body: artifact };
}

// =============================================================================
// Read Artifact
// =============================================================================

export interface ReadArtifactParams {
  channelId: string;
  slug: string;
}

/**
 * Read a single artifact by slug
 *
 * GET /channels/:id/artifacts/:slug
 */
export async function readArtifact(
  ctx: ArtifactHandlerContext,
  params: ReadArtifactParams
): Promise<HandlerResult<Artifact | { error: string }>> {
  const { channelId, slug } = params;

  // Verify channel exists
  const channelError = await verifyChannelExists(ctx, channelId);
  if (channelError) return channelError;

  // Read artifact
  const artifact = await awaitResult(ctx.storage.read(channelId, slug));
  if (!artifact) {
    return { status: 404, body: { error: `Artifact not found: ${slug}` } };
  }

  return { status: 200, body: artifact };
}

// =============================================================================
// List Artifacts
// =============================================================================

export interface ListArtifactsParams {
  channelId: string;
  filters?: ListArtifactFilters;
}

/**
 * List artifacts with optional filters
 *
 * GET /channels/:id/artifacts
 */
export async function listArtifacts(
  ctx: ArtifactHandlerContext,
  params: ListArtifactsParams
): Promise<HandlerResult<{ artifacts: Artifact[] } | { error: string }>> {
  const { channelId, filters } = params;

  // Verify channel exists
  const channelError = await verifyChannelExists(ctx, channelId);
  if (channelError) return channelError;

  // List artifacts
  const artifacts = await awaitResult(ctx.storage.list(channelId, filters));

  return { status: 200, body: { artifacts } };
}

// =============================================================================
// Glob Tree View
// =============================================================================

export interface GlobArtifactsParams {
  channelId: string;
  pattern: string;
}

/**
 * Get artifact tree view via glob pattern
 *
 * GET /channels/:id/artifacts/tree
 */
export async function globArtifacts(
  ctx: ArtifactHandlerContext,
  params: GlobArtifactsParams
): Promise<HandlerResult<{ tree: string } | { error: string }>> {
  const { channelId, pattern } = params;

  // Verify channel exists
  const channelError = await verifyChannelExists(ctx, channelId);
  if (channelError) return channelError;

  // Get glob tree
  const tree = await awaitResult(ctx.storage.glob(channelId, pattern));

  return { status: 200, body: { tree } };
}

// =============================================================================
// Update Artifact (Simple Mode)
// =============================================================================

export interface UpdateArtifactParams {
  channelId: string;
  slug: string;
  input: UpdateArtifactInput;
  updatedBy: string;
}

/**
 * Update an artifact (simple field updates)
 *
 * PATCH /channels/:id/artifacts/:slug (without changes array)
 */
export async function updateArtifact(
  ctx: ArtifactHandlerContext,
  params: UpdateArtifactParams
): Promise<HandlerResult<Artifact | { error: string }>> {
  const { channelId, slug, input, updatedBy } = params;

  // Verify channel exists
  const channelError = await verifyChannelExists(ctx, channelId);
  if (channelError) return channelError;

  // Handle parentSlug null -> undefined conversion
  const updateFields = { ...input };
  if (updateFields.parentSlug === null) {
    updateFields.parentSlug = undefined;
  }

  // Update artifact
  const artifact = await awaitResult(ctx.storage.update(channelId, slug, updateFields, updatedBy));

  // Broadcast to WebSocket clients
  await awaitResult(ctx.broadcast(channelId, buildArtifactFrame('updated', artifact)));

  // Re-index for KB semantic search (async)
  maybeIndexArtifact(ctx, artifact);

  return { status: 200, body: artifact };
}

// =============================================================================
// Update Artifact (CAS Mode)
// =============================================================================

export interface UpdateArtifactCASParams {
  channelId: string;
  slug: string;
  changes: CASChange[];
  updatedBy: string;
}

/**
 * Update an artifact with compare-and-swap semantics
 *
 * PATCH /channels/:id/artifacts/:slug (with changes array)
 */
export async function updateArtifactCAS(
  ctx: ArtifactHandlerContext,
  params: UpdateArtifactCASParams
): Promise<HandlerResult<Artifact | { error: string; conflict?: unknown }>> {
  const { channelId, slug, changes, updatedBy } = params;

  // Verify channel exists
  const channelError = await verifyChannelExists(ctx, channelId);
  if (channelError) return channelError;

  // Validate props if being updated on a system.* artifact
  if (ctx.validateProps) {
    const propsChange = changes.find(c => c.field === 'props');
    if (propsChange) {
      const existingArtifact = await awaitResult(ctx.storage.read(channelId, slug));
      if (existingArtifact?.type.startsWith('system.')) {
        const validationError = ctx.validateProps(existingArtifact.type, propsChange.newValue as Record<string, unknown>);
        if (validationError) {
          return { status: 400, body: validationError };
        }
      }
    }
  }

  // Update with CAS
  const result = await awaitResult(ctx.storage.updateWithCAS(channelId, slug, changes, updatedBy));

  if (!result.success) {
    return { status: 409, body: { error: 'CAS conflict', conflict: result.conflict } };
  }

  // Broadcast to WebSocket clients
  await awaitResult(ctx.broadcast(channelId, buildArtifactFrame('updated', result.artifact!)));

  // Re-index for KB semantic search (async)
  maybeIndexArtifact(ctx, result.artifact!);

  return { status: 200, body: result.artifact! };
}

// =============================================================================
// Archive Artifact
// =============================================================================

export interface ArchiveArtifactParams {
  channelId: string;
  slug: string;
  updatedBy: string;
}

/**
 * Archive (soft delete) an artifact
 *
 * DELETE /channels/:id/artifacts/:slug
 */
export async function archiveArtifact(
  ctx: ArtifactHandlerContext,
  params: ArchiveArtifactParams
): Promise<HandlerResult<{ archived: boolean; artifact: Artifact } | { error: string }>> {
  const { channelId, slug, updatedBy } = params;

  // Verify channel exists
  const channelError = await verifyChannelExists(ctx, channelId);
  if (channelError) return channelError;

  // Archive artifact
  const artifact = await awaitResult(ctx.storage.archive(channelId, slug, updatedBy));

  // Broadcast to WebSocket clients
  await awaitResult(ctx.broadcast(channelId, buildArtifactFrame('archived', artifact)));

  // Remove from KB index (async)
  maybeRemoveFromIndex(ctx, artifact);

  return { status: 200, body: { archived: true, artifact } };
}
