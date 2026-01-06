/**
 * App Factory
 *
 * Creates a fully configured Hono app with all dependencies wired up.
 * This is the main entry point for both local dev and Lambda deployment.
 */

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { cors } from 'hono/cors';
import type { Storage } from '@cast/storage';
import type { ContainerOrchestrator } from '@cast/runtime';
import type { ChannelRoster, StoredMessage, RosterEntry, StoredMessageType, SetFrame } from '@cast/core';
import { parseFrame, isSetFrame, isResetFrame, tymbal, generateMessageId, getMimeType } from '@cast/core';
import { createTymbalRoutes } from './handlers/tymbal.js';
import { createMessageRoutes, type MessageStorage, type RosterProvider, type Message } from './handlers/messages.js';
import { createCheckinRoutes } from './handlers/checkin.js';
import { createMcpRoutes } from './handlers/mcp-http.js';
import { createArtifactRoutes } from './handlers/artifacts.js';
import { createFilesystemAssetStorage } from './assets/index.js';
import type { ConnectionManager } from './websocket/index.js';
import { AgentManager, createAgentInvokerAdapter } from './agents/index.js';
import { createDevAuthRoutes } from './auth/index.js';

// =============================================================================
// Types
// =============================================================================

export interface AppOptions {
  /** Storage backend for messages, channels, roster */
  storage: Storage;
  /** Container orchestrator (Docker for local, Fargate for prod) */
  orchestrator: ContainerOrchestrator;
  /** WebSocket connection manager */
  connectionManager: ConnectionManager;
  /** Default space ID for single-tenant deployments */
  spaceId: string;
}

// =============================================================================
// Storage Adapters
// =============================================================================

/**
 * Adapt @cast/storage to MessageStorage interface expected by message handlers.
 */
function createMessageStorageAdapter(storage: Storage, spaceId: string): MessageStorage {
  return {
    async saveMessage(channelId: string, message: Message): Promise<void> {
      await storage.saveMessage({
        id: message.id,
        spaceId,
        channelId,
        sender: message.sender,
        senderType: message.senderType,
        type: message.type as 'user' | 'agent',
        content: message.content,
        isComplete: message.isComplete,
        addressedAgents: message.addressedAgents,
      });
    },

    async getMessages(
      channelId: string,
      options?: { since?: string; before?: string; limit?: number; forAgent?: string }
    ): Promise<Message[]> {
      const stored = await storage.getMessages(spaceId, channelId, {
        since: options?.since,
        before: options?.before,
        limit: options?.limit,
      });

      return stored.map((msg: StoredMessage) => ({
        id: msg.id,
        channelId: msg.channelId,
        sender: msg.sender,
        senderType: msg.senderType,
        type: msg.type,
        content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        timestamp: msg.timestamp,
        isComplete: msg.isComplete,
        addressedAgents: msg.addressedAgents,
      }));
    },

    async deleteMessage(channelId: string, messageId: string): Promise<void> {
      await storage.deleteMessage(spaceId, messageId);
    },
  };
}

/**
 * Adapt @cast/storage to RosterProvider interface expected by message handlers.
 */
function createRosterProviderAdapter(storage: Storage, spaceId: string): RosterProvider {
  return {
    async getRoster(channelId: string): Promise<ChannelRoster | null> {
      const channel = await storage.getChannel(spaceId, channelId);
      if (!channel) return null;

      const rosterEntries = await storage.listRoster(channelId);

      // Find leader (first agent with 'lead' in type)
      const leaderEntry = rosterEntries.find((e: RosterEntry) => e.agentType.toLowerCase().includes('lead'));

      // ChannelRoster expects { agents: string[], leader: string }
      const roster: ChannelRoster = {
        agents: rosterEntries.map((e: RosterEntry) => e.callsign),
        leader: leaderEntry?.callsign ?? rosterEntries[0]?.callsign ?? '',
      };

      return roster;
    },

    async getLeader(channelId: string): Promise<string | null> {
      const rosterEntries = await storage.listRoster(channelId);
      // Convention: first agent with 'lead' in type is the leader
      const leader = rosterEntries.find((e: RosterEntry) => e.agentType.toLowerCase().includes('lead'));
      return leader?.callsign ?? null;
    },
  };
}

