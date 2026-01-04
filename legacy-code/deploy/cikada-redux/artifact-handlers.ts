/**
 * Lambda Artifact Handlers
 *
 * Artifact API handlers for AWS Lambda/API Gateway.
 * Implements: CRUD, CAS updates, versioning, glob/list queries, focus-types.
 */

import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from 'aws-lambda';
import { jwtVerify } from 'jose';
import { createDynamoDbStorage } from '@cikada/storage/dynamodb';
import type { Storage } from '@cikada/storage';
import {
  createArtifact as handleCreateArtifact,
  readArtifact as handleReadArtifact,
  listArtifacts as handleListArtifacts,
  globArtifacts as handleGlobArtifacts,
  updateArtifactCAS as handleUpdateArtifactCAS,
  archiveArtifact as handleArchiveArtifact,
  type ArtifactHandlerContext,
  type ArtifactStorage as HandlerArtifactStorage,
  type ChannelVerifier,
  type CASChange as HandlerCASChange,
  type Artifact as HandlerArtifact,
  type ArtifactType,
  type ArtifactStatus,
  type ListArtifactFilters,
  type CreateArtifactInput as HandlerCreateInput,
  type UpdateArtifactInput as HandlerUpdateInput,
} from '@cikada/handlers/artifacts';

// =============================================================================
// Constants
// =============================================================================

const COOKIE_NAME = 'cikada-session';
const DEFAULT_SECRET = 'cikada-dev-secret-change-in-production';

// Root channel name for system artifacts (focus types, etc.)
const ROOT_CHANNEL_NAME = 'root';

// =============================================================================
// Initialization
// =============================================================================

let storage: Storage | null = null;

/**
 * Initialize storage for Lambda.
 * Called once per cold start.
 */
function initStorage(): Storage {
  if (storage) return storage;

  const mainTable = process.env.MAIN_TABLE;
  if (!mainTable) {
    console.error('[Artifacts] MAIN_TABLE not configured');
    throw new Error('MAIN_TABLE environment variable not set');
  }

  const region = process.env.AWS_REGION || 'us-east-1';

  storage = createDynamoDbStorage({
    region,
    tableName: mainTable,
  });

  console.log(`[Artifacts] Storage initialized (table: ${mainTable})`);
  return storage;
}

// =============================================================================
// Auth Helpers
// =============================================================================

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('[Artifacts] WARNING: SESSION_SECRET not set, using insecure default');
    return new TextEncoder().encode(DEFAULT_SECRET);
  }
  return new TextEncoder().encode(secret);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;

  for (const cookie of cookieHeader.split(';')) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length > 0) {
      cookies[name] = rest.join('=');
    }
  }

  return cookies;
}

interface SessionPayload {
  userId: string;
  spaceId: string;
}

/**
 * Verify session from cookie and return user/space info.
 */
async function verifySession(event: APIGatewayProxyEventV2): Promise<SessionPayload> {
  const cookies = parseCookies(event.cookies?.join('; '));
  const token = cookies[COOKIE_NAME];

  if (!token) {
    throw new Error('No session token');
  }

  const { payload } = await jwtVerify(token, getSecret());

  if (!payload.sub || !payload.spaceId) {
    throw new Error('Invalid session payload');
  }

  return {
    userId: payload.sub,
    spaceId: payload.spaceId as string,
  };
}

// =============================================================================
// Response Helpers
// =============================================================================

function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

function errorResponse(statusCode: number, message: string): APIGatewayProxyResultV2 {
  return jsonResponse(statusCode, { error: message });
}

// =============================================================================
// Tree Formatting
// =============================================================================

interface ArtifactTreeNode {
  slug: string;
  path: string;
  type: string;
  title?: string;
  status: string;
  assignees: string[];
  children: ArtifactTreeNode[];
}

/**
 * Format artifact tree nodes to string representation.
 * Renders tree with indentation and type/status annotations.
 */
function formatTreeNodes(nodes: ArtifactTreeNode[], indent = 0): string {
  const lines: string[] = [];

  for (const node of nodes) {
    const prefix = '  '.repeat(indent);
    // Format: /slug :type (status) @assignee @assignee
    let line = `${prefix}/${node.slug}`;
    if (node.type !== 'doc') line += ` :${node.type}`;
    if (node.status && !['published', 'draft'].includes(node.status)) {
      line += ` (${node.status})`;
    }
    if (node.assignees?.length) {
      line += ` ${node.assignees.map(a => `@${a}`).join(' ')}`;
    }
    lines.push(line);

    if (node.children?.length) {
      lines.push(formatTreeNodes(node.children, indent + 1));
    }
  }

  return lines.join('\n');
}

// =============================================================================
// Handler Adapters
// =============================================================================

