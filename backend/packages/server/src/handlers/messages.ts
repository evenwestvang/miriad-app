/**
 * Channel Message Handlers
 *
 * POST /channels/:id/messages - Send a message to a channel
 * GET /channels/:id/messages - Get messages for a channel (with agent scoping)
 */

import { Hono } from 'hono';
import {
  parseMentions,
  determineRouting,
  tymbal,
  generateMessageId,
  type SetFrame,
  type ChannelRoster,
} from '@cast/core';
import type { ConnectionManager } from '../websocket/index.js';

// =============================================================================
// Types
// =============================================================================

export interface Message {
  id: string;
  channelId: string;
  sender: string;
  senderType: 'user' | 'agent';  // Per spec: 'user' or 'agent'
  type: string;
  content: string;
  timestamp: string;
  isComplete: boolean;
  addressedAgents?: string[];
}

export interface MessageStorage {
  /** Save a message */
  saveMessage: (channelId: string, message: Message) => Promise<void>;
  /** Get messages for a channel */
  getMessages: (
    channelId: string,
    options?: {
      since?: string;
      before?: string;
      limit?: number;
      /** Filter for agent scoping */
      forAgent?: string;
    }
  ) => Promise<Message[]>;
  /** Delete a message */
  deleteMessage: (channelId: string, messageId: string) => Promise<void>;
}

export interface RosterProvider {
  /** Get the roster for a channel */
  getRoster: (channelId: string) => Promise<ChannelRoster | null>;
  /** Get the channel leader */
  getLeader: (channelId: string) => Promise<string | null>;
}

export interface AgentInvoker {
  /** Invoke agents for a message */
  invokeAgents: (
    channelId: string,
    targets: string[],
    message: Message
  ) => Promise<void>;
}

export interface MessageHandlerOptions {
  /** Storage for messages */
  messageStorage: MessageStorage;
  /** Provider for roster information */
  rosterProvider: RosterProvider;
  /** Connection manager for broadcasting */
  connectionManager: ConnectionManager;
  /** Optional: invoke agents on @mentions */
  agentInvoker?: AgentInvoker;
}

// =============================================================================
// Agent Message Scoping
// =============================================================================

/**
 * Filter messages for a specific agent.
 *
 * Agents only see messages where:
 * - They are in `addressedAgents` array, OR
 * - Message is from them (sender matches), OR
 * - Message has `@channel` mention (broadcast)
 */
export function filterMessagesForAgent(
  messages: Message[],
  agentCallsign: string
): Message[] {
  return messages.filter((msg) => {
    // Always see own messages
    if (msg.sender === agentCallsign) {
      return true;
    }

    // Check if directly addressed
    if (msg.addressedAgents?.includes(agentCallsign)) {
      return true;
    }

    // Check if broadcast (@channel - indicated by having all roster agents)
    // For simplicity, we also check if addressedAgents is undefined (legacy/human messages without parsing)
    // This should be refined based on actual business rules

    return false;
  });
}

/**
 * Determine addressed agents from message content.
 * Returns the list of agents to address and whether it's a broadcast.
 */
export function getAddressedAgents(
  content: string,
  senderIsHuman: boolean,
  roster: ChannelRoster
): { addressedAgents: string[]; isBroadcast: boolean } {
  const parsed = parseMentions(content);
  const routing = determineRouting(parsed, senderIsHuman, roster);

  return {
    addressedAgents: routing.targets,
    isBroadcast: routing.isBroadcast,
  };
}

// =============================================================================
// Route Handler
// =============================================================================

/**
 * Create the /channels/:id/messages routes.
 */
export function createMessageRoutes(options: MessageHandlerOptions): Hono {
  const { messageStorage, rosterProvider, connectionManager, agentInvoker } = options;

  const app = new Hono();

  /**
   * GET /channels/:id/messages
   *
   * Get messages for a channel.
   * Query params:
   * - since: ISO timestamp, get messages after this time
   * - before: ISO timestamp, get messages before this time
   * - limit: max messages to return (default 50)
   * - forAgent: agent callsign for scoped view
   */
  app.get('/:channelId/messages', async (c) => {
    const channelId = c.req.param('channelId');
    const since = c.req.query('since');
    const before = c.req.query('before');
    const limitStr = c.req.query('limit');
    const forAgent = c.req.query('forAgent');

    const limit = limitStr ? parseInt(limitStr, 10) : 50;

    try {
      let messages = await messageStorage.getMessages(channelId, {
        since,
        before,
        limit,
      });

      // Apply agent scoping if requested
      if (forAgent) {
        messages = filterMessagesForAgent(messages, forAgent);
      }

      return c.json({ messages });
    } catch (error) {
      console.error('[Messages] Error getting messages:', error);
      return c.json({ error: 'Failed to get messages' }, 500);
    }
  });

  /**
   * POST /channels/:id/messages
   *
   * Send a message to a channel.
   * Body: { content: string, sender?: string, senderType?: 'user' | 'agent' }
   */
  app.post('/:channelId/messages', async (c) => {
    const channelId = c.req.param('channelId');

    let body: { content?: string; sender?: string; senderType?: 'user' | 'agent' };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { content, sender, senderType = 'user' } = body;

    if (!content) {
      return c.json({ error: 'Message content required' }, 400);
    }

    // Strict validation: senderType must be 'user' or 'agent' per spec
    if (senderType !== 'user' && senderType !== 'agent') {
      return c.json({ error: `Invalid senderType: ${senderType}. Must be 'user' or 'agent'` }, 400);
    }

    // Get roster for routing
    const roster = await rosterProvider.getRoster(channelId);
    console.log('[Messages] Roster for channel', channelId, ':', JSON.stringify(roster));
    if (!roster) {
      return c.json({ error: 'Channel not found or has no roster' }, 404);
    }

    // Determine addressed agents
    const { addressedAgents, isBroadcast } = getAddressedAgents(
      content,
      senderType === 'user',
      roster
    );
    console.log('[Messages] Addressed agents:', addressedAgents, 'isBroadcast:', isBroadcast);

    const messageId = generateMessageId();
    const now = new Date().toISOString();

    // Determine message type based on sender type (per StoredMessageType spec)
    const messageType = senderType === 'user' ? 'user' : 'agent_message';

    const message: Message = {
      id: messageId,
      channelId,
      sender: sender || 'anonymous',
      senderType,
      type: messageType,
      content,
      timestamp: now,
      isComplete: true,
      ...(addressedAgents.length > 0 ? { addressedAgents } : {}),
    };

    try {
      // Save message
      await messageStorage.saveMessage(channelId, message);

      // Broadcast to WebSocket clients
      const frame = tymbal.set(messageId, {
        type: message.type,
        sender: message.sender,
        senderType: message.senderType,
        content: message.content,
        timestamp: message.timestamp,
        ...(addressedAgents.length > 0 ? { mentions: addressedAgents } : {}),
        ...(isBroadcast ? { broadcast: true } : {}),
      });
      await connectionManager.broadcast(channelId, frame);

      // Invoke agents if configured
      if (agentInvoker && addressedAgents.length > 0) {
        await agentInvoker.invokeAgents(channelId, addressedAgents, message);
      }

      return c.json({ message }, 201);
    } catch (error) {
      console.error('[Messages] Error sending message:', error);
      return c.json({ error: 'Failed to send message' }, 500);
    }
  });

  return app;
}