// =============================================================================
// Channel & Roster Routes
// =============================================================================

function createChannelRoutes(storage: Storage, spaceId: string): Hono {
  const app = new Hono();

  // GET /channels - List all channels
  app.get('/', async (c) => {
    try {
      const channels = await storage.listChannels(spaceId);
      return c.json({ channels });
    } catch (error) {
      console.error('[Channels] Error listing channels:', error);
      return c.json({ error: 'Failed to list channels' }, 500);
    }
  });

  // POST /channels - Create a channel
  app.post('/', async (c) => {
    let body: { name?: string; tagline?: string; mission?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.name) {
      return c.json({ error: 'Channel name is required' }, 400);
    }

    try {
      const channel = await storage.createChannel({
        spaceId,
        name: body.name,
        tagline: body.tagline,
        mission: body.mission,
      });
      return c.json({ channel }, 201);
    } catch (error) {
      console.error('[Channels] Error creating channel:', error);
      return c.json({ error: 'Failed to create channel' }, 500);
    }
  });

  // GET /channels/:id - Get a channel (with roster per spec)
  app.get('/:channelId', async (c) => {
    const channelId = c.req.param('channelId');

    try {
      const channel = await storage.getChannel(spaceId, channelId);
      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Include roster per spec
      const roster = await storage.listRoster(channelId);

      return c.json({ channel, roster });
    } catch (error) {
      console.error('[Channels] Error getting channel:', error);
      return c.json({ error: 'Failed to get channel' }, 500);
    }
  });

  // PUT /channels/:id - Update a channel
  app.put('/:channelId', async (c) => {
    const channelId = c.req.param('channelId');

    let body: { name?: string; tagline?: string; mission?: string; archived?: boolean };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    try {
      await storage.updateChannel(spaceId, channelId, body);
      const channel = await storage.getChannel(spaceId, channelId);
      return c.json({ channel });
    } catch (error) {
      console.error('[Channels] Error updating channel:', error);
      return c.json({ error: 'Failed to update channel' }, 500);
    }
  });

  return app;
}

function createRosterRoutes(storage: Storage): Hono {
  const app = new Hono();

  // GET /channels/:id/roster - List roster
  app.get('/:channelId/roster', async (c) => {
    const channelId = c.req.param('channelId');

    try {
      const roster = await storage.listRoster(channelId);
      return c.json({ roster });
    } catch (error) {
      console.error('[Roster] Error listing roster:', error);
      return c.json({ error: 'Failed to list roster' }, 500);
    }
  });

  // POST /channels/:id/roster - Add to roster
  app.post('/:channelId/roster', async (c) => {
    const channelId = c.req.param('channelId');

    let body: { callsign?: string; agentType?: string; status?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!body.callsign || !body.agentType) {
      return c.json({ error: 'callsign and agentType are required' }, 400);
    }

    try {
      const entry = await storage.addToRoster({
        channelId,
        callsign: body.callsign,
        agentType: body.agentType,
        status: (body.status as 'active' | 'idle' | 'busy' | 'offline') ?? 'active',
      });
      return c.json({ entry }, 201);
    } catch (error) {
      console.error('[Roster] Error adding to roster:', error);
      return c.json({ error: 'Failed to add to roster' }, 500);
    }
  });

  // DELETE /channels/:id/roster/:entryId - Remove from roster
  app.delete('/:channelId/roster/:entryId', async (c) => {
    const channelId = c.req.param('channelId');
    const entryId = c.req.param('entryId');

    try {
      await storage.removeFromRoster(channelId, entryId);
      return c.json({ ok: true });
    } catch (error) {
      console.error('[Roster] Error removing from roster:', error);
      return c.json({ error: 'Failed to remove from roster' }, 500);
    }
  });

  return app;
}

