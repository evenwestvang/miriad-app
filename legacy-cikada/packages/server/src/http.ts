/**
 * HTTP API Handler
 *
 * REST endpoints for channel and message operations.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Storage } from '@cikada/storage';
import type {
  CreateChannelRequest,
  CreateChannelResponse,
  ListChannelsResponse,
  GetChannelResponse,
  SendMessageRequest,
  SendMessageResponse,
  GetMessagesResponse,
  AddToRosterRequest,
  AddToRosterResponse,
  KBSearchOptions,
  CreateStructuredAskRequest,
  SubmitStructuredAskRequest,
  SubmitStructuredAskResponse,
  StructuredAskFormData,
  Space,
} from '@cikada/core';
import { ulid } from 'ulid';
import { type AgentManager, parseMentions } from './agent-manager.js';
import { createTymbalFrameHandler, type TymbalFrameHandler } from '@cikada/core';
import { type ArtifactStatus, type ArtifactType } from '@cikada/local-runtime';
import { createMcpHttpHandler } from './mcp-http.js';
import { validateArtifactProps, getJsonSchema, getTypesWithPropsSchemas, type OAuthConfig } from './artifact-schemas.js';
import {
  handleOAuthRequest,
  type OAuthApiDependencies,
  getStoredToken,
  saveToken,
  deleteToken,
  exchangeCodeForTokens,
} from './oauth/index.js';
import type { KBIndexer, EmbeddingService } from './embeddings.js';
import { getRootChannelId, seedSpace } from './bootstrap.js';
import {
  resolveAgentDefinition as resolveAgentDef,
  resolveMcpConfigs as resolveMcpCfgs,
  type ArtifactReader,
  type ResolvedAgentDefinition,
  type ResolvedMcpConfig,
} from '@cikada/handlers/agents';
import {
  createChannel as createChannelHandler,
  getChannel as getChannelHandler,
  listChannels as listChannelsHandler,
  archiveChannel as archiveChannelHandler,
  addAgentToChannel,
  removeAgentFromChannel,
  resolveFocusArea,
  type ChannelStorage,
  type ChannelHandlerContext,
} from '@cikada/handlers/channels';
import {
  createArtifact,
  readArtifact,
  listArtifacts,
  globArtifacts,
  updateArtifact,
  updateArtifactCAS,
  archiveArtifact,
  type ArtifactHandlerContext,
  type ArtifactStorage as HandlerArtifactStorage,
  type ChannelVerifier,
  type CASChange as HandlerCASChange,
} from '@cikada/handlers/artifacts';
import {
  authMiddleware,
  createSession,
  clearSession,
  startSanityAuthFlow,
  handleSanityAuthCallback,
  handleMockOAuthRequest,
  handleMockOAuthCallback,
  setOAuthBaseUrl,
  type AuthenticatedRequest,
} from './auth/index.js';

// =============================================================================
// Agent Resolution Wrappers
// =============================================================================

/**
 * Create an ArtifactReader adapter for unified Storage.
 * Takes storage and spaceId, returns an ArtifactReader compatible interface.
 */
function createArtifactReader(storage: Storage, spaceId: string): ArtifactReader {
  return {
    read: (channelId: string, slug: string) => storage.getArtifact(spaceId, channelId, slug),
  };
}

/**
 * Wrapper for resolveAgentDefinition that uses unified Storage.
 */
async function resolveAgentDefinition(
  storage: Storage,
  spaceId: string,
  channelId: string,
  agentSlug: string,
  rootChannelId?: string
): Promise<ResolvedAgentDefinition | undefined> {
  const reader = createArtifactReader(storage, spaceId);
  return resolveAgentDef(reader, channelId, agentSlug, { rootChannelId });
}

/**
 * Wrapper for resolveMcpConfigs that uses unified Storage.
 */
async function resolveMcpConfigs(
  storage: Storage,
  spaceId: string,
  channelId: string,
  mcpRefs: Array<{ slug: string }>,
  rootChannelId?: string
): Promise<ResolvedMcpConfig[]> {
  const reader = createArtifactReader(storage, spaceId);
  return resolveMcpCfgs(reader, channelId, mcpRefs, { rootChannelId });
}

// =============================================================================
// Storage Adapters
// =============================================================================

/**
 * Create a ChannelStorage adapter from the local Storage interface.
 * Uses type assertions since the underlying storage handles the data correctly -
 * the types are semantically compatible between @cikada/core and @cikada/handlers.
 */
function createChannelStorage(storage: Storage): ChannelStorage {
  return {
    createChannel: async (spaceId, input) => {
      const result = await storage.createChannel(spaceId, input);
      // Core Channel has extra fields (spaceId, roster) that handlers don't use
      return result as unknown as ReturnType<ChannelStorage['createChannel']> extends Promise<infer T> ? T : never;
    },
    getChannel: async (spaceId, channelId) => {
      const result = await storage.getChannel(spaceId, channelId);
      return result as unknown as ReturnType<ChannelStorage['getChannel']> extends Promise<infer T> ? T : never;
    },
    listChannels: async (spaceId) => {
      const result = await storage.listChannels(spaceId);
      return result as unknown as ReturnType<ChannelStorage['listChannels']> extends Promise<infer T> ? T : never;
    },
    updateChannelStatus: (spaceId, channelId, status) =>
      storage.updateChannelStatus(spaceId, channelId, status),
    getRoster: async (spaceId, channelId) => {
      const result = await storage.getRoster(spaceId, channelId);
      // Core uses 'user' | 'agent', handlers use 'agent' | 'human' - semantically equivalent
      return result as unknown as ReturnType<ChannelStorage['getRoster']> extends Promise<infer T> ? T : never;
    },
    addToRoster: (spaceId, channelId, entry) =>
      storage.addToRoster(spaceId, channelId, entry as any),
    removeFromRoster: (spaceId, channelId, participantId) =>
      storage.removeFromRoster(spaceId, channelId, participantId),
    saveMessage: (spaceId, msg) =>
      storage.saveMessage(spaceId, msg as any),
  };
}

// =============================================================================
// Types
// =============================================================================

export interface HttpHandlerOptions {
  storage: Storage;
  broadcast: (channelId: string, frame: string) => Promise<void>;
  agentManager?: AgentManager;
  /** Base URL for OAuth redirect URIs (e.g., "http://localhost:3000") */
  baseUrl?: string;
  /** KB indexer for semantic search (optional - semantic search disabled if not provided) */
  kbIndexer?: KBIndexer;
  /** Embedding service for generating query embeddings (required for semantic search) */
  embeddingService?: EmbeddingService;
  /** Enable authentication (default: false - uses spaceId='default') */
  authEnabled?: boolean;
  /** Enable mock authentication for local development (direct login bypass) */
  mockAuth?: boolean;
  /** Enable Sanity OAuth authentication (uses real Sanity or mock OAuth) */
  sanityAuth?: boolean;
  /** Use real Sanity OAuth (default: uses mock OAuth in dev) */
  useSanityOAuth?: boolean;
}

// =============================================================================
// HTTP Handler
// =============================================================================

