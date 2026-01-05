/**
 * Agent Checkin Handler
 *
 * POST /agents/checkin - Container registers its callback URL on startup
 *
 * Flow:
 * 1. Container POSTs { channelId, callsign, endpoint }
 * 2. API stores endpoint, marks container ready
 * 3. API queries pending messages (since readmark)
 * 4. API POSTs compiled messages to callback URL
 * 5. On success, updates readmark
 */

import { Hono } from 'hono';
import type { Storage } from '@cast/storage';
import type { StoredMessage } from '@cast/core';

// =============================================================================
// Types
// =============================================================================

export interface CheckinRequest {
  /** Space ID */
  spaceId?: string;
  /** Channel ID */
  channelId: string;
  /** Agent callsign */
  callsign: string;
  /** Container callback URL (e.g., http://10.0.1.45:8080) */
  endpoint: string;
}

export interface CheckinHandlerOptions {
  /** Storage backend */
  storage: Storage;
  /** Default space ID */
  spaceId: string;
}

// =============================================================================
// Message Compilation
// =============================================================================

/**
 * Compile multiple messages into a single content string with headers.
 *
 * Format:
 * --- @sender in #channel says:
 * message content
 *
 * --- @sender2 in #channel says:
 * another message
 */
export function compileMessages(
  messages: StoredMessage[],
  channelName: string
): string {
  if (messages.length === 0) {
    return '';
  }

  if (messages.length === 1) {
    // Single message - just return content
    return typeof messages[0].content === 'string'
      ? messages[0].content
      : JSON.stringify(messages[0].content);
  }

  // Multiple messages - compile with headers
  return messages
    .map((msg) => {
      const content =
        typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
      return `--- @${msg.sender} in #${channelName} says:\n${content}`;
    })
    .join('\n\n');
}

/**
 * Get messages pending delivery for an agent.
 * Returns messages where:
 * - id > readmark (or all if no readmark)
 * - callsign is in addressedAgents array
 */
export async function getPendingMessages(
  storage: Storage,
  spaceId: string,
  channelId: string,
  callsign: string,
  readmark: string | null
): Promise<StoredMessage[]> {
  // Get messages since readmark
  const allMessages = await storage.getMessages(spaceId, channelId, {
    since: readmark ?? undefined,
    limit: 100, // Reasonable limit
  });

  // Filter to messages addressed to this agent
  return allMessages.filter((msg) => {
    if (!msg.addressedAgents || msg.addressedAgents.length === 0) {
      return false;
    }
    return msg.addressedAgents.includes(callsign);
  });
}

/**
 * Push messages to container callback URL.
 */
export async function pushMessagesToContainer(
  endpoint: string,
  compiledContent: string,
  threadId: string,
  systemPrompt?: string
): Promise<boolean> {
  try {
    const url = `${endpoint}/message`;
    const body: { content: string; threadId: string; systemPrompt?: string } = {
      content: compiledContent,
      threadId,
    };
    if (systemPrompt) {
      body.systemPrompt = systemPrompt;
    }

    console.log(`[Checkin] Pushing message to ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`[Checkin] Push failed: ${response.status} ${error}`);
      return false;
    }

    console.log(`[Checkin] Push successful`);
    return true;
  } catch (error) {
    console.error(`[Checkin] Push error:`, error);
    return false;
  }
}

// =============================================================================
// Route Handler
// =============================================================================

/**
 * Create the /agents/checkin route.
 */
export function createCheckinRoutes(options: CheckinHandlerOptions): Hono {
  const { storage, spaceId: defaultSpaceId } = options;

  const app = new Hono();

  /**
   * POST /agents/checkin
   *
   * Container calls this on startup to register its callback URL.
   * API stores the endpoint, then pushes pending messages.
   */
  app.post('/checkin', async (c) => {
    let body: CheckinRequest;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const { channelId, callsign, endpoint } = body;
    const spaceId = body.spaceId ?? defaultSpaceId;

    if (!channelId || !callsign || !endpoint) {
      return c.json(
        { error: 'channelId, callsign, and endpoint are required' },
        400
      );
    }

    console.log(`[Checkin] Agent ${callsign} checking in from ${endpoint}`);

    // Store callback URL in roster table
    const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
    if (!rosterEntry) {
      console.error(`[Checkin] Agent ${callsign} not found in roster for channel ${channelId}`);
      return c.json({ error: 'Agent not found in roster' }, 404);
    }

    // Persist callbackUrl to roster
    await storage.updateRosterEntry(channelId, rosterEntry.id, {
      callbackUrl: endpoint,
    });
    console.log(`[Checkin] Stored callbackUrl for ${callsign} in roster`);

    // Get readmark from roster entry (persisted in DB)
    const readmark = rosterEntry.readmark ?? null;

    // Block on pending message delivery before returning
    // (Lambda freezes async work after response is sent)
    let delivered = 0;
    try {
      // Get pending messages
      const pendingMessages = await getPendingMessages(
        storage,
        spaceId,
        channelId,
        callsign,
        readmark
      );

      if (pendingMessages.length === 0) {
        console.log(`[Checkin] No pending messages for ${callsign}`);
      } else {
        console.log(
          `[Checkin] ${pendingMessages.length} pending message(s) for ${callsign}`
        );

        // Get channel name for message headers
        const channel = await storage.getChannel(spaceId, channelId);
        const channelName = channel?.name ?? channelId;

        // Compile messages
        const compiledContent = compileMessages(pendingMessages, channelName);

        // Build thread ID
        const threadId = `${spaceId}:${channelId}:${callsign}`;

        // Push to container (blocking)
        const success = await pushMessagesToContainer(
          endpoint,
          compiledContent,
          threadId
        );

        if (success) {
          delivered = pendingMessages.length;
          // Update readmark to latest message ID (persisted in roster)
          const latestMessageId = pendingMessages[pendingMessages.length - 1].id;
          await storage.updateRosterEntry(channelId, rosterEntry.id, {
            readmark: latestMessageId,
          });
          console.log(`[Checkin] Updated readmark to ${latestMessageId}`);
        }
      }
    } catch (error) {
      console.error(`[Checkin] Error pushing messages:`, error);
    }

    return c.json({ ok: true, delivered });
  });

  /**
   * GET /agents/status/:channelId/:callsign
   *
   * Check if an agent has a registered callback (is "online").
   */
  app.get('/status/:channelId/:callsign', async (c) => {
    const channelId = c.req.param('channelId');
    const callsign = c.req.param('callsign');

    const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
    const endpoint = rosterEntry?.callbackUrl ?? null;

    return c.json({
      channelId,
      callsign,
      online: !!endpoint,
      endpoint,
    });
  });

  return app;
}
