/**
 * AWS Lambda WebSocket Handlers
 *
 * Handles API Gateway WebSocket events for real-time streaming.
 * Uses PostgresConnectionManager for unified connection state management.
 *
 * Routes:
 * - $connect: Store connection with '__pending__' channelId
 * - $disconnect: Remove connection from Postgres
 * - $default: Handle Tymbal frames (sync requests trigger channel assignment)
 */

import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';
import { createPostgresStorage } from '@cast/storage';
import { parseFrame, isSyncRequest } from '@cast/core';
import {
  createPostgresConnectionManager,
  ApiGatewaySender,
  type PostgresConnectionManager,
} from '@cast/server/websocket';

// =============================================================================
// Configuration
// =============================================================================

const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT!;
const PLANETSCALE_URL = process.env.PLANETSCALE_URL!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// Cache for channel -> spaceId lookups (survives across Lambda invocations in warm container)
const channelSpaceCache = new Map<string, string>();

// =============================================================================
// Shared Instances (reused across invocations in warm Lambda)
// =============================================================================

// Storage (lazy init)
let storage: ReturnType<typeof createPostgresStorage> | null = null;
let storageInitialized = false;

async function getStorage() {
  if (!storage) {
    storage = createPostgresStorage({ connectionString: PLANETSCALE_URL });
  }
  if (!storageInitialized) {
    await storage.initialize();
    storageInitialized = true;
  }
  return storage;
}

// Connection Manager (lazy init)
let connectionManager: PostgresConnectionManager | null = null;

async function getConnectionManager(): Promise<PostgresConnectionManager> {
  if (!connectionManager) {
    // Convert wss:// to https:// for API Gateway Management API
    const httpsEndpoint = WEBSOCKET_ENDPOINT.replace('wss://', 'https://');

    const sender = new ApiGatewaySender({
      endpoint: httpsEndpoint,
      region: REGION,
    });

    const storageInstance = await getStorage();

    connectionManager = createPostgresConnectionManager({
      storage: storageInstance,
      sender,
    });
  }
  return connectionManager;
}

// =============================================================================
// $connect Handler
// =============================================================================

export async function connectHandler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;

  // Channel will be set later via sync request
  // This matches local dev flow: connect first, auth/channel later
  const channelId = event.queryStringParameters?.channelId ?? '__pending__';

  console.log(`[WebSocket] $connect: ${connectionId}, channelId: ${channelId}`);

  try {
    const manager = await getConnectionManager();
    await manager.addConnection(connectionId, channelId);

    console.log(`[WebSocket] Connection ${connectionId} saved (channel: ${channelId})`);
    return { statusCode: 200, body: 'Connected' };
  } catch (error) {
    console.error('[WebSocket] Error in $connect:', error);
    return {
      statusCode: 500,
      body: 'Failed to connect',
    };
  }
}

// =============================================================================
// $disconnect Handler
// =============================================================================

export async function disconnectHandler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;

  console.log(`[WebSocket] $disconnect: ${connectionId}`);

  try {
    const manager = await getConnectionManager();
    await manager.removeConnection(connectionId);
    console.log(`[WebSocket] Connection ${connectionId} removed`);

    return { statusCode: 200, body: 'Disconnected' };
  } catch (error) {
    console.error('[WebSocket] Error in $disconnect:', error);
    // Still return 200 - disconnect is best-effort
    return { statusCode: 200, body: 'Disconnected' };
  }
}

// =============================================================================
// $default Handler
// =============================================================================