// =============================================================================
// Agent Routes (POST /channels/:id/agents - Add agent to channel)
// =============================================================================

interface AgentRoutesOptions {
  storage: Storage;
  spaceId: string;
  connectionManager: ConnectionManager;
  agentManager: AgentManager;
}

function createAgentRoutes(options: AgentRoutesOptions): Hono {
  const { storage, spaceId, connectionManager, agentManager } = options;
  const app = new Hono();

  /**
   * POST /channels/:id/agents - Add an agent to a channel
   *
   * Flow:
   * 1. Add to roster via storage.addToRoster()
   * 2. Create "Summoning {callsign}..." status message (save + broadcast)
   * 3. Set that message ID as initial readmark
   * 4. Spawn container via agentManager
   * 5. Return agent info
   */
  app.post('/:channelId/agents', async (c) => {
    const channelId = c.req.param('channelId');

    let body: { callsign?: string; agentType?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { callsign, agentType } = body;

    if (!callsign || !agentType) {
      return c.json({ error: 'callsign and agentType are required' }, 400);
    }

    try {
      // Verify channel exists
      const channel = await storage.getChannel(spaceId, channelId);
      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Check if agent already exists in roster
      const existingEntry = await storage.getRosterByCallsign(channelId, callsign);
      if (existingEntry) {
        return c.json({ error: 'Agent already in roster' }, 409);
      }

      console.log(`[Agents] Adding ${callsign} (${agentType}) to channel ${channelId}`);

      // Step 1: Add to roster
      const rosterEntry = await storage.addToRoster({
        channelId,
        callsign,
        agentType,
        status: 'active',
      });
      console.log(`[Agents] Added ${callsign} to roster, entry ID: ${rosterEntry.id}`);

      // Step 2: Create summoning message (save + broadcast)
      const messageId = generateMessageId();
      const now = new Date().toISOString();
      const summoningContent = `Summoning ${callsign}...`;

      // Save message to storage
      await storage.saveMessage({
        id: messageId,
        spaceId,
        channelId,
        sender: 'system',
        senderType: 'agent',
        type: 'status',
        content: summoningContent,
        isComplete: true,
      });
      console.log(`[Agents] Created summoning message: ${messageId}`);

      // Broadcast to WebSocket clients
      const frame = tymbal.set(messageId, {
        type: 'status',
        sender: 'system',
        senderType: 'agent',
        content: summoningContent,
        timestamp: now,
      });
      await connectionManager.broadcast(channelId, frame);
      console.log(`[Agents] Broadcast summoning message to channel`);

      // Step 3: Set summoning message ID as initial readmark
      await storage.updateRosterEntry(channelId, rosterEntry.id, {
        readmark: messageId,
      });
      console.log(`[Agents] Set initial readmark to ${messageId}`);

      // Step 4: Spawn container
      try {
        await agentManager.spawn(spaceId, channelId, callsign);
        console.log(`[Agents] Container spawned for ${callsign}`);
      } catch (spawnError) {
        console.error(`[Agents] Failed to spawn container for ${callsign}:`, spawnError);
        // Don't fail the request - agent is in roster, container spawn can retry
      }

      // Step 5: Return agent info
      return c.json({
        success: true,
        agent: {
          id: rosterEntry.id,
          callsign: rosterEntry.callsign,
          agentType: rosterEntry.agentType,
          status: rosterEntry.status,
        },
      }, 201);
    } catch (error) {
      console.error('[Agents] Error adding agent:', error);
      return c.json({ error: 'Failed to add agent' }, 500);
    }
  });

  return app;
}

// =============================================================================
// App Factory
// =============================================================================

/**
 * Create a fully configured Cast backend Hono app.
 */
export function createApp(options: AppOptions): Hono {
  const { storage, orchestrator, connectionManager, spaceId } = options;

  const app = new Hono();

  // ---------------------------------------------------------------------------
  // Middleware
  // ---------------------------------------------------------------------------

  app.use('*', logger());
  app.use('*', cors({
    origin: (origin) => {
      // Allow any localhost origin for local development
      if (origin && origin.match(/^http:\/\/localhost(:\d+)?$/)) {
        return origin;
      }
      return null;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  }));

  // ---------------------------------------------------------------------------
  // Health & Info Endpoints
  // ---------------------------------------------------------------------------

  app.get('/health', (c) => {
    return c.json({
      status: 'ok',
      version: '0.0.1',
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/', (c) => {
    return c.json({
      name: 'Cast Backend',
      version: '0.0.1',
      docs: '/health',
    });
  });

  // ---------------------------------------------------------------------------
  // Auth Routes (Dev Mode)
  // ---------------------------------------------------------------------------

  const devAuthRoutes = createDevAuthRoutes({ storage });
  app.route('/auth/dev', devAuthRoutes);

  // GET /auth/me and POST /auth/logout are mounted at /auth level
  // (shared between dev and workos modes)
  app.get('/auth/me', async (c) => {
    // Forward to dev routes for now (WorkOS will add its own handler later)
    const response = await devAuthRoutes.request(
      new Request(new URL('/me', c.req.url), { headers: c.req.raw.headers }),
      {}
    );
    // Copy response headers (including cookies)
    const headers = new Headers(response.headers);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  });

  app.post('/auth/logout', async (c) => {
    const response = await devAuthRoutes.request(
      new Request(new URL('/logout', c.req.url), {
        method: 'POST',
        headers: c.req.raw.headers,
      }),
      {}
    );
    const headers = new Headers(response.headers);
    return new Response(response.body, {
      status: response.status,
      headers,
    });
  });

  // ---------------------------------------------------------------------------
  // Focus Types & Agent Types (stubs for frontend)
  // ---------------------------------------------------------------------------

  app.get('/focus-types', (c) => {
    return c.json({
      focusTypes: [
        {
          slug: 'general',
          name: 'General',
          description: 'Open workspace for any task',
        },
      ],
    });
  });

  app.get('/agents', (c) => {
    return c.json({
      agentTypes: [
        {
          slug: 'engineer',
          name: 'Engineer',
          description: 'Software engineering agent',
        },
        {
          slug: 'lead',
          name: 'Lead',
          description: 'Team lead agent',
        },
      ],
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/backends - List available AI backends/engines with capabilities
  // Static response for now - engine registry integration can come later
  // ---------------------------------------------------------------------------
  app.get('/api/backends', (c) => {
    return c.json([
      {
        name: 'claude',
        isBuiltIn: true,
        capabilities: { supportsMcp: true, supportsTools: true, supportsVision: true },
      },
      {
        name: 'openai',
        isBuiltIn: true,
        capabilities: { supportsMcp: true, supportsTools: true, supportsVision: true },
      },
      {
        name: 'codex',
        isBuiltIn: true,
        capabilities: { supportsMcp: true, supportsTools: true, supportsVision: false },
      },
    ]);
  });

  // ---------------------------------------------------------------------------
  // Create Agent Manager
  // ---------------------------------------------------------------------------

  const agentManager = new AgentManager({
    orchestrator,
    broadcast: (channelId, frame) => connectionManager.broadcast(channelId, frame),
    getChannel: async (sid, cid) => {
      const channel = await storage.getChannel(sid, cid);
      if (!channel) return null;
      return {
        id: channel.id,
        name: channel.name,
        tagline: channel.tagline,
        mission: channel.mission,
      };
    },
    getRoster: async (sid, cid) => {
      const entries = await storage.listRoster(cid);
      return entries.map((e: RosterEntry) => ({
        callsign: e.callsign,
        agentType: e.agentType,
        status: e.status === 'active' ? 'active' : 'inactive',
      }));
    },
  });

  const agentInvoker = createAgentInvokerAdapter({
    agentManager,
    storage,
    spaceId,
    orchestrator, // For local Docker: use orchestrator's port mapping directly
  });

  // ---------------------------------------------------------------------------
  // Storage Adapters
  // ---------------------------------------------------------------------------

  const messageStorage = createMessageStorageAdapter(storage, spaceId);
  const rosterProvider = createRosterProviderAdapter(storage, spaceId);

  // ---------------------------------------------------------------------------
  // Mount Routes
  // ---------------------------------------------------------------------------

  // Tymbal routes (container → server communication)
  const tymbalRoutes = createTymbalRoutes({
    connectionManager,
    onSetFrame: async (channelId, frame) => {
      // Persist SetFrames as messages
      if (frame.v && typeof frame.v === 'object') {
        const value = frame.v as Record<string, unknown>;
        await storage.saveMessage({
          id: frame.i,
          spaceId,
          channelId,
          sender: (value.sender as string) ?? 'system',
          senderType: (value.senderType as 'user' | 'agent') ?? 'agent',
          type: ((value.type as string) ?? 'agent') as StoredMessageType,
          content: value.content ?? value,
          isComplete: true,
          addressedAgents: value.mentions as string[] | undefined,
          metadata: { fromTymbal: true },
        });
      }
    },
    onResetFrame: async (channelId, messageId) => {
      await storage.deleteMessage(spaceId, messageId);
    },
  });
  app.route('/tymbal', tymbalRoutes);

  // Legacy /thread/:threadId/tymbal endpoint for compatibility with existing containers
  // threadId format: spaceId:channelId:callsign
  // This endpoint doesn't require container auth (legacy containers don't send it)
  app.post('/thread/:threadId/tymbal', async (c) => {
    const threadId = c.req.param('threadId');
    const parts = threadId.split(':');
    if (parts.length < 2) {
      return c.json({ error: 'invalid_thread_id', message: 'Thread ID must be spaceId:channelId[:callsign]' }, 400);
    }
    const channelId = parts[1];

    const body = await c.req.text();
    if (!body.trim()) {
      return c.json({ error: 'empty_body', message: 'Request body is empty' }, 400);
    }

    const frame = parseFrame(body);
    if (!frame) {
      return c.json({ error: 'invalid_frame', message: 'Could not parse Tymbal frame' }, 400);
    }

    try {
      if (isSetFrame(frame)) {
        const normalizedValue = frame.v && typeof frame.v === 'object' && (frame.v as Record<string, unknown>).type === 'tool_call' && 'input' in (frame.v as Record<string, unknown>) && !('args' in (frame.v as Record<string, unknown>))
          ? { ...(frame.v as Record<string, unknown>), args: (frame.v as Record<string, unknown>).input }
          : frame.v;
        const normalizedFrame = normalizedValue !== frame.v ? { ...frame, v: normalizedValue } : frame;
        const serialized = JSON.stringify(normalizedFrame);
        await connectionManager.broadcast(channelId, serialized);

        // Persist SetFrames as messages
        if (normalizedFrame.v && typeof normalizedFrame.v === 'object') {
          const value = normalizedFrame.v as Record<string, unknown>;
          await storage.saveMessage({
            id: normalizedFrame.i,
            spaceId,
            channelId,
            sender: (value.sender as string) ?? 'system',
            senderType: (value.senderType as 'user' | 'agent') ?? 'agent',
            type: ((value.type as string) ?? 'agent') as StoredMessageType,
            content: value.content ?? value,
            isComplete: true,
            addressedAgents: value.mentions as string[] | undefined,
            metadata: { fromTymbal: true },
          });
        }
      } else if (isResetFrame(frame)) {
        await connectionManager.broadcast(channelId, body);
        await storage.deleteMessage(spaceId, frame.i);
      } else {
        await connectionManager.broadcast(channelId, body);
      }

      return c.json({ ok: true });
    } catch (error) {
      console.error('[Tymbal/Legacy] Error processing frame:', error);
      return c.json({ error: 'processing_error', message: 'Failed to process frame' }, 500);
    }
  });

  // Message routes (user → server → agents)
  const messageRoutes = createMessageRoutes({
    messageStorage,
    rosterProvider,
    connectionManager,
    agentInvoker,
  });
  app.route('/channels', messageRoutes);

  // Channel CRUD routes
  const channelRoutes = createChannelRoutes(storage, spaceId);
  app.route('/channels', channelRoutes);

  // Roster routes (mounted under /channels/:id/roster)
  const rosterRoutes = createRosterRoutes(storage);
  app.route('/channels', rosterRoutes);

  // Agent routes (POST /channels/:id/agents - Add agent to channel)
  const agentRoutes = createAgentRoutes({
    storage,
    spaceId,
    connectionManager,
    agentManager,
  });
  app.route('/channels', agentRoutes);

  // Agent checkin routes (container → server registration)
  // Both callbackUrl and readmark are persisted to roster table in PlanetScale
  const checkinRoutes = createCheckinRoutes({
    storage,
    spaceId,
    orchestrator, // For local Docker: use orchestrator's port mapping for pending messages
  });
  app.route('/agents', checkinRoutes);

  // Asset storage for binary files
  const assetStorage = createFilesystemAssetStorage();

  // ---------------------------------------------------------------------------
  // /boards/:channel/:slug - PowPow-compatible artifact content serving
  // Serves artifact content with appropriate Content-Type headers.
  // For file-encoded artifacts (binary assets), serves via assetStorage.
  // For text artifacts, serves content directly.
  // ---------------------------------------------------------------------------
  app.get('/boards/:channel/:slug', async (c) => {
    const channelParam = c.req.param('channel');
    const slug = c.req.param('slug');

    try {
      // Resolve channel by name or ID (support both formats)
      const channel = await storage.getChannelByName(spaceId, channelParam)
        ?? await storage.getChannel(spaceId, channelParam);

      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }

      // Get artifact by slug
      const artifact = await storage.getArtifact(channel.id, slug);
      if (!artifact) {
        return c.json({ error: `Artifact not found: ${slug}` }, 404);
      }

      // For asset artifacts, serve binary file via assetStorage
      if (artifact.type === 'asset') {
        const data = await assetStorage.readAsset(channel.id, slug);
        const mimeType = artifact.contentType || getMimeType(slug);

        return new Response(data, {
          status: 200,
          headers: {
            'Content-Type': mimeType,
            'Content-Length': data.length.toString(),
            'Cache-Control': 'public, max-age=31536000, immutable',
          },
        });
      }

      // For text artifacts, serve content directly with appropriate Content-Type
      const content = artifact.content || '';
      const mimeType = getMimeType(slug);

      c.header('Content-Type', mimeType);
      c.header('Content-Length', Buffer.byteLength(content).toString());
      c.header('Cache-Control', 'public, max-age=3600');
      return c.body(content);
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        return c.json({ error: error.message }, 404);
      }
      console.error('[Boards] Error serving artifact content:', error);
      return c.json({ error: 'Failed to serve artifact content' }, 500);
    }
  });

  // MCP HTTP routes (container → server board operations)
  const mcpRoutes = createMcpRoutes({
    storage,
    spaceId,
    assetStorage,
  });
  app.route('/mcp', mcpRoutes);

  // Artifact routes (REST API for frontend)
  const artifactRoutes = createArtifactRoutes({
    storage,
    spaceId,
    connectionManager,
    assetStorage,
  });
  app.route('/channels', artifactRoutes);

  return app;
}

/**
 * Get the AgentManager for shutdown handling.
 * Call this before server shutdown to stop all containers.
 */
export function getAgentManager(app: Hono): AgentManager | undefined {
  // Note: We'd need to store this in app context for retrieval
  // For now, the factory caller should retain their own reference
  return undefined;
}