export function createHttpHandler(options: HttpHandlerOptions) {
  const { storage, broadcast, agentManager, baseUrl = 'http://localhost:3000', kbIndexer, embeddingService, authEnabled = false, mockAuth, sanityAuth, useSanityOAuth } = options;

  // Configure mock OAuth if sanityAuth is enabled but not using real Sanity
  // Default to mock OAuth in dev, real Sanity in production
  const useRealSanity = useSanityOAuth || process.env.NODE_ENV === 'production';
  if (sanityAuth && !useRealSanity) {
    // Point Sanity auth at our local mock OAuth server
    setOAuthBaseUrl(`${baseUrl}/mock-oauth`);
    console.log('[Cikada] Using mock OAuth server for development');
  }

  // Create TymbalFrameHandler for unified frame processing
  // Falls back to agentManager.routeMessage if available, otherwise no-op
  const tymbalHandler = createTymbalFrameHandler({
    storage,
    broadcast,
    routeMessage: agentManager
      ? (spaceId, channelId, sender, content) => agentManager.routeMessage(spaceId, channelId, sender, content)
      : async () => {}, // No-op if no agent manager
  });

  // Create adapter for @cikada/handlers artifact operations
  // Uses the main storage (cikada.db) instead of separate artifacts.db
  const createHandlerArtifactStorage = (sId: string): HandlerArtifactStorage => ({
    create: async (input: Parameters<HandlerArtifactStorage['create']>[0]) => {
      const artifact = await storage.createArtifact(sId, input.channelId, {
        slug: input.slug,
        type: input.type as ArtifactType,
        tldr: input.tldr,
        content: input.content,
        title: input.title,
        parentSlug: input.parentSlug,
        status: (input.status ?? 'published') as ArtifactStatus,
        assignees: input.assignees,
        labels: input.labels,
        props: input.props,
        createdBy: input.createdBy,
      });
      return artifact as unknown as ReturnType<HandlerArtifactStorage['create']>;
    },
    read: async (chId: string, slug: string) => {
      const artifact = await storage.getArtifact(sId, chId, slug);
      return artifact as unknown as ReturnType<HandlerArtifactStorage['read']>;
    },
    list: async (chId: string, filters?: Parameters<HandlerArtifactStorage['list']>[1]) => {
      const summaries = await storage.listArtifacts(sId, chId, filters as any);
      // Map summaries to match handler Artifact interface (partial data is OK for list)
      return summaries.map(s => ({
        id: '',
        slug: s.slug,
        channelId: chId,
        type: s.type,
        title: s.title,
        tldr: s.tldr,
        content: '',
        status: s.status,
        assignees: s.assignees,
        createdBy: '',
        createdAt: '',
        version: 0,
      })) as any;
    },
    glob: async (chId: string, pattern: string) => {
      const nodes = await storage.globArtifacts(sId, chId, pattern);
      return formatTreeNodes(nodes);
    },
    update: async (chId: string, slug: string, fields: Parameters<HandlerArtifactStorage['update']>[2], updatedBy: string) => {
      const artifact = await storage.updateArtifact(sId, chId, slug, fields as any, updatedBy);
      return artifact as unknown as ReturnType<HandlerArtifactStorage['update']>;
    },
    updateWithCAS: async (chId: string, slug: string, changes: HandlerCASChange[], updatedBy: string) => {
      // Map handler CASChange to storage format
      const mappedChanges = changes.map((c: HandlerCASChange) => ({
        field: c.field,
        oldValue: c.oldValue,
        newValue: c.newValue,
      }));
      const result = await storage.updateArtifactWithCAS(sId, chId, slug, mappedChanges as any, updatedBy);
      return {
        success: result.success,
        artifact: result.artifact ?? undefined,
        conflict: result.conflict,
      };
    },
    archive: async (chId: string, slug: string, updatedBy: string) => {
      const artifact = await storage.archiveArtifact(sId, chId, slug, updatedBy);
      return artifact as unknown as ReturnType<HandlerArtifactStorage['archive']>;
    },
  });

  // Format tree nodes as indented string (matches MCP tool output)
  interface TreeNode {
    slug: string;
    type: string;
    status: string;
    assignees?: string[];
    children?: TreeNode[];
  }
  function formatTreeNodes(nodes: TreeNode[], indent = 0): string {
    const lines: string[] = [];
    for (const node of nodes) {
      const prefix = '  '.repeat(indent);
      const typeSuffix = node.type !== 'doc' ? ` :${node.type}` : '';
      const assigneeSuffix = node.assignees?.length ? ` @${node.assignees.join(' @')}` : '';
      const statusSuffix = node.status !== 'published' ? ` (${node.status})` : '';
      lines.push(`${prefix}/${node.slug}${typeSuffix}${statusSuffix}${assigneeSuffix}`);
      if (node.children?.length) {
        lines.push(formatTreeNodes(node.children, indent + 1));
      }
    }
    return lines.join('\n');
  }

  // Create channel verifier adapter
  const createChannelVerifier = (sId: string): ChannelVerifier => ({
    verifyChannel: async (_spaceId: string, channelId: string) => {
      const channel = await storage.getChannel(sId, channelId);
      return channel ? { id: channel.id, name: channel.name } : null;
    },
  });

  // Initialize MCP HTTP handler for reactive agents
  const handleMcpRequest = createMcpHttpHandler({
    storage,
    broadcast,
  });

  // Factory to create OAuth API dependencies with spaceId
  const createOAuthDeps = (sId: string): OAuthApiDependencies => ({
    getMcpArtifact: async (channel: string, slug: string) => {
      const artifact = await storage.getArtifact(sId, channel, slug);
      if (!artifact || artifact.type !== 'system.mcp') {
        return null;
      }
      return {
        props: artifact.props as { url?: string; auth?: OAuthConfig } | undefined,
      };
    },
    getStoredTokens: (channel: string, mcpSlug: string) => {
      const token = getStoredToken(channel, mcpSlug);
      if (!token) return null;
      return {
        accessToken: token.accessToken,
        expiresAt: token.expiresAt,
        scopes: token.scopes,
      };
    },
    storeTokens: (channel, mcpSlug, tokens, mcpUrl) => {
      saveToken(channel, mcpSlug, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
        scopes: tokens.scopes,
        tokenType: 'Bearer',
      }, mcpUrl);
    },
    clearTokens: (channel, mcpSlug) => {
      deleteToken(channel, mcpSlug);
    },
    exchangeCodeForTokens: async (tokenEndpoint, code, codeVerifier, redirectUri, clientId) => {
      const tokens = await exchangeCodeForTokens(tokenEndpoint, code, codeVerifier, redirectUri, clientId);
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresAt
          ? Math.floor((new Date(tokens.expiresAt).getTime() - Date.now()) / 1000)
          : undefined,
        scope: tokens.scopes?.join(' '),
      };
    },
    baseUrl,
  });

  async function handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    // CORS headers are set by auth middleware (before this handler)
    // Do NOT set them here - the middleware handles origin reflection for credentials

    const url = new URL(req.url ?? '/', `http://localhost`);
    let pathParts = url.pathname.split('/').filter(Boolean);

    // Normalize /channel/ to /channels/ for compatibility
    if (pathParts[0] === 'channel') {
      pathParts[0] = 'channels';
    }

    // Extract spaceId from authenticated request (set by auth middleware)
    const spaceId = (req as AuthenticatedRequest).spaceId;

    try {
      // Health check
      if (req.method === 'GET' && url.pathname === '/health') {
        jsonResponse(res, 200, { status: 'ok' });
        return;
      }

      // =======================================================================
      // MCP HTTP Transport Routes (for reactive agents)
      // =======================================================================

      if (pathParts[0] === 'mcp') {
        const handled = await handleMcpRequest(req, res, pathParts, spaceId);
        if (handled) return;
      }

      // =======================================================================
      // Mock Auth Routes (only when --mock-auth flag is enabled)
      // =======================================================================

      if (mockAuth && pathParts[0] === 'mock-auth') {
        // GET /mock-auth/login - Show login page with existing accounts
        if (req.method === 'GET' && pathParts[1] === 'login') {
          // Query all spaces from storage
          const spaces = await listAllSpaces(storage);

          // Generate HTML login page
          const html = generateMockLoginPage(spaces);

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }

        // GET /mock-auth/callback - Handle login (create session)
        if (req.method === 'GET' && pathParts[1] === 'callback') {
          const userId = url.searchParams.get('user');
          const newUser = url.searchParams.get('new');

          if (!userId && !newUser) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Error</h1><p>Missing user parameter</p></body></html>');
            return;
          }

          let targetSpaceId: string;

          if (newUser) {
            // Create new space for new user
            const space = await storage.createSpace({ ownerId: newUser, name: newUser });
            targetSpaceId = space.id;

            // Seed the new space with default content
            await seedSpace(targetSpaceId, { storage });

            console.log(`[MockAuth] Created new space for user: ${newUser} (spaceId: ${targetSpaceId})`);
          } else {
            // Find existing space by ownerId
            const space = await storage.getSpaceByOwnerId(userId!);
            if (!space) {
              res.writeHead(404, { 'Content-Type': 'text/html' });
              res.end(`<html><body><h1>Error</h1><p>Space not found for user: ${userId}</p></body></html>`);
              return;
            }
            targetSpaceId = space.id;

            // Seed the space with default content (idempotent - skips if already seeded)
            await seedSpace(targetSpaceId, { storage });

            console.log(`[MockAuth] Logging in as user: ${userId} (spaceId: ${targetSpaceId})`);
          }

          // Create JWT session with userId and spaceId
          await createSession(req, res, {
            userId: newUser || userId!,
            spaceId: targetSpaceId,
          });

          // Redirect to home (preserve Set-Cookie header)
          const mockAuthCookies = res.getHeader('Set-Cookie');
          res.writeHead(302, {
            'Location': '/',
            ...(mockAuthCookies ? { 'Set-Cookie': mockAuthCookies } : {}),
          });
          res.end();
          return;
        }

        // POST /mock-auth/logout - Clear session
        if (req.method === 'POST' && pathParts[1] === 'logout') {
          clearSession(req, res);
          res.writeHead(302, { 'Location': '/mock-auth/login' });
          res.end();
          return;
        }

        // 404 for unknown mock-auth routes
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Not Found</h1></body></html>');
        return;
      }

      // =======================================================================
      // Mock OAuth Server Routes (for dev/testing)
      // =======================================================================

      if (pathParts[0] === 'mock-oauth') {
        // Handle mock OAuth callback (user selected account)
        if (req.method === 'GET' && pathParts[1] === 'callback') {
          await handleMockOAuthCallback(req, res, url, storage);
          return;
        }

        // Handle other mock OAuth requests (authorize, token, register)
        const handled = await handleMockOAuthRequest(req, res, pathParts, url, {
          storage,
          baseUrl,
        });
        if (handled) return;

        // 404 for unknown mock-oauth routes
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Not Found</h1></body></html>');
        return;
      }

      // =======================================================================
      // Sanity OAuth Routes (only when --auth flag is enabled)
      // =======================================================================

      if (sanityAuth && pathParts[0] === 'auth' && pathParts[1] === 'sanity') {
        // GET /auth/sanity/login - Start Sanity OAuth flow
        if (req.method === 'GET' && pathParts[2] === 'login') {
          try {
            // Capture where the user came from to redirect back after auth
            // Priority: ?return_url query param > Referer header > undefined
            const returnUrlParam = url.searchParams.get('return_url');
            const referer = req.headers.referer;
            const returnUrl = returnUrlParam || referer || undefined;

            const { authorizationUrl } = await startSanityAuthFlow(baseUrl, returnUrl);
            res.writeHead(302, { Location: authorizationUrl });
            res.end();
            return;
          } catch (error) {
            console.error('[SanityAuth] Failed to start OAuth flow:', error);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Error</h1><p>Failed to start authentication</p></body></html>');
            return;
          }
        }

        // GET /auth/sanity/callback - Handle OAuth callback
        if (req.method === 'GET' && pathParts[2] === 'callback') {
          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');
          const errorDescription = url.searchParams.get('error_description');

          // Check for error from OAuth provider
          if (error) {
            console.error(`[SanityAuth] OAuth error: ${error} - ${errorDescription}`);
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end(`<html><body><h1>Authentication Failed</h1><p>${errorDescription || error}</p></body></html>`);
            return;
          }

          if (!code || !state) {
            res.writeHead(400, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Error</h1><p>Missing code or state parameter</p></body></html>');
            return;
          }

          try {
            const { userInfo, returnUrl } = await handleSanityAuthCallback(code, state);

            // Get or create space for this Sanity user
            const space = await storage.getOrCreateSpace(userInfo.userId, userInfo.name);

            // Seed the space with default content (idempotent - skips if already seeded)
            await seedSpace(space.id, { storage });

            // Create JWT session with userId and spaceId
            await createSession(req, res, {
              userId: userInfo.userId,
              spaceId: space.id,
            });

            console.log(`[SanityAuth] User authenticated: ${userInfo.userId} (spaceId: ${space.id})`);

            // Redirect to where the user came from, or fallback to frontend URL
            const defaultFrontendUrl = process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? '/' : 'http://localhost:5173/');
            const redirectTo = returnUrl || defaultFrontendUrl;
            // Preserve Set-Cookie header (createSession sets it via setHeader, writeHead would overwrite)
            const sanityAuthCookies = res.getHeader('Set-Cookie');
            res.writeHead(302, {
              Location: redirectTo,
              ...(sanityAuthCookies ? { 'Set-Cookie': sanityAuthCookies } : {}),
            });
            res.end();
            return;
          } catch (error) {
            console.error('[SanityAuth] Callback error:', error);
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end('<html><body><h1>Authentication Failed</h1><p>Failed to complete authentication</p></body></html>');
            return;
          }
        }

        // POST /auth/sanity/logout - Clear session
        if (req.method === 'POST' && pathParts[2] === 'logout') {
          clearSession(req, res);
          res.writeHead(302, { Location: '/auth/sanity/login' });
          res.end();
          return;
        }

        // 404 for unknown auth routes
        res.writeHead(404, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Not Found</h1></body></html>');
        return;
      }

      // GET /threads - List threads (compatibility endpoint for frontend)
      // Maps channels to thread format expected by the frontend
      if (req.method === 'GET' && pathParts[0] === 'threads' && !pathParts[1]) {
        const channels = await storage.listChannels(spaceId);
        const threads = channels.map((ch) => ({
          threadId: ch.id,
          agentName: ch.name,
          status: ch.status === 'active' ? 'idle' : ch.status,
          createdAt: ch.createdAt,
        }));
        jsonResponse(res, 200, { threads });
        return;
      }

      // POST /channels - Create channel
      if (req.method === 'POST' && pathParts[0] === 'channels' && !pathParts[1]) {
        const body = await readBody<CreateChannelRequest & {
          focusSlug?: string;
          tagline?: string;
          mission?: string;
        }>(req);

        // Create context and call extracted handler
        const channelStorage = createChannelStorage(storage);
        const ctx: ChannelHandlerContext = { storage: channelStorage, spaceId, broadcast };
        const rootChannelId = await getRootChannelId(storage, spaceId);

        const result = await createChannelHandler(ctx, {
          name: body.name,
          description: body.description,
          focusSlug: body.focusSlug,
          tagline: body.tagline,
          mission: body.mission,
        }, {
          artifactReader: createArtifactReader(storage, spaceId),
          rootChannelId: rootChannelId ?? undefined,
        });

        // Handler returns simplified Channel type, response expects full core type
        const response: CreateChannelResponse = { channel: result.channel as any };
        jsonResponse(res, 201, response);
        return;
      }

      // GET /channels - List channels
      if (req.method === 'GET' && pathParts[0] === 'channels' && !pathParts[1]) {
        const channels = await storage.listChannels(spaceId);
        const response: ListChannelsResponse = { channels };
        jsonResponse(res, 200, response);
        return;
      }

      // GET /channels/:id - Get channel
      if (req.method === 'GET' && pathParts[0] === 'channels' && pathParts[1] && !pathParts[2]) {
        const channelId = pathParts[1];
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }
        const roster = await storage.getRoster(spaceId, channelId);
        const response: GetChannelResponse = { channel, roster };
        jsonResponse(res, 200, response);
        return;
      }

      // DELETE /channels/:id - Archive channel
      if (req.method === 'DELETE' && pathParts[0] === 'channels' && pathParts[1] && !pathParts[2]) {
        const channelId = pathParts[1];
        await storage.updateChannelStatus(spaceId, channelId, 'archived');
        jsonResponse(res, 200, { success: true });
        return;
      }

      // POST /channels/:id/roster - Add to roster
      if (req.method === 'POST' && pathParts[0] === 'channels' && pathParts[2] === 'roster') {
        const channelId = pathParts[1];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const body = await readBody<AddToRosterRequest>(req);
        const entry = {
          id: body.participantId,
          name: body.name,
          type: body.participantType,
          status: 'online' as const,
          joinedAt: new Date().toISOString(),
          agentConfig: body.agentConfig,
          // Capture system prompt at spawn time for agents
          systemPrompt: body.participantType === 'agent' ? body.agentConfig?.system : undefined,
        };
        await storage.addToRoster(spaceId, channelId, entry);
        const response: AddToRosterResponse = { entry };
        jsonResponse(res, 201, response);
        return;
      }

      // DELETE /channels/:id/roster/:participantId - Remove from roster
      if (req.method === 'DELETE' && pathParts[0] === 'channels' && pathParts[2] === 'roster' && pathParts[3]) {
        const channelId = pathParts[1];
        const participantId = pathParts[3];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        await storage.removeFromRoster(spaceId, channelId, participantId);
        jsonResponse(res, 200, { success: true });
        return;
      }

      // =========================================================================
      // Agent Management Routes
      // =========================================================================

      // GET /agents - List available agent types
      if (req.method === 'GET' && pathParts[0] === 'agents' && !pathParts[1]) {
        // Available agent types for the picker dropdown
        const agentTypes = [
          { id: 'claude-code', name: 'Claude Code', description: 'Coding assistant with file access' },
          { id: 'claude-sonnet', name: 'Claude Sonnet', description: 'General purpose assistant' },
          { id: 'claude-opus', name: 'Claude Opus', description: 'Advanced reasoning assistant' },
        ];
        jsonResponse(res, 200, { agentTypes });
        return;
      }

      // GET /focus-types or /api/focus-types - List available focus areas
      const isFocusTypes = (pathParts[0] === 'focus-types' && !pathParts[1]) ||
                           (pathParts[0] === 'api' && pathParts[1] === 'focus-types' && !pathParts[2]);
      if (req.method === 'GET' && isFocusTypes) {
        // Query system.focus artifacts from the space's root channel
        const rootChannelId = await getRootChannelId(storage, spaceId);
        if (!rootChannelId) {
          jsonResponse(res, 200, { focusTypes: [] });
          return;
        }

        const focusArtifacts = await storage.listArtifacts(spaceId, rootChannelId, {
          type: 'system.focus',
          status: 'published',
        });

        const focusTypes = focusArtifacts.map((artifact) => ({
          slug: artifact.slug,
          title: artifact.title || artifact.slug,
          tldr: artifact.tldr,
        }));

        jsonResponse(res, 200, { focusTypes });
        return;
      }

      // POST /channels/:id/agents - Add agent to channel
      if (req.method === 'POST' && pathParts[0] === 'channels' && pathParts[2] === 'agents' && !pathParts[3]) {
        const channelId = pathParts[1];

        const body = await readBody<{ agentType: string; callsign: string }>(req);
        if (!body.agentType || !body.callsign) {
          jsonResponse(res, 400, { error: 'Missing required fields: agentType, callsign' });
          return;
        }

        try {
          const channelStorage = createChannelStorage(storage);
          const ctx: ChannelHandlerContext = { storage: channelStorage, spaceId, broadcast };
          const rootChannelId = await getRootChannelId(storage, spaceId);

          const result = await addAgentToChannel(ctx, channelId, {
            agentType: body.agentType,
            callsign: body.callsign,
          }, {
            artifactReader: createArtifactReader(storage, spaceId),
            rootChannelId: rootChannelId ?? undefined,
          });

          jsonResponse(res, 201, {
            success: true,
            agent: {
              id: result.entry.id,
              callsign: body.callsign,
              agentType: body.agentType,
              status: 'idle',
            },
          });
        } catch (err: any) {
          if (err.message?.includes('not found')) {
            jsonResponse(res, 404, { error: err.message });
          } else if (err.message?.includes('already exists')) {
            jsonResponse(res, 400, { error: err.message });
          } else {
            throw err;
          }
        }
        return;
      }

      // DELETE /channels/:id/agents/:callsign - Dismiss agent from channel
      if (req.method === 'DELETE' && pathParts[0] === 'channels' && pathParts[2] === 'agents' && pathParts[3]) {
        const channelId = pathParts[1];
        const callsign = decodeURIComponent(pathParts[3]);

        try {
          const channelStorage = createChannelStorage(storage);
          const ctx: ChannelHandlerContext = { storage: channelStorage, spaceId, broadcast };

          await removeAgentFromChannel(ctx, channelId, callsign);
          jsonResponse(res, 200, { success: true });
        } catch (err: any) {
          if (err.message?.includes('not found')) {
            jsonResponse(res, 404, { error: err.message });
          } else if (err.message?.includes('Cannot dismiss')) {
            jsonResponse(res, 400, { error: err.message });
          } else {
            throw err;
          }
        }
        return;
      }

      // POST /channels/:id/messages - Send message
      if (req.method === 'POST' && pathParts[0] === 'channels' && pathParts[2] === 'messages') {
        const channelId = pathParts[1];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const body = await readBody<SendMessageRequest>(req);

        const messageId = ulid();
        const timestamp = new Date().toISOString();

        // Parse @mentions to determine addressed agents
        const { mentions, isChannelBroadcast } = parseMentions(body.content);
        let addressedAgents: string[] = isChannelBroadcast ? ['channel'] : mentions;

        // If no explicit @mentions from a user (human), determine target agents via routing logic
        // This ensures the message is included in those agents' history
        if (addressedAgents.length === 0 && body.senderType === 'user') {
          // Check roster to find target agents (matches routeMessage logic)
          const roster = await storage.getRoster(spaceId, channelId);
          const agentRosterEntries = roster.filter((r) => r.type === 'agent');

          if (agentRosterEntries.length > 0) {
            // Route to channel leader if set, otherwise first agent
            if (channel.leader) {
              const leaderEntry = agentRosterEntries.find(
                (r) => r.id.toLowerCase() === channel.leader!.toLowerCase()
              );
              if (leaderEntry) {
                addressedAgents = [leaderEntry.id.toLowerCase()];
              }
            }
            // Fallback: first agent in roster
            if (addressedAgents.length === 0) {
              addressedAgents = [agentRosterEntries[0].id.toLowerCase()];
            }
          }
        }

        await storage.saveMessage(spaceId, {
          id: messageId,
          channelId,
          sender: body.sender,
          senderType: body.senderType,
          type: 'user',
          content: body.content,
          timestamp,
          isComplete: true,
          addressedAgents: addressedAgents.length > 0 ? addressedAgents : undefined,
        });

        // Broadcast to WebSocket clients
        const frame = JSON.stringify({
          i: messageId,
          t: timestamp,
          v: {
            type: 'user',
            content: body.content,
            sender: body.sender,
            senderType: body.senderType,
          },
        });
        await broadcast(channelId, frame);

        // Route to agents based on @mentions (async, don't await)
        if (agentManager && typeof body.content === 'string') {
          agentManager.routeMessage(spaceId, channelId, body.sender, body.content).catch((err) => {
            console.error('[HTTP] Agent routing error:', err);
          });
        }

        const response: SendMessageResponse = { messageId, timestamp };
        jsonResponse(res, 201, response);
        return;
      }

      // GET /channels/:id/messages - Get messages
      if (req.method === 'GET' && pathParts[0] === 'channels' && pathParts[2] === 'messages') {
        const channelId = pathParts[1];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const since = url.searchParams.get('since') ?? undefined;
        const before = url.searchParams.get('before') ?? undefined;
        const limit = url.searchParams.get('limit');

        const messages = await storage.getMessages(spaceId, channelId, {
          since,
          before,
          limit: limit ? parseInt(limit, 10) : undefined,
        });

        // Fetch attachments for each message and include them inline
        const messagesWithAttachments = await Promise.all(
          messages.map(async (message) => {
            const attachments = await storage.getMessageAttachments(spaceId, message.id);
            return { ...message, attachments };
          })
        );

        const cursor = messagesWithAttachments.length > 0 ? messagesWithAttachments[messagesWithAttachments.length - 1].id : undefined;
        const response: GetMessagesResponse = { messages: messagesWithAttachments, cursor };
        jsonResponse(res, 200, response);
        return;
      }

      // =========================================================================
      // Structured Ask Routes
      // =========================================================================

      // POST /channels/:id/structured-asks - Create a structured ask
      if (req.method === 'POST' && pathParts[0] === 'channels' && pathParts[2] === 'structured-asks' && !pathParts[3]) {
        const channelId = pathParts[1];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const body = await readBody<CreateStructuredAskRequest>(req);

        if (!body.sender || !body.prompt || !body.fields) {
          jsonResponse(res, 400, { error: 'Missing required fields: sender, prompt, fields' });
          return;
        }

        const formData: StructuredAskFormData = {
          prompt: body.prompt,
          fields: body.fields,
          submitLabel: body.submitLabel,
          to: body.to ?? [],
        };

        const message = await storage.saveStructuredAsk(spaceId, {
          channelId,
          sender: body.sender,
          prompt: body.prompt,
          formData,
        });

        // Broadcast to WebSocket clients
        const frame = JSON.stringify({
          i: message.id,
          t: message.timestamp,
          v: {
            type: 'structured_ask',
            content: body.prompt,
            sender: body.sender,
            formData,
            formState: 'pending',
          },
        });
        await broadcast(channelId, frame);

        jsonResponse(res, 201, { message });
        return;
      }

      // POST /channels/:id/structured-asks/:messageId/submit - Submit response to a structured ask
      if (req.method === 'POST' && pathParts[0] === 'channels' && pathParts[2] === 'structured-asks' && pathParts[4] === 'submit') {
        const channelId = pathParts[1];
        const messageId = pathParts[3];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const body = await readBody<SubmitStructuredAskRequest>(req);

        if (!body.response || !body.respondedBy) {
          jsonResponse(res, 400, { error: 'Missing required fields: response, respondedBy' });
          return;
        }

        const updatedMessage = await storage.submitStructuredAskResponse(spaceId, {
          messageId,
          response: body.response,
          respondedBy: body.respondedBy,
        });

        if (!updatedMessage) {
          jsonResponse(res, 409, { error: 'Structured ask not found or already submitted' });
          return;
        }

        // Broadcast the updated message to WebSocket clients
        const content = updatedMessage.content as {
          prompt: string;
          formData: StructuredAskFormData;
          formState: string;
          response: Record<string, unknown>;
          respondedBy: string;
          respondedAt: string;
        };

        const updateFrame = JSON.stringify({
          i: updatedMessage.id,
          t: content.respondedAt,
          v: {
            type: 'structured_ask',
            content: content.prompt,
            sender: updatedMessage.sender,
            formData: content.formData,
            formState: 'submitted',
            response: content.response,
            respondedBy: content.respondedBy,
            respondedAt: content.respondedAt,
          },
        });
        await broadcast(channelId, updateFrame);

        // Post follow-up message summarizing the response
        const followUpContent = `@${updatedMessage.sender} Re: "${content.prompt}"\n\nResponse from ${body.respondedBy}`;
        const followUpId = ulid();
        const followUpTimestamp = new Date().toISOString();

        // Parse @mentions from follow-up content
        const { mentions: followUpMentions, isChannelBroadcast: followUpBroadcast } = parseMentions(followUpContent);
        const followUpAddressedAgents = followUpBroadcast ? ['channel'] : followUpMentions;

        await storage.saveMessage(spaceId, {
          id: followUpId,
          channelId,
          sender: body.respondedBy,
          senderType: 'user',
          type: 'user',
          content: followUpContent,
          timestamp: followUpTimestamp,
          isComplete: true,
          addressedAgents: followUpAddressedAgents.length > 0 ? followUpAddressedAgents : undefined,
        });

        // Broadcast follow-up message
        const followUpFrame = JSON.stringify({
          i: followUpId,
          t: followUpTimestamp,
          v: {
            type: 'user',
            content: followUpContent,
            sender: body.respondedBy,
            senderType: 'user',
          },
        });
        await broadcast(channelId, followUpFrame);

        // Route follow-up to agents (triggers the original sender)
        if (agentManager) {
          agentManager.routeMessage(spaceId, channelId, body.respondedBy, followUpContent).catch((err) => {
            console.error('[HTTP] Agent routing error for structured ask response:', err);
          });
        }

        const response: SubmitStructuredAskResponse = {
          message: updatedMessage,
          success: true,
        };
        jsonResponse(res, 200, response);
        return;
      }

      // POST /channels/:id/tymbal - Receive Tymbal frames from Docker containers
      // This endpoint is called by Docker containers to broadcast their output
      // Note: This endpoint uses spaceId from request context (auth middleware)
      if (req.method === 'POST' && pathParts[0] === 'channels' && pathParts[2] === 'tymbal') {
        const channelId = pathParts[1];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const body = await readRawBody(req);

        // Use unified TymbalFrameHandler for all frame processing
        await tymbalHandler.handleFrame(spaceId, channelId, body);

        jsonResponse(res, 200, { success: true });
        return;
      }

      // POST /thread/:threadId/tymbal - Endpoint for Docker containers
      // threadId format is "spaceId:channelId:agentName" - extract spaceId and channelId for routing
      if (req.method === 'POST' && pathParts[0] === 'thread' && pathParts[2] === 'tymbal') {
        const threadId = pathParts[1];
        console.log(`[Tymbal] Docker callback received for thread: ${threadId}`);

        // Parse threadId: spaceId:channelId:agentName (new format) or channelId:agentName (legacy)
        const parts = threadId.split(':');
        let threadSpaceId: string;
        let channelId: string;
        if (parts.length >= 3) {
          // New format: spaceId:channelId:agentName
          threadSpaceId = parts[0];
          channelId = parts[1];
        } else if (parts.length === 2) {
          // Legacy format: channelId:agentName - use default space
          threadSpaceId = 'default';
          channelId = parts[0];
        } else {
          // Fallback
          threadSpaceId = 'default';
          channelId = threadId;
        }
        const body = await readRawBody(req);
        console.log(`[Tymbal] Parsed: spaceId=${threadSpaceId}, channelId=${channelId}, body length=${body.length}`);
        console.log(`[Tymbal] Body preview: ${body.substring(0, 200)}...`);

        // Use unified TymbalFrameHandler for all frame processing
        await tymbalHandler.handleFrame(threadSpaceId, channelId, body);

        jsonResponse(res, 200, { success: true });
        return;
      }

      // =========================================================================
      // Artifact / Board Routes (using @cikada/handlers)
      // =========================================================================

      // Build artifact handler context (shared across artifact routes)
      // Uses spaceId from auth context for multi-tenancy
      const buildArtifactContext = (_channelId: string): ArtifactHandlerContext => ({
        storage: createHandlerArtifactStorage(spaceId),
        channelVerifier: createChannelVerifier(spaceId),
        broadcast: async (chId: string, frame: string) => { await broadcast(chId, frame); },
        spaceId,
        validateProps: (type: string, props: Record<string, unknown>) => validateArtifactProps(type, props) ?? null,
        kbIndexer: kbIndexer ? {
          indexArtifact: (sId: string, artifact: any) => maybeIndexArtifact(sId, artifact, kbIndexer, storage),
          removeFromIndex: (sId: string, artifact: any) => maybeRemoveFromIndex(sId, artifact, kbIndexer, storage),
        } : undefined,
      });

      // POST /channels/:id/artifacts - Create artifact
      if (
        req.method === 'POST' &&
        pathParts[0] === 'channels' &&
        pathParts[2] === 'artifacts' &&
        !pathParts[3]
      ) {
        const channelId = pathParts[1];
        const data = await readBody<{
          slug: string;
          type: string;
          tldr: string;
          content: string;
          title?: string;
          parentSlug?: string;
          status?: string;
          assignees?: string[];
          labels?: string[];
          props?: Record<string, unknown>;
          createdBy: string;
        }>(req);

        const result = await createArtifact(buildArtifactContext(channelId), {
          channelId,
          input: {
            slug: data.slug,
            type: data.type as any,
            tldr: data.tldr,
            content: data.content,
            title: data.title,
            parentSlug: data.parentSlug,
            status: data.status as any,
            assignees: data.assignees,
            labels: data.labels,
            props: data.props,
            createdBy: data.createdBy,
          },
        });

        jsonResponse(res, result.status, result.body);
        return;
      }

      // GET /channels/:id/artifacts/tree - Glob tree view
      // Supports ?format=json for structured ArtifactTreeNode[] (frontend)
      // Default returns text tree format (MCP agents)
      if (
        req.method === 'GET' &&
        pathParts[0] === 'channels' &&
        pathParts[2] === 'artifacts' &&
        pathParts[3] === 'tree'
      ) {
        const channelId = pathParts[1];
        const pattern = url.searchParams.get('pattern') ?? '/**';
        const format = url.searchParams.get('format');

        // Verify channel exists
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: `Channel not found: ${channelId}` });
          return;
        }

        // Get tree nodes from storage
        const nodes = await storage.globArtifacts(spaceId, channelId, pattern);

        if (format === 'json') {
          // Return structured JSON for frontend
          jsonResponse(res, 200, { tree: nodes });
        } else {
          // Return text format for MCP agents (via handler)
          const result = await globArtifacts(buildArtifactContext(channelId), {
            channelId,
            pattern,
          });
          jsonResponse(res, result.status, result.body);
        }
        return;
      }

      // GET /channels/:id/artifacts/:slug - Read single artifact
      if (
        req.method === 'GET' &&
        pathParts[0] === 'channels' &&
        pathParts[2] === 'artifacts' &&
        pathParts[3]
      ) {
        const channelId = pathParts[1];
        const slug = pathParts[3];

        const result = await readArtifact(buildArtifactContext(channelId), {
          channelId,
          slug,
        });

        jsonResponse(res, result.status, result.body);
        return;
      }

      // GET /channels/:id/artifacts - List artifacts with filters (or glob with pattern)
      if (
        req.method === 'GET' &&
        pathParts[0] === 'channels' &&
        pathParts[2] === 'artifacts' &&
        !pathParts[3]
      ) {
        const channelId = pathParts[1];

        // If pattern is provided, route to glob handler (matches Lambda behavior)
        const patternParam = url.searchParams.get('pattern');
        if (patternParam) {
          const result = await globArtifacts(buildArtifactContext(channelId), {
            channelId,
            pattern: patternParam,
          });
          jsonResponse(res, result.status, result.body);
          return;
        }

        // Otherwise, use list handler with filters
        const filters: Record<string, any> = {};
        const typeParam = url.searchParams.get('type');
        const statusParam = url.searchParams.get('status');
        const assigneeParam = url.searchParams.get('assignee');
        const parentSlugParam = url.searchParams.get('parentSlug');
        const searchParam = url.searchParams.get('search');
        const limitParam = url.searchParams.get('limit');
        const offsetParam = url.searchParams.get('offset');

        if (typeParam) filters.type = typeParam;
        if (statusParam) filters.status = statusParam;
        if (assigneeParam) filters.assignee = assigneeParam;
        if (parentSlugParam) filters.parentSlug = parentSlugParam;
        if (searchParam) filters.search = searchParam;
        if (limitParam) filters.limit = parseInt(limitParam, 10);
        if (offsetParam) filters.offset = parseInt(offsetParam, 10);

        const result = await listArtifacts(buildArtifactContext(channelId), {
          channelId,
          filters,
        });

        jsonResponse(res, result.status, result.body);
        return;
      }

      // PATCH /channels/:id/artifacts/:slug - Update (simple or CAS)
      if (
        req.method === 'PATCH' &&
        pathParts[0] === 'channels' &&
        pathParts[2] === 'artifacts' &&
        pathParts[3]
      ) {
        const channelId = pathParts[1];
        const slug = pathParts[3];

        const data = await readBody<{
          updatedBy: string;
          changes?: Array<{ field: string; oldValue?: unknown; newValue?: unknown }>;
          content?: string;
          tldr?: string;
          title?: string;
          status?: string;
          parentSlug?: string | null;
          assignees?: string[];
          labels?: string[];
        }>(req);

        const updatedBy = data.updatedBy || 'api';

        // CAS mode: changes array provided
        if (data.changes && Array.isArray(data.changes)) {
          const result = await updateArtifactCAS(buildArtifactContext(channelId), {
            channelId,
            slug,
            changes: data.changes as HandlerCASChange[],
            updatedBy,
          });

          jsonResponse(res, result.status, result.body);
          return;
        }

        // Simple update mode
        const { updatedBy: _updatedBy, changes: _changes, parentSlug, ...updateFields } = data;
        const result = await updateArtifact(buildArtifactContext(channelId), {
          channelId,
          slug,
          input: {
            ...updateFields,
            status: updateFields.status as any,
            parentSlug: parentSlug === null ? undefined : parentSlug,
          },
          updatedBy,
        });

        jsonResponse(res, result.status, result.body);
        return;
      }

      // DELETE /channels/:id/artifacts/:slug - Archive (soft delete)
      if (
        req.method === 'DELETE' &&
        pathParts[0] === 'channels' &&
        pathParts[2] === 'artifacts' &&
        pathParts[3]
      ) {
        const channelId = pathParts[1];
        const slug = pathParts[3];
        const updatedBy = url.searchParams.get('updatedBy') ?? 'system';

        const result = await archiveArtifact(buildArtifactContext(channelId), {
          channelId,
          slug,
          updatedBy,
        });

        jsonResponse(res, result.status, result.body);
        return;
      }

      // GET /artifacts/schema/:type - Get JSON schema for artifact props
      if (
        req.method === 'GET' &&
        pathParts[0] === 'artifacts' &&
        pathParts[1] === 'schema' &&
        pathParts[2]
      ) {
        const type = pathParts[2];
        const schema = getJsonSchema(type);

        if (!schema) {
          const availableTypes = getTypesWithPropsSchemas();
          jsonResponse(res, 404, {
            error: `No props schema defined for type: ${type}`,
            availableTypes,
          });
          return;
        }

        jsonResponse(res, 200, { type, propsSchema: schema });
        return;
      }

      // GET /artifacts/schema - List all types with schemas
      if (
        req.method === 'GET' &&
        pathParts[0] === 'artifacts' &&
        pathParts[1] === 'schema' &&
        !pathParts[2]
      ) {
        const types = getTypesWithPropsSchemas();
        jsonResponse(res, 200, { types });
        return;
      }

      // =========================================================================
      // Asset Upload Routes
      // =========================================================================

      const ASSET_MAX_SIZE = 10 * 1024 * 1024; // 10MB
      const ASSET_ALLOWED_TYPES: Record<string, string> = {
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/gif': '.gif',
        'image/svg+xml': '.svg',
        'image/webp': '.webp',
        'application/pdf': '.pdf',
      };
      const ASSETS_DIR = './assets';

      // POST /channels/:id/assets - Upload binary asset
      if (req.method === 'POST' && pathParts[0] === 'channels' && pathParts[2] === 'assets' && !pathParts[3]) {
        const channelId = pathParts[1];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const contentType = req.headers['content-type'] || '';

        // Check for multipart/form-data
        if (!contentType.includes('multipart/form-data')) {
          jsonResponse(res, 400, { error: 'Content-Type must be multipart/form-data' });
          return;
        }

        // Parse multipart form data
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
          jsonResponse(res, 400, { error: 'Missing boundary in Content-Type' });
          return;
        }

        // Read raw body
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += chunk.length;
          if (totalSize > ASSET_MAX_SIZE) {
            jsonResponse(res, 413, { error: `File too large. Maximum size is ${ASSET_MAX_SIZE / 1024 / 1024}MB` });
            return;
          }
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks);

        // Parse multipart parts
        const parts = parseMultipart(rawBody, boundary);

        const filePart = parts.find(p => p.name === 'file');
        const slugPart = parts.find(p => p.name === 'slug');
        const tldrPart = parts.find(p => p.name === 'tldr');

        if (!filePart || !filePart.data || filePart.data.length === 0) {
          jsonResponse(res, 400, { error: 'Missing file in request' });
          return;
        }

        // Validate MIME type
        const mimeType = filePart.contentType || 'application/octet-stream';
        if (!ASSET_ALLOWED_TYPES[mimeType]) {
          jsonResponse(res, 400, {
            error: `File type not allowed: ${mimeType}. Allowed types: ${Object.keys(ASSET_ALLOWED_TYPES).join(', ')}`
          });
          return;
        }

        // Generate slug from filename if not provided
        let slug = slugPart?.data?.toString().trim();
        if (!slug && filePart.filename) {
          // Sanitize filename to slug: lowercase, replace spaces/special chars with dashes
          slug = filePart.filename
            .toLowerCase()
            .replace(/[^a-z0-9.-]/g, '-')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        }
        if (!slug) {
          slug = `asset-${ulid()}${ASSET_ALLOWED_TYPES[mimeType]}`;
        }

        // Ensure slug has correct extension
        const ext = ASSET_ALLOWED_TYPES[mimeType];
        if (!slug.endsWith(ext)) {
          slug = slug.replace(/\.[^.]+$/, '') + ext;
        }

        const tldr = tldrPart?.data?.toString().trim() || '';

        // Create assets directory for channel
        const channelAssetsDir = path.join(ASSETS_DIR, channelId);
        if (!fs.existsSync(channelAssetsDir)) {
          fs.mkdirSync(channelAssetsDir, { recursive: true });
        }

        // Write file
        const filePath = path.join(channelAssetsDir, slug);
        fs.writeFileSync(filePath, filePart.data);

        // Create artifact entry for the asset so it appears in the board tree
        const artifact = await storage.createArtifact(spaceId, channelId, {
          slug,
          type: 'asset' as any,
          tldr: tldr || `Uploaded file: ${filePart.filename || slug}`,
          content: JSON.stringify({
            url: `/channels/${channelId}/assets/${slug}`,
            mimeType,
            size: filePart.data.length,
            filename: filePart.filename,
          }),
          status: 'published',
          createdBy: 'system',
        });

        // Broadcast artifact creation to WebSocket clients
        const artifactFrame = JSON.stringify({
          i: `artifact:${artifact.slug}`,
          t: artifact.createdAt,
          v: {
            type: 'artifact',
            action: 'created',
            artifact,
          },
        });
        await broadcast(channelId, artifactFrame);

        jsonResponse(res, 201, {
          success: true,
          asset: {
            slug,
            url: `/channels/${channelId}/assets/${slug}`,
            mimeType,
            size: filePart.data.length,
            tldr,
          },
          artifact,
        });
        return;
      }

      // GET /channels/:id/assets/:slug - Serve asset file
      if (req.method === 'GET' && pathParts[0] === 'channels' && pathParts[2] === 'assets' && pathParts[3]) {
        const channelId = pathParts[1];
        const slug = pathParts[3];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const filePath = path.join(ASSETS_DIR, channelId, slug);

        if (!fs.existsSync(filePath)) {
          jsonResponse(res, 404, { error: `Asset not found: ${slug}` });
          return;
        }

        // Determine content type from extension
        const ext = path.extname(slug).toLowerCase();
        const mimeTypes: Record<string, string> = {
          '.png': 'image/png',
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.gif': 'image/gif',
          '.svg': 'image/svg+xml',
          '.webp': 'image/webp',
          '.pdf': 'application/pdf',
        };
        const contentTypeHeader = mimeTypes[ext] || 'application/octet-stream';

        const fileData = fs.readFileSync(filePath);
        res.writeHead(200, {
          'Content-Type': contentTypeHeader,
          'Content-Length': fileData.length,
          'Cache-Control': 'public, max-age=31536000', // Cache for 1 year
        });
        res.end(fileData);
        return;
      }

      // =========================================================================
      // Attachment Upload Routes (separate from artifact-based assets)
      // =========================================================================

      const ATTACHMENT_MAX_SIZE = 10 * 1024 * 1024; // 10MB
      const ATTACHMENT_ALLOWED_TYPES: Record<string, string> = {
        // Images
        'image/png': '.png',
        'image/jpeg': '.jpg',
        'image/jpg': '.jpg',
        'image/gif': '.gif',
        'image/svg+xml': '.svg',
        'image/webp': '.webp',
        // Audio
        'audio/mpeg': '.mp3',
        'audio/mp3': '.mp3',
        'audio/wav': '.wav',
        'audio/wave': '.wav',
        'audio/ogg': '.ogg',
        'audio/webm': '.webm',
        // Documents
        'application/pdf': '.pdf',
      };
      const ATTACHMENTS_DIR = './attachments';

      // POST /channels/:id/attachments - Upload attachment
      if (req.method === 'POST' && pathParts[0] === 'channels' && pathParts[2] === 'attachments' && !pathParts[3]) {
        const channelId = pathParts[1];

        // Verify channel belongs to user's space
        // For containers, spaceId comes from the X-Cikada-Token (validated by middleware)
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        const contentType = req.headers['content-type'] || '';

        // Check for multipart/form-data
        if (!contentType.includes('multipart/form-data')) {
          jsonResponse(res, 400, { error: 'Content-Type must be multipart/form-data' });
          return;
        }

        // Parse multipart form data
        const boundary = contentType.split('boundary=')[1];
        if (!boundary) {
          jsonResponse(res, 400, { error: 'Missing boundary in Content-Type' });
          return;
        }

        // Read raw body
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of req) {
          totalSize += chunk.length;
          if (totalSize > ATTACHMENT_MAX_SIZE) {
            jsonResponse(res, 413, { error: `File too large. Maximum size is ${ATTACHMENT_MAX_SIZE / 1024 / 1024}MB` });
            return;
          }
          chunks.push(chunk);
        }
        const rawBody = Buffer.concat(chunks);

        // Parse multipart parts
        const parts = parseMultipart(rawBody, boundary);

        const filePart = parts.find(p => p.name === 'file');
        const uploaderPart = parts.find(p => p.name === 'uploadedBy');
        const messageIdPart = parts.find(p => p.name === 'messageId');
        const titlePart = parts.find(p => p.name === 'title');
        const descriptionPart = parts.find(p => p.name === 'description');
        const customFilenamePart = parts.find(p => p.name === 'filename');

        if (!filePart || !filePart.data || filePart.data.length === 0) {
          jsonResponse(res, 400, { error: 'Missing file in request' });
          return;
        }

        // Validate MIME type
        const mimeType = filePart.contentType || 'application/octet-stream';
        if (!ATTACHMENT_ALLOWED_TYPES[mimeType]) {
          jsonResponse(res, 400, {
            error: `File type not allowed: ${mimeType}. Allowed types: ${Object.keys(ATTACHMENT_ALLOWED_TYPES).join(', ')}`
          });
          return;
        }

        const attachmentId = ulid();
        const ext = ATTACHMENT_ALLOWED_TYPES[mimeType];
        // Custom filename from agent takes precedence, then multipart filename, then default
        const filename = customFilenamePart?.data?.toString().trim() || filePart.filename || `attachment-${attachmentId}${ext}`;
        const uploadedBy = uploaderPart?.data?.toString().trim() || 'anonymous';
        const messageId = messageIdPart?.data?.toString().trim() || undefined;
        const title = titlePart?.data?.toString().trim() || undefined;
        const description = descriptionPart?.data?.toString().trim() || undefined;
        const now = new Date().toISOString();

        // Create attachments directory for channel
        const channelAttachmentsDir = path.join(ATTACHMENTS_DIR, channelId);
        if (!fs.existsSync(channelAttachmentsDir)) {
          fs.mkdirSync(channelAttachmentsDir, { recursive: true });
        }

        // Write file (use attachment ID + extension for storage)
        const storedFilename = `${attachmentId}${ext}`;
        const filePath = path.join(channelAttachmentsDir, storedFilename);
        fs.writeFileSync(filePath, filePart.data);

        // Save attachment metadata to storage
        const attachmentUrl = `/channels/${channelId}/attachments/${attachmentId}`;
        const attachment = {
          id: attachmentId,
          channelId,
          filename,
          mimeType,
          size: filePart.data.length,
          url: attachmentUrl,
          uploadedBy,
          uploadedAt: now,
          title,
          description,
        };

        await storage.saveAttachment(spaceId, attachment);

        // Create attachment message automatically (so it appears in chat)
        // This makes attachments first-class citizens - no linking required
        const attachmentMessageId = ulid();
        const attachmentMessage = {
          id: attachmentMessageId,
          channelId,
          sender: uploadedBy,
          senderType: 'agent' as const,
          type: 'attachment' as const,
          content: {
            attachmentId,
            filename,
            mimeType,
            size: filePart.data.length,
            url: attachmentUrl,
            title,
            description,
          },
          timestamp: now,
          isComplete: true,
        };
        await storage.saveMessage(spaceId, attachmentMessage);

        // Also link attachment to its own message for consistency
        await storage.linkAttachmentsToMessage(spaceId, attachmentMessageId, [attachmentId]);

        // If explicit messageId was provided, link to that message too (for embedding in existing messages)
        if (messageId) {
          await storage.linkAttachmentsToMessage(spaceId, messageId, [attachmentId]);
        }

        // Broadcast the attachment message to the channel (Tymbal frame format)
        const frame = JSON.stringify({
          i: attachmentMessageId,
          t: now,
          v: {
            type: 'attachment',
            content: attachmentMessage.content,
            sender: uploadedBy,
            senderType: 'agent',
          },
        });
        await broadcast(channelId, frame);

        jsonResponse(res, 201, {
          success: true,
          attachment,
          messageId: attachmentMessageId,
        });
        return;
      }

      // GET /channels/:id/attachments/:attachmentId - Serve attachment file
      if (req.method === 'GET' && pathParts[0] === 'channels' && pathParts[2] === 'attachments' && pathParts[3]) {
        const channelId = pathParts[1];
        const attachmentId = pathParts[3];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        // Get attachment metadata from storage
        const attachment = await storage.getAttachment(spaceId, attachmentId);
        if (!attachment || attachment.channelId !== channelId) {
          jsonResponse(res, 404, { error: `Attachment not found: ${attachmentId}` });
          return;
        }

        // Determine file extension from MIME type
        const ext = ATTACHMENT_ALLOWED_TYPES[attachment.mimeType] || '';
        const storedFilename = `${attachmentId}${ext}`;
        const filePath = path.join(ATTACHMENTS_DIR, channelId, storedFilename);

        if (!fs.existsSync(filePath)) {
          jsonResponse(res, 404, { error: `Attachment file not found: ${attachmentId}` });
          return;
        }

        const fileData = fs.readFileSync(filePath);
        // Use download=1 query param to force download, otherwise inline display
        const forceDownload = url.searchParams.get('download') === '1';
        const disposition = forceDownload ? 'attachment' : 'inline';
        res.writeHead(200, {
          'Content-Type': attachment.mimeType,
          'Content-Length': fileData.length,
          'Content-Disposition': `${disposition}; filename="${attachment.filename}"`,
          'Cache-Control': 'public, max-age=86400', // Cache for 1 day (shorter than assets since ephemeral)
        });
        res.end(fileData);
        return;
      }

      // PATCH /channels/:id/attachments/:attachmentId - Link attachment to message
      if (req.method === 'PATCH' && pathParts[0] === 'channels' && pathParts[2] === 'attachments' && pathParts[3]) {
        const channelId = pathParts[1];
        const attachmentId = pathParts[3];

        // Verify channel belongs to user's space
        const channel = await storage.getChannel(spaceId, channelId);
        if (!channel) {
          jsonResponse(res, 404, { error: 'Channel not found' });
          return;
        }

        // Get attachment metadata from storage
        const attachment = await storage.getAttachment(spaceId, attachmentId);
        if (!attachment || attachment.channelId !== channelId) {
          jsonResponse(res, 404, { error: `Attachment not found: ${attachmentId}` });
          return;
        }

        const body = await readBody<{ messageId: string }>(req);
        if (!body.messageId) {
          jsonResponse(res, 400, { error: 'Missing required field: messageId' });
          return;
        }

        // Link attachment to message
        await storage.linkAttachmentsToMessage(spaceId, body.messageId, [attachmentId]);

        jsonResponse(res, 200, {
          success: true,
          attachmentId,
          messageId: body.messageId,
        });
        return;
      }

      // =========================================================================
      // OAuth Routes
      // =========================================================================

      // Handle OAuth API requests (/api/oauth/*)
      if (url.pathname.startsWith('/api/oauth/')) {
        const handled = await handleOAuthRequest(req, res, url, createOAuthDeps(spaceId));
        if (handled) return;
      }

      // =========================================================================
      // Knowledge Base Routes - /api/kbs/*
      // =========================================================================

      // GET /api/kbs - List all published knowledge bases
      if (req.method === 'GET' && pathParts[0] === 'api' && pathParts[1] === 'kbs' && !pathParts[2]) {
        // Query artifacts directly for type='knowledgebase' and status='published'
        // This is more reliable than querying kb_documents since KB manifests
        // aren't indexed there (only doc artifacts under them are)
        const allChannels = await storage.listChannels(spaceId);
        const kbs: Array<{ channel: string; title: string; tldr: string }> = [];

        for (const ch of allChannels) {
          const kbArtifacts = await storage.listArtifacts(spaceId, ch.id, {
            type: 'knowledgebase',
            status: 'published',
          });
          for (const kb of kbArtifacts) {
            kbs.push({
              channel: ch.id,
              title: kb.title || kb.slug,
              tldr: kb.tldr,
            });
          }
        }

        jsonResponse(res, 200, { kbs });
        return;
      }

      // GET /api/kbs/:channel/tree - KB tree view (kb_glob)
      if (
        req.method === 'GET' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'kbs' &&
        pathParts[2] &&
        pathParts[3] === 'tree'
      ) {
        const channel = pathParts[2];
        const pattern = url.searchParams.get('pattern') ?? '/**';

        // Get all KB docs for the channel
        const allDocs = await getKBDocsForChannel(spaceId, storage, channel);
        if (allDocs.length === 0) {
          jsonResponse(res, 404, { error: `No knowledge base found for channel: ${channel}` });
          return;
        }

        // Build tree from docs based on pattern
        const tree = buildKBTree(allDocs, pattern);
        jsonResponse(res, 200, { tree });
        return;
      }

      // GET /api/kbs/:channel/search - Search KB content (kb_query)
      if (
        req.method === 'GET' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'kbs' &&
        pathParts[2] &&
        pathParts[3] === 'search'
      ) {
        const channelParam = pathParts[2];
        const query = url.searchParams.get('q');

        if (!query) {
          jsonResponse(res, 400, { error: 'Missing required query parameter: q' });
          return;
        }

        // Resolve channel name to ID if needed - the kb_embeddings table stores channel IDs
        // Try to find a matching channel by ID first, then by name
        let channelId = channelParam;
        const allChannels = await storage.listChannels(spaceId);
        const matchedChannel = allChannels.find(
          ch => ch.id === channelParam || ch.name === channelParam
        );
        if (matchedChannel) {
          channelId = matchedChannel.id;
        }

        const mode = (url.searchParams.get('mode') as 'keyword' | 'semantic') ?? 'keyword';
        const limit = url.searchParams.get('limit') ? parseInt(url.searchParams.get('limit')!, 10) : 5;
        const pathFilter = url.searchParams.get('path') ?? undefined;

        // Handle semantic search mode
        if (mode === 'semantic') {
          if (!embeddingService) {
            jsonResponse(res, 400, {
              error: 'Semantic search not available - OPENAI_API_KEY not configured',
            });
            return;
          }

          // Generate embedding for the query
          const queryEmbedding = await embeddingService.generateEmbedding(query);

          // Search by embedding similarity using resolved channel ID
          const embeddingResults = await storage.searchByEmbedding(spaceId, queryEmbedding, {
            channel: channelId,
            limit,
          });

          // Fetch document details for each result by looking up the artifact
          const results: Array<{ path: string; title: string; tldr: string; relevance: number }> = [];
          for (const result of embeddingResults) {
            // The artifact ID is stored in kb_embeddings - look up the artifact
            // We need to search all artifacts to find one with matching ID
            const allDocs = await storage.listArtifacts(spaceId, channelId, { type: 'doc', status: 'published' });
            let matchingArtifact: any = null;
            for (const a of allDocs) {
              // Read full artifact to get ID
              const fullArtifact = await storage.getArtifact(spaceId, channelId, a.slug);
              if (fullArtifact?.id === result.artifactId) {
                matchingArtifact = a;
                break;
              }
            }

            if (matchingArtifact) {
              const fullArtifact = await storage.getArtifact(spaceId, channelId, matchingArtifact.slug);
              if (fullArtifact) {
                // Clamp relevance to 0-1 range (cosine distance can be > 1)
                const relevance = Math.max(0, Math.min(1, 1 - result.distance));
                results.push({
                  path: await buildKBPath(fullArtifact, storage, spaceId),
                  title: fullArtifact.title || fullArtifact.slug,
                  tldr: fullArtifact.tldr,
                  relevance,
                });
              }
            }
          }

          jsonResponse(res, 200, {
            kb: channelParam,
            query,
            mode: 'semantic',
            results,
            count: results.length,
          });
          return;
        }

        // Keyword search (FTS5) - also use resolved channel ID
        const options: KBSearchOptions = {
          mode: 'keyword',
          path: pathFilter,
          limit,
          highlight: url.searchParams.get('highlight') === 'true',
        };

        const results = await storage.searchKB(spaceId, channelId, query, options);

        jsonResponse(res, 200, {
          kb: channelParam,
          query,
          mode: options.mode,
          results,
          count: results.length,
        });
        return;
      }

      // GET /api/kbs/:channel/docs/* - Read KB document by path (kb_read)
      if (
        req.method === 'GET' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'kbs' &&
        pathParts[2] &&
        pathParts[3] === 'docs'
      ) {
        const channel = pathParts[2];
        // Path is everything after /docs/ - join remaining parts
        const docPath = '/' + pathParts.slice(4).join('/');

        const doc = await storage.getKBDocument(spaceId, channel, docPath);
        if (!doc) {
          jsonResponse(res, 404, { error: `Document not found: ${docPath}` });
          return;
        }

        jsonResponse(res, 200, {
          path: doc.path,
          title: doc.title,
          tldr: doc.tldr,
          content: doc.content,
        });
        return;
      }

      // GET /api/kbs/:channel - Get KB metadata for a channel
      if (
        req.method === 'GET' &&
        pathParts[0] === 'api' &&
        pathParts[1] === 'kbs' &&
        pathParts[2] &&
        !pathParts[3]
      ) {
        const channel = pathParts[2];
        // Query artifacts directly for the KB manifest
        const kbArtifacts = await storage.listArtifacts(spaceId, channel, {
          type: 'knowledgebase',
          status: 'published',
        });

        if (kbArtifacts.length === 0) {
          jsonResponse(res, 404, { error: `No knowledge base found for channel: ${channel}` });
          return;
        }

        const kb = kbArtifacts[0];
        jsonResponse(res, 200, {
          channel: channel,
          title: kb.title || kb.slug,
          tldr: kb.tldr,
        });
        return;
      }

      // Not found
      jsonResponse(res, 404, { error: 'Not found' });
    } catch (err) {
      console.error('[HTTP] Error:', err);
      jsonResponse(res, 500, {
        error: err instanceof Error ? err.message : 'Internal server error',
      });
    }
  }

  // Wrap with auth middleware
  return authMiddleware({ enabled: authEnabled }, handleRequest);
}