/**
 * Create artifact storage adapter for handler interface.
 * Wraps DynamoDB storage with handler-compatible interface.
 */
function createHandlerArtifactStorage(storageInstance: Storage, spaceId: string): HandlerArtifactStorage {
  return {
    create: async (input: Parameters<HandlerArtifactStorage['create']>[0]): Promise<HandlerArtifact> => {
      const artifact = await storageInstance.createArtifact(spaceId, input.channelId, {
        slug: input.slug,
        type: input.type as any, // Handler and storage use different type shapes
        title: input.title,
        tldr: input.tldr,
        content: input.content,
        parentSlug: input.parentSlug,
        status: input.status as any,
        assignees: input.assignees,
        labels: input.labels,
        props: input.props,
        createdBy: input.createdBy,
      });
      return artifact as unknown as HandlerArtifact;
    },

    read: async (channelId: string, slug: string): Promise<HandlerArtifact | undefined> => {
      const artifact = await storageInstance.getArtifact(spaceId, channelId, slug);
      return artifact ? (artifact as unknown as HandlerArtifact) : undefined;
    },

    list: async (channelId: string, filters?: Parameters<HandlerArtifactStorage['list']>[1]): Promise<HandlerArtifact[]> => {
      // Cast filters to storage format (handler uses ListArtifactFilters, storage uses similar shape)
      const artifacts = await storageInstance.listArtifacts(spaceId, channelId, filters as any);
      return artifacts as unknown as HandlerArtifact[];
    },

    glob: async (channelId: string, pattern: string): Promise<string> => {
      const tree = await storageInstance.globArtifacts(spaceId, channelId, pattern);
      // Format tree nodes to string representation
      return formatTreeNodes(tree);
    },

    update: async (channelId: string, slug: string, fields: Parameters<HandlerArtifactStorage['update']>[2], updatedBy: string): Promise<HandlerArtifact> => {
      // Cast to storage update format
      const artifact = await storageInstance.updateArtifact(spaceId, channelId, slug, fields as any, updatedBy);
      return artifact as unknown as HandlerArtifact;
    },

    updateWithCAS: async (channelId: string, slug: string, changes: HandlerCASChange[], updatedBy: string) => {
      // Map handler CAS format (old_value/new_value) to storage format (oldValue/newValue)
      const mappedChanges = changes.map((c: HandlerCASChange) => ({
        field: c.field as any,
        oldValue: c.old_value,
        newValue: c.new_value,
      }));
      const result = await storageInstance.updateArtifactWithCAS(spaceId, channelId, slug, mappedChanges, updatedBy);
      return {
        success: result.success,
        artifact: result.artifact ? (result.artifact as unknown as HandlerArtifact) : undefined,
        conflict: result.conflict,
      };
    },

    archive: async (channelId: string, slug: string, updatedBy: string): Promise<HandlerArtifact> => {
      const artifact = await storageInstance.archiveArtifact(spaceId, channelId, slug, updatedBy);
      return artifact as unknown as HandlerArtifact;
    },
  };
}

/**
 * Create channel verifier adapter for handler interface.
 */
function createChannelVerifier(storageInstance: Storage, spaceId: string): ChannelVerifier {
  return {
    verifyChannel: async (_spaceId: string, channelId: string) => {
      const channel = await storageInstance.getChannel(spaceId, channelId);
      return channel ? { id: channel.id, name: channel.name } : null;
    },
  };
}

/**
 * Build artifact handler context for a given channel.
 */
function buildArtifactContext(
  storageInstance: Storage,
  spaceId: string
): ArtifactHandlerContext {
  return {
    storage: createHandlerArtifactStorage(storageInstance, spaceId),
    channelVerifier: createChannelVerifier(storageInstance, spaceId),
    // Lambda has no WebSocket broadcast - no-op
    broadcast: async () => {},
    spaceId,
    // No KB indexer in Lambda for now
    validateProps: undefined,
  };
}

// =============================================================================
// Focus Types Handler (System Endpoint)
// =============================================================================

/**
 * GET /focus-types - List available focus types for new channel creation.
 * Returns system.focus artifacts from root channel.
 * Returns empty array if root channel doesn't exist yet.
 */
export async function listFocusTypesHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    // Check if root channel exists - if not, return empty array
    // This allows the app to function before system artifacts are seeded
    const rootChannel = await storageInstance.getChannelByName(spaceId, ROOT_CHANNEL_NAME);
    if (!rootChannel) {
      console.log('[Artifacts] Root channel not found, returning empty focus types');
      return jsonResponse(200, { focusTypes: [] });
    }

    // Query system.focus artifacts from root channel (using channel ID, not name)
    const artifacts = await storageInstance.listArtifacts(spaceId, rootChannel.id, {
      type: 'system.focus',
      status: 'published',
    });

    // Transform to focus type response format
    const focusTypes = artifacts.map((a) => ({
      slug: a.slug,
      title: a.title || a.slug,
      tldr: a.tldr,
    }));

    return jsonResponse(200, { focusTypes });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] listFocusTypes error:', error);
    return errorResponse(500, 'Failed to list focus types');
  }
}

