/**
 * Chorus Callback Handler
 *
 * Receives events from external Chorus agents and translates them into
 * stored messages + WebSocket broadcasts. This is the Chorus equivalent
 * of runtime-protocol-handlers.ts for container-based agents.
 *
 * Endpoint:
 *   POST /api/chorus/callback/:token
 *
 * Event types (from Chorus spec):
 *   - lifecycle: { type: "lifecycle", status: "processing" | "idle" }
 *   - message:   { type: "message", content: string }
 *   - tool_call: { type: "tool_call", ... }
 *   - tool_result: { type: "tool_result", ... }
 *   - error:     { type: "error", message: string }
 *   - status:    { type: "status", status: string } → IGNORED (agent uses MCP set_status)
 */

import { Hono } from 'hono';
import {
  tymbal,
  generateMessageId,
} from '@cast/core';
import type { Storage } from '@cast/storage';
import {
  generateContainerToken,
  verifyContainerToken,
} from '../auth/index.js';

// =============================================================================
// Types
// =============================================================================

export interface ChorusCallbackOptions {
  /** Storage backend */
  storage: Storage;
  /** Broadcast a serialized frame to all connections in a channel */
  broadcast: (channelId: string, data: string) => Promise<void>;
}

/** Chorus callback event from external agent */
interface ChorusEvent {
  type: 'lifecycle' | 'message' | 'tool_call' | 'tool_result' | 'error' | 'status';
  [key: string]: unknown;
}

// =============================================================================
// Callback Token
// =============================================================================

/**
 * Generate a callback token for a Chorus agent in a channel.
 * Reuses the same HMAC scheme as container tokens.
 */
export function generateCallbackToken(spaceId: string, channelId: string, callsign: string): string {
  return generateContainerToken({ spaceId, channelId, callsign });
}

/**
 * Verify and decode a callback token.
 */
export function verifyCallbackToken(token: string): { spaceId: string; channelId: string; callsign: string } | null {
  return verifyContainerToken(token);
}

// =============================================================================
// Route Factory
// =============================================================================

export function createChorusCallbackRoutes(options: ChorusCallbackOptions): Hono {
  const { storage, broadcast } = options;
  const app = new Hono();

  // Helper: broadcast agent state frame (mirrors runtime-protocol-handlers.ts)
  async function broadcastAgentState(
    channelId: string,
    callsign: string,
    state: 'online' | 'offline',
    timestamp: string
  ): Promise<void> {
    const frame = tymbal.set(generateMessageId(), {
      type: 'agent_state',
      sender: callsign,
      senderType: 'agent',
      state,
      lastHeartbeat: timestamp,
    });
    await broadcast(channelId, frame);
  }

  // POST /api/chorus/callback/:token
  app.post('/callback/:token', async (c) => {
    const token = c.req.param('token');

    // Verify callback token
    const payload = verifyCallbackToken(token);
    if (!payload) {
      return c.json({ error: 'Invalid callback token' }, 401);
    }

    const { spaceId, channelId, callsign } = payload;

    // Parse event body
    let event: ChorusEvent;
    try {
      event = await c.req.json() as ChorusEvent;
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    if (!event.type) {
      return c.json({ error: 'Missing event type' }, 400);
    }

    // Check roster status — block events from paused/archived agents
    const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
    if (!rosterEntry) {
      return c.json({ error: 'Agent not in roster' }, 404);
    }
    if (rosterEntry.status === 'paused' || rosterEntry.status === 'archived') {
      return c.json({ error: `Agent is ${rosterEntry.status}` }, 403);
    }

    const now = new Date().toISOString();

    try {
      switch (event.type) {
        // -----------------------------------------------------------------
        // Lifecycle events → agent state broadcasts
        // -----------------------------------------------------------------
        case 'lifecycle': {
          const status = event.status as string;
          if (status === 'processing') {
            await broadcastAgentState(channelId, callsign, 'online', now);
          } else if (status === 'idle') {
            // Broadcast idle frame (same as container agent_complete)
            const idleFrame = tymbal.set(generateMessageId(), {
              type: 'idle',
              sender: callsign,
              senderType: 'agent',
            });
            await broadcast(channelId, idleFrame);
          } else {
            return c.json({ error: `Unknown lifecycle status: ${status}` }, 400);
          }
          break;
        }

        // -----------------------------------------------------------------
        // Message event → store + broadcast
        // -----------------------------------------------------------------
        case 'message': {
          const content = event.content as string;
          if (!content) {
            return c.json({ error: 'Message event requires content field' }, 400);
          }

          const messageId = generateMessageId();
          await storage.saveMessage({
            id: messageId,
            spaceId,
            channelId,
            sender: callsign,
            senderType: 'agent',
            type: 'agent',
            content: { text: content },
            isComplete: true,
            metadata: { fromChorus: true },
          });

          // Broadcast as SetFrame
          const frame = tymbal.set(messageId, {
            type: 'agent',
            sender: callsign,
            senderType: 'agent',
            content,
          });
          await broadcast(channelId, frame);
          break;
        }

        // -----------------------------------------------------------------
        // Tool call/result events → store + broadcast
        // -----------------------------------------------------------------
        case 'tool_call':
        case 'tool_result': {
          const messageId = generateMessageId();
          await storage.saveMessage({
            id: messageId,
            spaceId,
            channelId,
            sender: callsign,
            senderType: 'agent',
            type: event.type,
            content: event as Record<string, unknown>,
            isComplete: true,
            metadata: { fromChorus: true },
          });

          const frame = tymbal.set(messageId, {
            ...event,
            sender: callsign,
            senderType: 'agent',
          });
          await broadcast(channelId, frame);
          break;
        }

        // -----------------------------------------------------------------
        // Error event → store + broadcast
        // -----------------------------------------------------------------
        case 'error': {
          const messageId = generateMessageId();
          const errorMessage = (event.message as string) ?? 'Unknown error';

          await storage.saveMessage({
            id: messageId,
            spaceId,
            channelId,
            sender: callsign,
            senderType: 'agent',
            type: 'error',
            content: { text: errorMessage },
            isComplete: true,
            metadata: { fromChorus: true },
          });

          const frame = tymbal.set(messageId, {
            type: 'error',
            sender: callsign,
            senderType: 'agent',
            content: errorMessage,
          });
          await broadcast(channelId, frame);
          break;
        }

        // -----------------------------------------------------------------
        // Status event → IGNORED (agent uses MCP set_status)
        // -----------------------------------------------------------------
        case 'status':
          // Intentionally ignored — Chorus agents have MCP access and use
          // the set_status tool directly, same as container agents.
          break;

        default:
          return c.json({ error: `Unknown event type: ${event.type}` }, 400);
      }

      // Update roster heartbeat on any activity
      await storage.updateRosterEntry(channelId, rosterEntry.id, {
        lastHeartbeat: now,
      });

      return c.json({ ok: true });
    } catch (error) {
      console.error('[ChorusCallback] Error handling event:', error);
      return c.json({ error: 'Internal server error' }, 500);
    }
  });

  return app;
}