// =============================================================================
// KB Indexing Helpers
// =============================================================================

/**
 * Check if an artifact should be indexed for semantic search.
 * Only published docs under a knowledgebase parent should be indexed.
 */
async function shouldIndexArtifact(artifact: any, storage: Storage, spaceId: string): Promise<boolean> {
  // Must be a doc type
  if (artifact.type !== 'doc') {
    return false;
  }

  // Must be published
  if (artifact.status !== 'published') {
    return false;
  }

  // Must be under a knowledgebase - check parent chain
  let current: any = artifact;
  while (current?.parentSlug) {
    const parent = await storage.getArtifact(spaceId, artifact.channelId, current.parentSlug);
    if (!parent) break;
    if (parent.type === 'knowledgebase') {
      return true;
    }
    current = parent;
  }

  // Also check if direct parent is knowledgebase
  if (artifact.parentSlug === 'knowledgebase') {
    const parent = await storage.getArtifact(spaceId, artifact.channelId, 'knowledgebase');
    return parent?.type === 'knowledgebase';
  }

  return false;
}

/**
 * Index an artifact if it should be indexed.
 * Handles errors gracefully - logs but doesn't throw.
 */
async function maybeIndexArtifact(
  spaceId: string,
  artifact: any,
  kbIndexer: KBIndexer | undefined,
  storage: Storage
): Promise<void> {
  if (!kbIndexer) return;

  try {
    if (await shouldIndexArtifact(artifact, storage, spaceId)) {
      // Index in both embedding store and FTS
      await kbIndexer.indexDocument({
        id: artifact.id,
        channel: artifact.channelId,
        title: artifact.title || artifact.slug,
        tldr: artifact.tldr,
        content: artifact.content,
      });

      // Also index in FTS for keyword search
      await storage.indexKBDocument(spaceId, {
        id: artifact.id,
        channel: artifact.channelId,
        path: await buildKBPath(artifact, storage, spaceId),
        slug: artifact.slug,
        title: artifact.title || artifact.slug,
        tldr: artifact.tldr,
        content: artifact.content,
        parentSlug: artifact.parentSlug,
      });
    }
  } catch (err) {
    console.error(`[KBIndexer] Failed to index artifact ${artifact.id}:`, err);
  }
}

