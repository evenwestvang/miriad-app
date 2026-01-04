/**
 * WebSocket Handler
 *
 * Tymbal frame streaming over WebSocket.
 * Channel-scoped connections with multiplexed messages.
 *
 * Auth: Requires valid session cookie on upgrade request.
 * SpaceId is extracted from session and used for all storage queries.
 */

import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Storage } from '@cikada/storage';
import {
  parseFrame,
  serializeFrameLine,
  setFrame,
  type SyncRequest,
} from '@cikada/core/tymbal';
import { verifySession } from './auth/session.js';
import type { StoredMessage } from '@cikada/core';

// =============================================================================
// Frame Building
// =============================================================================

/**
 * Build a Tymbal SetFrame value from a StoredMessage.
 * Consistent format for all message types:
 * - assistant/user: { type, sender, senderType, content }
 * - tool_call/tool_result: { type, sender, senderType, ...content } (spread stored fields)
 */
function buildFrameValue(msg: StoredMessage): Record<string, unknown> {
  const base = {
    type: msg.type,
    sender: msg.sender,
    senderType: msg.senderType,
  };

  switch (msg.type) {
    case 'tool_call':
    case 'tool_result':
      // Spread stored content (already in correct shape: id, name, args for tool_call; call_id, content, isError for tool_result)
      return { ...base, ...(msg.content as Record<string, unknown>) };

    default:
      // For assistant, user, etc - use content field as-is
      return { ...base, content: msg.content };
  }
}

// =============================================================================
// Types
// =============================================================================

export interface WebSocketHandlerOptions {
  storage: Storage;
  /** Whether auth is enabled (default: true) */
  authEnabled?: boolean;
}

interface Connection {
  ws: WebSocket;
  channelId: string;
  /** The space this connection belongs to */
  spaceId: string;
}

// =============================================================================
// WebSocket Handler
// =============================================================================

export function createWebSocketHandler(options: WebSocketHandlerOptions) {
  const { storage, authEnabled = true } = options;

  // Track connections by channel
  const connectionsByChannel: Map<string, Set<Connection>> = new Map();

  /**
   * Handle new WebSocket connection.
   * Validates session and extracts spaceId before allowing connection.
   */
  async function handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    // Verify session first (if auth is enabled)
    let spaceId = 'default';

    if (authEnabled) {
      const session = await verifySession(req);
      if (!session) {
        ws.close(4001, 'Unauthorized: No valid session');
        console.log('[WS] Connection rejected: no valid session');
        return;
      }
      spaceId = session.spaceId;
    }

    // Extract channel ID from URL path: /channels/:channelId/stream
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathParts = url.pathname.split('/').filter(Boolean);

    // Validate path format
    if (pathParts[0] !== 'channels' || !pathParts[1] || pathParts[2] !== 'stream') {
      ws.close(4000, 'Invalid path. Use /channels/:channelId/stream');
      return;
    }

    const channelId = pathParts[1];

    // Verify channel belongs to user's space (if auth is enabled)
    if (authEnabled) {
      const channel = await storage.getChannel(spaceId, channelId);
      if (!channel) {
        ws.close(4003, 'Forbidden: Channel not in your space');
        console.log(`[WS] Connection rejected: channel ${channelId} not in space ${spaceId}`);
        return;
      }
    }

    const connection: Connection = { ws, channelId, spaceId };

    // Add to connection set
    let connections = connectionsByChannel.get(channelId);
    if (!connections) {
      connections = new Set();
      connectionsByChannel.set(channelId, connections);
    }
    connections.add(connection);

    console.log(`[WS] Client connected to channel ${channelId} (space: ${spaceId})`);

    // Handle incoming messages (Tymbal frames)
    ws.on('message', async (data) => {
      try {
        const message = data.toString();
        const frame = parseFrame(message);

        if (!frame) {
          console.warn('[WS] Invalid frame:', message);
          return;
        }

        // Handle sync request
        if ('request' in frame && frame.request === 'sync') {
          await handleSync(ws, spaceId, channelId, frame as SyncRequest);
        }
      } catch (err) {
        console.error('[WS] Error handling message:', err);
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      connections?.delete(connection);
      if (connections?.size === 0) {
        connectionsByChannel.delete(channelId);
      }
      console.log(`[WS] Client disconnected from channel ${channelId}`);
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err);
    });
  }

  /**
   * Handle sync request - send historical messages.
   */
  async function handleSync(
    ws: WebSocket,
    spaceId: string,
    channelId: string,
    request: SyncRequest
  ): Promise<void> {
    const messages = await storage.getMessages(spaceId, channelId, {
      since: request.since,
    });

    for (const msg of messages) {
      if (msg.isComplete) {
        const frameValue = buildFrameValue(msg);
        const frame = setFrame(msg.id, frameValue, msg.timestamp);
        ws.send(serializeFrameLine(frame));
      }
    }
  }

  /**
   * Broadcast a frame to all connections in a channel.
   */
  async function broadcast(channelId: string, frame: string): Promise<void> {
    const connections = connectionsByChannel.get(channelId);
    if (!connections) return;

    const frameWithNewline = frame.endsWith('\n') ? frame : frame + '\n';

    for (const conn of connections) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        conn.ws.send(frameWithNewline);
      }
    }
  }

  /**
   * Check if a channel has active listeners.
   */
  function hasListeners(channelId: string): boolean {
    const connections = connectionsByChannel.get(channelId);
    return (connections?.size ?? 0) > 0;
  }

  /**
   * Get connection count for a channel.
   */
  function getConnectionCount(channelId: string): number {
    return connectionsByChannel.get(channelId)?.size ?? 0;
  }

  return {
    handleConnection,
    broadcast,
    hasListeners,
    getConnectionCount,
  };
}

// =============================================================================
// WebSocket Server Setup
// =============================================================================

export interface CreateWssOptions {
  server: import('node:http').Server;
  storage: Storage;
  /** Whether auth is enabled (default: true) */
  authEnabled?: boolean;
}

export function createWss(options: CreateWssOptions) {
  const { server, storage, authEnabled = true } = options;
  const handler = createWebSocketHandler({ storage, authEnabled });

  const wss = new WebSocketServer({
    server,
    path: undefined, // Accept all paths, filter in handleConnection
  });

  wss.on('connection', (ws, req) => {
    handler.handleConnection(ws, req);
  });

  return {
    wss,
    broadcast: handler.broadcast,
    hasListeners: handler.hasListeners,
    getConnectionCount: handler.getConnectionCount,
  };
}
