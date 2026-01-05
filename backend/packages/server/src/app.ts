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
import { parseFrame, isSetFrame, isResetFrame } from '@cast/core';
import { createTymbalRoutes } from './handlers/tymbal.js';
import { createMessageRoutes, type MessageStorage, type RosterProvider, type Message } from './handlers/messages.js';
import type { ConnectionManager } from './websocket/index.js';
import { AgentManager, createAgentInvokerAdapter } from './agents/index.js';

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
        senderType: message.senderType === 'human' ? 'user' : 'agent',
        type: message.type as 'user' | 'assistant' | 'agent_message',
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
        senderType: msg.senderType === 'user' ? 'human' : 'agent',
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

  // GET /channels/:id - Get a channel
  app.get('/:channelId', async (c) => {
    const channelId = c.req.param('channelId');

    try {
      const channel = await storage.getChannel(spaceId, channelId);
      if (!channel) {
        return c.json({ error: 'Channel not found' }, 404);
      }
      return c.json({ channel });
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
  app.use('*', cors());

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
    spaceId,
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
          type: ((value.type as string) ?? 'assistant') as StoredMessageType,
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
            type: ((value.type as string) ?? 'assistant') as StoredMessageType,
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