/**
 * Remove an artifact from the index.
 */
async function maybeRemoveFromIndex(
  spaceId: string,
  artifact: any,
  kbIndexer: KBIndexer | undefined,
  storage: Storage
): Promise<void> {
  if (!kbIndexer) return;

  try {
    await kbIndexer.removeDocument(artifact.id);
    await storage.removeKBDocument(spaceId, artifact.channelId, await buildKBPath(artifact, storage, spaceId));
  } catch (err) {
    console.error(`[KBIndexer] Failed to remove artifact ${artifact.id} from index:`, err);
  }
}

/**
 * Build the KB-relative path for an artifact.
 */
async function buildKBPath(artifact: any, storage: Storage, spaceId: string): Promise<string> {
  const parts: string[] = [artifact.slug];
  let current: any = artifact;

  while (current?.parentSlug && current.parentSlug !== 'knowledgebase') {
    const parent = await storage.getArtifact(spaceId, artifact.channelId, current.parentSlug);
    if (!parent) break;
    parts.unshift(parent.slug);
    current = parent;
  }

  return '/' + parts.join('/');
}

// =============================================================================
// KB Helpers
// =============================================================================

interface KBDocInfo {
  path: string;
  title: string;
  slug: string;
  parentSlug?: string;
}

/**
 * Get all KB documents for a channel by querying the kb_documents table.
 * Returns document metadata needed for tree building.
 */