export async function defaultHandler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  const body = event.body ?? '';

  console.log(`[WebSocket] $default from ${connectionId}: ${body.substring(0, 100)}...`);

  try {
    const manager = await getConnectionManager();

    // Get connection info
    const connection = await manager.getConnection(connectionId);
    if (!connection) {
      console.error(`[WebSocket] Connection ${connectionId} not found`);
      return { statusCode: 400, body: 'Connection not found' };
    }

    // Parse the frame
    const frame = parseFrame(body);
    if (!frame) {
      console.warn(`[WebSocket] Invalid frame from ${connectionId}`);
      return { statusCode: 400, body: 'Invalid frame' };
    }

    // Handle sync requests
    if (isSyncRequest(frame)) {
      // Sync request may include channelId for channel switch
      const requestedChannelId = frame.channelId || connection.channelId;

      console.log(`[WebSocket] Sync request from ${connectionId}, channel: ${requestedChannelId}, since: ${frame.since}`);

      // Validate that channelId is not pending
      if (requestedChannelId === '__pending__') {
        console.error(`[WebSocket] No channelId in sync request from ${connectionId}`);
        await manager.send(connectionId, JSON.stringify({
          error: 'missing_channel',
          message: 'Sync request must include channelId'
        }));
        return { statusCode: 400, body: 'Missing channelId' };
      }

      const storage = await getStorage();

      // Look up channel and validate it exists
      let spaceId = channelSpaceCache.get(requestedChannelId);
      if (!spaceId) {
        const channel = await storage.getChannelById(requestedChannelId);
        if (!channel) {
          console.error(`[WebSocket] Channel ${requestedChannelId} not found`);
          await manager.send(connectionId, JSON.stringify({
            error: 'channel_not_found',
            message: 'Channel not found'
          }));
          return { statusCode: 404, body: 'Channel not found' };
        }
        spaceId = channel.spaceId;
        channelSpaceCache.set(requestedChannelId, spaceId);
        console.log(`[WebSocket] Cached spaceId ${spaceId} for channel ${requestedChannelId}`);
      }

      // Switch channel if different from current
      if (requestedChannelId !== connection.channelId) {
        await manager.switchChannel(connectionId, requestedChannelId);
        console.log(`[WebSocket] Switched ${connectionId} from ${connection.channelId} to ${requestedChannelId}`);
      }

      // Fetch messages
      const effectiveLimit = frame.limit ?? 25;
      const messages = await storage.getMessagesByChannelId(requestedChannelId, {
        since: frame.since,
        before: frame.before,
        limit: effectiveLimit,
        newestFirst: !frame.since && !frame.before,
      });

      // Build NDJSON payload with all messages + sync response
      const frames = messages.map(msg => {
        const metadata = msg.metadata as { method?: string } | undefined;
        let frameValue: Record<string, unknown> = {
          type: msg.type,
          content: msg.content,
          sender: msg.sender,
          senderType: msg.senderType,
          ...(metadata?.method && { method: metadata.method }),
        };

        // Parse tool_call and tool_result content
        if (msg.type === 'tool_call' || msg.type === 'tool_result') {
          try {
            const parsed = typeof msg.content === 'string'
              ? JSON.parse(msg.content)
              : msg.content;

            if (msg.type === 'tool_call') {
              frameValue = {
                type: 'tool_call',
                sender: parsed.sender || msg.sender,
                senderType: parsed.senderType || msg.senderType,
                toolCallId: parsed.toolCallId,
                name: parsed.name,
                args: parsed.args,
              };
            } else if (msg.type === 'tool_result') {
              frameValue = {
                type: 'tool_result',
                sender: parsed.sender || msg.sender,
                senderType: parsed.senderType || msg.senderType,
                toolCallId: parsed.toolCallId,
                content: parsed.content,
                isError: parsed.isError,
              };
            }
          } catch {
            console.warn(`[WebSocket] Failed to parse ${msg.type} content:`, msg.id);
          }
        }

        return JSON.stringify({
          i: msg.id,
          t: msg.timestamp,
          v: frameValue,
          c: requestedChannelId,
        });
      });

      // Add sync response at the end
      const hasMore = messages.length >= effectiveLimit;
      frames.push(JSON.stringify({
        sync: new Date().toISOString(),
        hasMore,
        oldestId: messages.length > 0 ? messages[0].id : undefined,
      }));

      // Send all frames as single NDJSON payload
      await manager.send(connectionId, frames.join('\n'));

      console.log(`[WebSocket] Sent ${messages.length} messages + sync to ${connectionId}`);
      return { statusCode: 200, body: 'Synced' };
    }

    // Other frames are echoed back (for now)
    console.log(`[WebSocket] Unhandled frame type from ${connectionId}`);
    return { statusCode: 200, body: 'OK' };
  } catch (error) {
    console.error('[WebSocket] Error in $default:', error);
    return { statusCode: 500, body: 'Internal error' };
  }
}

// =============================================================================
// Broadcast Helper (for use by HTTP API Lambda)
// =============================================================================

/**
 * Broadcast a Tymbal frame to all connections in a channel.
 * This function is called from the HTTP API Lambda when agents send frames.
 */
export async function broadcastToChannel(
  channelId: string,
  frame: string
): Promise<void> {
  const manager = await getConnectionManager();
  await manager.broadcast(channelId, frame);
}