// =============================================================================
// Artifact CRUD Handlers
// =============================================================================

/**
 * GET /channels/{id}/artifacts/tree - Glob artifacts as tree
 * Query params: pattern (default /**), format (text or json)
 */
export async function globArtifactsHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    if (!channelId) {
      return errorResponse(400, 'Channel ID required');
    }

    const ctx = buildArtifactContext(storageInstance, spaceId);
    const params = event.queryStringParameters || {};
    const pattern = params.pattern || '/**';
    const format = params.format || 'text';

    const result = await handleGlobArtifacts(ctx, { channelId, pattern });

    if (result.status !== 200) {
      return jsonResponse(result.status, result.body);
    }

    // If JSON format requested, return the raw tree structure
    if (format === 'json') {
      const tree = await storageInstance.globArtifacts(spaceId, channelId, pattern);
      return jsonResponse(200, { tree });
    }

    // Default: return text format
    return jsonResponse(200, result.body);
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] globArtifacts error:', error);
    return errorResponse(500, 'Failed to glob artifacts');
  }
}

/**
 * GET /channels/{id}/artifacts - List or glob artifacts
 * Query params: pattern (glob), type, status, assignee, parentSlug, search, limit, offset
 */
export async function listArtifactsHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    if (!channelId) {
      return errorResponse(400, 'Channel ID required');
    }

    const ctx = buildArtifactContext(storageInstance, spaceId);
    const params = event.queryStringParameters || {};

    // If pattern is provided, use glob handler
    if (params.pattern) {
      const result = await handleGlobArtifacts(ctx, { channelId, pattern: params.pattern });
      return jsonResponse(result.status, result.body);
    }

    // Otherwise, use list handler with filters
    const filters: ListArtifactFilters = {};
    if (params.type) filters.type = params.type;
    if (params.status) filters.status = params.status;
    if (params.assignee) filters.assignee = params.assignee;
    if (params.parentSlug) filters.parentSlug = params.parentSlug;
    if (params.search) filters.search = params.search;
    if (params.limit) filters.limit = parseInt(params.limit, 10);
    if (params.offset) filters.offset = parseInt(params.offset, 10);

    const result = await handleListArtifacts(ctx, { channelId, filters });
    return jsonResponse(result.status, result.body);
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] listArtifacts error:', error);
    return errorResponse(500, 'Failed to list artifacts');
  }
}

/**
 * POST /channels/{id}/artifacts - Create a new artifact
 */
export async function createArtifactHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId, userId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    if (!channelId) {
      return errorResponse(400, 'Channel ID required');
    }

    if (!event.body) {
      return errorResponse(400, 'Request body required');
    }

    const body = JSON.parse(event.body);
    const { slug, type, title, tldr, content, parentSlug, status, assignees, labels, props, sender } = body;

    const ctx = buildArtifactContext(storageInstance, spaceId);
    const result = await handleCreateArtifact(ctx, {
      channelId,
      input: {
        slug,
        type,
        title,
        tldr,
        content: content || '',
        parentSlug,
        status,
        assignees,
        labels,
        props,
        createdBy: sender || userId,
      },
    });

    if (result.status === 201) {
      console.log(`[Artifacts] Created artifact: ${slug} in ${channelId}`);
    }
    return jsonResponse(result.status, result.body);
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] createArtifact error:', error);
    return errorResponse(500, 'Failed to create artifact');
  }
}

/**
 * GET /channels/{id}/artifacts/{slug} - Get a single artifact
 */
export async function getArtifactHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    const slug = event.pathParameters?.slug;

    if (!channelId || !slug) {
      return errorResponse(400, 'Channel ID and slug required');
    }

    const ctx = buildArtifactContext(storageInstance, spaceId);
    const result = await handleReadArtifact(ctx, { channelId, slug });

    // Return artifact directly (matching local server response format)
    return jsonResponse(result.status, result.body);
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] getArtifact error:', error);
    return errorResponse(500, 'Failed to get artifact');
  }
}

/**
 * PUT /channels/{id}/artifacts/{slug} - Update artifact with CAS
 * Body: { changes: [{field, old_value, new_value}], sender }
 */