async function getKBDocsForChannel(
  spaceId: string,
  storage: Storage,
  channel: string
): Promise<KBDocInfo[]> {
  // First check if KB exists for this channel by querying artifacts directly
  const kbArtifacts = await storage.listArtifacts(spaceId, channel, {
    type: 'knowledgebase',
    status: 'published',
  });
  if (kbArtifacts.length === 0) {
    return [];
  }

  // Get all docs by querying for docs with paths starting with /
  // We need to iterate through possible paths - use search with empty query
  // to get all docs, or implement a dedicated method
  // For now, use a workaround: search with a wildcard-like query
  const results = await storage.searchKB(spaceId, channel, '*', { limit: 1000 });

  return results.map(r => ({
    path: r.path,
    title: r.title,
    slug: r.path.split('/').pop() || '',
    parentSlug: r.path.split('/').slice(0, -1).join('/') || undefined,
  }));
}

/**
 * Build a tree representation from KB docs matching a glob pattern.
 */
function buildKBTree(docs: KBDocInfo[], pattern: string): string {
  // Filter docs based on pattern
  const filteredDocs = filterByGlob(docs, pattern);

  // Build tree structure
  const lines: string[] = [];
  const sorted = [...filteredDocs].sort((a, b) => a.path.localeCompare(b.path));

  for (const doc of sorted) {
    const depth = doc.path.split('/').filter(Boolean).length - 1;
    const indent = '  '.repeat(depth);
    const name = doc.path.split('/').pop() || doc.path;
    lines.push(`${indent}${name} - ${doc.title}`);
  }

  return lines.join('\n');
}

