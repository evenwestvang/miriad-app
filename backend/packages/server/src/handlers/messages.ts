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
// Helpers
// =============================================================================

/**
 * Format attachment slugs as text appendix for agent messages.
 * Uses [[slug]] syntax which agents recognize as artifact references.
 */
function formatAttachments(attachmentSlugs: string[] | undefined): string {
  if (!attachmentSlugs || attachmentSlugs.length === 0) {
    return "";
  }
  const slugRefs = attachmentSlugs.map((slug) => `[[${slug}]]`).join(" ");
  return `\n\n<attachments>${slugRefs}</attachments>`;
}

/**
 * Transform messages for agent consumption by appending attachment info to content.
 */
function transformMessagesForAgent(messages: Message[]): Message[] {
  return messages.map((msg) => {
    const attachmentSlugs = msg.metadata?.attachmentSlugs as string[] | undefined;
    if (!attachmentSlugs || attachmentSlugs.length === 0) {
      return msg;
    }
    const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
    return {
      ...msg,
      content: contentStr + formatAttachments(attachmentSlugs),
    };
  });
}

// =============================================================================
// Types
// =============================================================================

export interface Message {
  id: string;
  channelId: string;
  sender: string;
  senderType: 'user' | 'agent' | 'system';  // Per spec: 'user', 'agent', or 'system'
  type: string;
  content: string | Record<string, unknown>;  // String for text messages, object for structured (e.g., status)
  timestamp: string;
  isComplete: boolean;
  addressedAgents?: string[];
  metadata?: Record<string, unknown>;  // For attachmentSlugs and other extensible data
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

export interface ArtifactStorage {
  /** Get an artifact by slug */
  getArtifact: (channelId: string, slug: string) => Promise<{ slug: string; type: string } | null>;
  /** Set the attachedToMessageId on an artifact */
  setArtifactAttachment: (channelId: string, slug: string, messageId: string, updatedBy: string) => Promise<void>;
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
  /** Optional: callback to update channel lastActiveAt when user sends a message */
  onUserMessage?: (channelId: string) => Promise<void>;
  /** Optional: artifact storage for linking attachments to messages */
  artifactStorage?: ArtifactStorage;
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
 *
 * @param content - Message content with @mentions
 * @param senderIsHuman - Whether the sender is human
 * @param roster - Channel roster
 * @param senderCallsign - Optional sender callsign (to exclude from targets)
 */
export function getAddressedAgents(
  content: string,
  senderIsHuman: boolean,
  roster: ChannelRoster,
  senderCallsign?: string
): { addressedAgents: string[]; isBroadcast: boolean } {
  const parsed = parseMentions(content);
  const routing = determineRouting(parsed, senderIsHuman, roster, senderCallsign);

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
  const { messageStorage, rosterProvider, connectionManager, agentInvoker, onUserMessage, artifactStorage } = options;

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
        // Transform messages to include attachment info in content
        messages = transformMessagesForAgent(messages);
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
   * Body: {
   *   content: string,
   *   sender?: string,
   *   senderType?: 'user' | 'agent',
   *   attachSlugs?: string[]  // Artifact slugs to attach to this message
   * }
   */
  app.post('/:channelId/messages', async (c) => {
    const channelId = c.req.param('channelId');

    let body: { content?: string; sender?: string; senderType?: 'user' | 'agent'; type?: 'event'; attachSlugs?: string[] };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { content, sender, senderType = 'user', type, attachSlugs } = body;

    if (!content) {
      return c.json({ error: 'Message content required' }, 400);
    }

    // Strict validation: senderType must be 'user' or 'agent' per spec
    if (senderType !== 'user' && senderType !== 'agent') {
      return c.json({ error: `Invalid senderType: ${senderType}. Must be 'user' or 'agent'` }, 400);
    }

    // Validate attachSlugs if provided
    if (attachSlugs && attachSlugs.length > 0) {
      if (!artifactStorage) {
        return c.json({ error: 'Artifact storage not configured for attachments' }, 500);
      }
      // Validate all slugs exist
      for (const slug of attachSlugs) {
        const artifact = await artifactStorage.getArtifact(channelId, slug);
        if (!artifact) {
          return c.json({ error: `Artifact not found: ${slug}` }, 404);
        }
        if (artifact.type !== 'asset') {
          return c.json({ error: `Artifact '${slug}' is not an asset (type: ${artifact.type})` }, 400);
        }
      }
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
    // Allow explicit 'event' type override for system-initiated messages
    const messageType = type === 'event' ? 'event' : senderType === 'user' ? 'user' : 'agent_message';

    // Build metadata with attachmentSlugs if provided
    const metadata: Record<string, unknown> | undefined =
      attachSlugs && attachSlugs.length > 0
        ? { attachmentSlugs: attachSlugs }
        : undefined;

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
      ...(metadata ? { metadata } : {}),
    };

    try {
      // Save message (includes attachmentSlugs in metadata)
      await messageStorage.saveMessage(channelId, message);

      // Link attachments to message (set attachedToMessageId on artifacts)
      if (attachSlugs && attachSlugs.length > 0 && artifactStorage) {
        const senderName = sender || 'anonymous';
        for (const slug of attachSlugs) {
          await artifactStorage.setArtifactAttachment(channelId, slug, messageId, senderName);
        }
      }

      // Update channel lastActiveAt when user sends a message
      if (senderType === 'user' && onUserMessage) {
        await onUserMessage(channelId);
      }

      // Broadcast to WebSocket clients
      const frame = tymbal.set(messageId, {
        type: message.type,
        sender: message.sender,
        senderType: message.senderType,
        content: message.content,
        timestamp: message.timestamp,
        ...(addressedAgents.length > 0 ? { mentions: addressedAgents } : {}),
        ...(isBroadcast ? { broadcast: true } : {}),
        ...(attachSlugs && attachSlugs.length > 0 ? { attachmentSlugs: attachSlugs } : {}),
      });
      await connectionManager.broadcast(channelId, frame);

      // Invoke agents if configured (filter out human users - they're valid targets but not agents to invoke)
      const agentTargets = addressedAgents.filter((t) => !roster.users?.includes(t));
      if (agentInvoker && agentTargets.length > 0) {
        await agentInvoker.invokeAgents(channelId, agentTargets, message);
      }

      return c.json({ message, attachmentSlugs: attachSlugs ?? [] }, 201);
    } catch (error) {
      console.error('[Messages] Error sending message:', error);
      return c.json({ error: 'Failed to send message' }, 500);
    }
  });

  return app;
}