export async function updateArtifactHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId, userId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    const slug = event.pathParameters?.slug;

    if (!channelId || !slug) {
      return errorResponse(400, 'Channel ID and slug required');
    }

    if (!event.body) {
      return errorResponse(400, 'Request body required');
    }

    const body = JSON.parse(event.body);
    const { changes, sender } = body;

    if (!changes || !Array.isArray(changes)) {
      return errorResponse(400, 'Changes array required');
    }

    const ctx = buildArtifactContext(storageInstance, spaceId);
    const result = await handleUpdateArtifactCAS(ctx, {
      channelId,
      slug,
      changes: changes.map((c: { field: string; old_value: unknown; new_value: unknown }) => ({
        field: c.field,
        old_value: c.old_value,
        new_value: c.new_value,
      })),
      updatedBy: sender || userId,
    });

    if (result.status === 200) {
      console.log(`[Artifacts] Updated artifact: ${slug} in ${channelId}`);
    }
    return jsonResponse(result.status, result.body);
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] updateArtifact error:', error);
    return errorResponse(500, 'Failed to update artifact');
  }
}

/**
 * DELETE /channels/{id}/artifacts/{slug} - Archive an artifact
 */
export async function archiveArtifactHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId, userId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    const slug = event.pathParameters?.slug;

    if (!channelId || !slug) {
      return errorResponse(400, 'Channel ID and slug required');
    }

    const sender = event.queryStringParameters?.sender || userId;
    const ctx = buildArtifactContext(storageInstance, spaceId);
    const result = await handleArchiveArtifact(ctx, { channelId, slug, updatedBy: sender });

    if (result.status === 200) {
      console.log(`[Artifacts] Archived artifact: ${slug} in ${channelId}`);
    }
    return jsonResponse(result.status, result.body);
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] archiveArtifact error:', error);
    return errorResponse(500, 'Failed to archive artifact');
  }
}

// =============================================================================
// Versioning Handlers
// =============================================================================

/**
 * POST /channels/{id}/artifacts/{slug}/checkpoint - Create a version snapshot
 * Body: { version, message, sender }
 */
export async function checkpointArtifactHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId, userId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    const slug = event.pathParameters?.slug;

    if (!channelId || !slug) {
      return errorResponse(400, 'Channel ID and slug required');
    }

    if (!event.body) {
      return errorResponse(400, 'Request body required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    const artifact = await storageInstance.getArtifact(spaceId, channelId, slug);
    if (!artifact) {
      return errorResponse(404, 'Artifact not found');
    }

    const body = JSON.parse(event.body);
    const { version, message, sender } = body;

    if (!version) {
      return errorResponse(400, 'Version name required');
    }

    const artifactVersion = await storageInstance.checkpointArtifact(
      spaceId,
      channelId,
      slug,
      version,
      message,
      sender || userId
    );

    console.log(`[Artifacts] Created checkpoint: ${slug}@${version} in ${channelId}`);
    return jsonResponse(201, { version: artifactVersion });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] checkpointArtifact error:', error);
    return errorResponse(500, 'Failed to checkpoint artifact');
  }
}

/**
 * GET /channels/{id}/artifacts/{slug}/versions - List all versions
 */
export async function listArtifactVersionsHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    const slug = event.pathParameters?.slug;

    if (!channelId || !slug) {
      return errorResponse(400, 'Channel ID and slug required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    const artifact = await storageInstance.getArtifact(spaceId, channelId, slug);
    if (!artifact) {
      return errorResponse(404, 'Artifact not found');
    }

    const versions = await storageInstance.listArtifactVersions(spaceId, channelId, slug);

    return jsonResponse(200, { versions });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] listArtifactVersions error:', error);
    return errorResponse(500, 'Failed to list artifact versions');
  }
}

/**
 * GET /channels/{id}/artifacts/{slug}/versions/{versionName} - Get specific version
 */
export async function getArtifactVersionHandler(
  event: APIGatewayProxyEventV2
): Promise<APIGatewayProxyResultV2> {
  try {
    const storageInstance = initStorage();
    const { spaceId } = await verifySession(event);

    const channelId = event.pathParameters?.id;
    const slug = event.pathParameters?.slug;
    const versionName = event.pathParameters?.versionName;

    if (!channelId || !slug || !versionName) {
      return errorResponse(400, 'Channel ID, slug, and version name required');
    }

    const channel = await storageInstance.getChannel(spaceId, channelId);
    if (!channel) {
      return errorResponse(404, 'Channel not found');
    }

    const version = await storageInstance.getArtifactVersion(spaceId, channelId, slug, versionName);
    if (!version) {
      return errorResponse(404, 'Version not found');
    }

    return jsonResponse(200, { version });
  } catch (error) {
    if ((error as Error).message.includes('session')) {
      return errorResponse(401, 'Not authenticated');
    }
    console.error('[Artifacts] getArtifactVersion error:', error);
    return errorResponse(500, 'Failed to get artifact version');
  }
}