/**
 * Filter docs by glob pattern.
 * Supports: /** (all), /path/** (subtree), /* (root only)
 */
function filterByGlob(docs: KBDocInfo[], pattern: string): KBDocInfo[] {
  if (pattern === '/**') {
    return docs;
  }

  if (pattern === '/*') {
    // Root level only - paths with exactly one segment
    return docs.filter(d => d.path.split('/').filter(Boolean).length === 1);
  }

  if (pattern.endsWith('/**')) {
    // Subtree pattern - e.g., /api/**
    const prefix = pattern.slice(0, -3);
    return docs.filter(d => d.path === prefix || d.path.startsWith(prefix + '/'));
  }

  // Exact match
  return docs.filter(d => d.path === pattern);
}

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        const body = Buffer.concat(chunks).toString();
        resolve(body ? JSON.parse(body) : {} as T);
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      resolve(Buffer.concat(chunks).toString());
    });
    req.on('error', reject);
  });
}

interface MultipartPart {
  name?: string;
  filename?: string;
  contentType?: string;
  data?: Buffer;
}

function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const parts: MultipartPart[] = [];
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const endBoundaryBuffer = Buffer.from(`--${boundary}--`);

  let start = body.indexOf(boundaryBuffer);
  if (start === -1) return parts;

  start += boundaryBuffer.length;

  while (start < body.length) {
    // Skip CRLF after boundary
    if (body[start] === 0x0d && body[start + 1] === 0x0a) {
      start += 2;
    }

    // Find next boundary
    let end = body.indexOf(boundaryBuffer, start);
    if (end === -1) {
      end = body.indexOf(endBoundaryBuffer, start);
      if (end === -1) break;
    }

    // Extract this part
    const partData = body.slice(start, end);

    // Find header/body separator (double CRLF)
    const headerEnd = partData.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      start = end + boundaryBuffer.length;
      continue;
    }

    const headerSection = partData.slice(0, headerEnd).toString();
    let bodySection = partData.slice(headerEnd + 4);

    // Remove trailing CRLF from body
    if (bodySection.length >= 2 &&
        bodySection[bodySection.length - 2] === 0x0d &&
        bodySection[bodySection.length - 1] === 0x0a) {
      bodySection = bodySection.slice(0, -2);
    }

    // Parse headers
    const part: MultipartPart = { data: bodySection };
    const headers = headerSection.split('\r\n');

    for (const header of headers) {
      const lowerHeader = header.toLowerCase();
      if (lowerHeader.startsWith('content-disposition:')) {
        const nameMatch = header.match(/name="([^"]+)"/);
        const filenameMatch = header.match(/filename="([^"]+)"/);
        if (nameMatch) part.name = nameMatch[1];
        if (filenameMatch) part.filename = filenameMatch[1];
      } else if (lowerHeader.startsWith('content-type:')) {
        part.contentType = header.split(':')[1]?.trim();
      }
    }

    parts.push(part);
    start = end + boundaryBuffer.length;
  }

  return parts;
}

// =============================================================================
// Mock Auth Helpers
// =============================================================================

/**
 * List all spaces from storage for the mock auth account picker.
 */
async function listAllSpaces(storage: Storage): Promise<Space[]> {
  return storage.listSpaces();
}

/**
 * Generate HTML for the mock auth login page.
 */
function generateMockLoginPage(spaces: Space[]): string {
  const accountsList = spaces
    .filter(space => space.ownerId !== 'system') // Hide system account
    .map(space => {
      const displayName = space.name || space.ownerId;
      return `
        <a href="/mock-auth/callback?user=${encodeURIComponent(space.ownerId)}" class="account">
          <span class="avatar">👤</span>
          <span class="name">${escapeHtml(displayName)}</span>
        </a>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Mock Login - Dev Mode</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .container {
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      max-width: 400px;
      width: 100%;
      overflow: hidden;
    }
    .header {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      border-bottom: 1px solid #e9ecef;
    }
    .header h1 {
      font-size: 18px;
      color: #495057;
      font-weight: 600;
    }
    .header .badge {
      display: inline-block;
      background: #ffc107;
      color: #212529;
      font-size: 11px;
      padding: 2px 8px;
      border-radius: 12px;
      margin-top: 6px;
      font-weight: 500;
    }
    .content {
      padding: 24px;
    }
    .section-title {
      font-size: 13px;
      color: #6c757d;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 12px;
      font-weight: 600;
    }
    .accounts {
      border: 1px solid #e9ecef;
      border-radius: 8px;
      overflow: hidden;
      margin-bottom: 24px;
    }
    .account {
      display: flex;
      align-items: center;
      padding: 12px 16px;
      border-bottom: 1px solid #e9ecef;
      text-decoration: none;
      color: #212529;
      transition: background-color 0.15s;
    }
    .account:last-child {
      border-bottom: none;
    }
    .account:hover {
      background: #f8f9fa;
    }
    .account .avatar {
      font-size: 20px;
      margin-right: 12px;
    }
    .account .name {
      font-size: 14px;
      font-weight: 500;
    }
    .no-accounts {
      padding: 20px;
      text-align: center;
      color: #6c757d;
      font-style: italic;
    }
    .create-form {
      display: flex;
      gap: 8px;
    }
    .create-form input {
      flex: 1;
      padding: 10px 14px;
      border: 1px solid #ced4da;
      border-radius: 6px;
      font-size: 14px;
      outline: none;
      transition: border-color 0.15s;
    }
    .create-form input:focus {
      border-color: #667eea;
      box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.15);
    }
    .create-form button {
      padding: 10px 20px;
      background: #667eea;
      color: white;
      border: none;
      border-radius: 6px;
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 0.15s;
    }
    .create-form button:hover {
      background: #5a6fd6;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>Mock Login</h1>
      <span class="badge">Dev Mode</span>
    </div>
    <div class="content">
      <div class="section-title">Existing accounts</div>
      <div class="accounts">
        ${accountsList || '<div class="no-accounts">No accounts yet</div>'}
      </div>

      <div class="section-title">Or create new</div>
      <form class="create-form" action="/mock-auth/callback" method="get">
        <input type="text" name="new" placeholder="Enter username..." required />
        <button type="submit">Login</button>
      </form>
    </div>
  </div>
</body>
</html>`;
}

/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
