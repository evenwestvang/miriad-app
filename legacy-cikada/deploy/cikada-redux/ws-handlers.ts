/**
 * Channel WebSocket Handlers
 *
 * Handles WebSocket connections for channel subscriptions.
 * Supports both channel mode (channelId param) and legacy thread mode (threadId param).
 */

import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';
import { jwtVerify } from 'jose';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { createDynamoDbStorage, type Storage } from '@cikada/storage';
import {
  registerChannelConnection,
  removeChannelConnection,
} from './channel-broadcast.js';
import { tymbal } from '@cikada/reactive-agent';

// =============================================================================
// Constants
// =============================================================================

const COOKIE_NAME = 'cikada-session';
const DEFAULT_SECRET = 'cikada-dev-secret-change-in-production';

// =============================================================================
// Singletons (lazy-initialized)
// =============================================================================

let storageInstance: Storage | null = null;
let apiGwClient: ApiGatewayManagementApiClient | null = null;

function getStorage(): Storage {
  if (!storageInstance) {
    storageInstance = createDynamoDbStorage({
      region: process.env.AWS_REGION || 'us-east-1',
      tableName: process.env.MAIN_TABLE!,
    });
  }
  return storageInstance;
}

function getApiGwClient(): ApiGatewayManagementApiClient {
  if (!apiGwClient) {
    const endpoint = process.env.WEBSOCKET_ENDPOINT;
    if (!endpoint) {
      throw new Error('WEBSOCKET_ENDPOINT environment variable not set');
    }
    apiGwClient = new ApiGatewayManagementApiClient({
      endpoint: endpoint.startsWith('https://') ? endpoint : `https://${endpoint}`,
    });
  }
  return apiGwClient;
}

async function sendToConnection(connectionId: string, frame: string): Promise<void> {
  const payload = frame.endsWith('\n') ? frame : frame + '\n';
  await getApiGwClient().send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(payload),
    })
  );
}

// =============================================================================
// Auth Helpers
// =============================================================================

function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.warn('[WS] WARNING: SESSION_SECRET not set, using insecure default');
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

async function verifySession(cookieHeader: string | undefined): Promise<SessionPayload | null> {
  const cookies = parseCookies(cookieHeader);
  const token = cookies[COOKIE_NAME];

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getSecret());

    if (!payload.sub || !payload.spaceId) {
      return null;
    }

    return {
      userId: payload.sub,
      spaceId: payload.spaceId as string,
    };
  } catch {
    return null;
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * $connect handler for channel WebSocket connections.
 *
 * Query parameters:
 * - channelId: Subscribe to a channel
 * - threadId: Legacy thread mode
 *
 * IMPORTANT: Browser WebSocket connections don't reliably send cookies cross-origin.
 * We accept all connections here (return 200), then authenticate in the sync handler.
 * The connection is just a pipe until authenticated — no messages are sent/received
 * until the client calls sync with valid credentials.
 */
export async function channelConnectHandler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  const queryParams = event.queryStringParameters || {};

  console.log(`[WS Connect] connectionId=${connectionId}, params=${JSON.stringify(queryParams)}`);

  // Channel mode: channelId provided
  if (queryParams.channelId) {
    const channelId = queryParams.channelId;
    console.log(`[WS Connect] Channel mode: channelId=${channelId} (auth deferred to sync)`);
    // Don't register yet — wait for sync handler to authenticate
    return { statusCode: 200, body: 'Connected (pending auth)' };
  }

  // Legacy thread mode: threadId provided (no auth required)
  if (queryParams.threadId) {
    const threadId = queryParams.threadId;
    console.log(`[WS Connect] Thread mode: threadId=${threadId}`);
    // Thread mode doesn't require auth
    return { statusCode: 200, body: 'Connected to thread' };
  }

  // No valid mode specified — still accept to allow error message
  console.log(`[WS Connect] No channelId or threadId provided`);
  return { statusCode: 200, body: 'Connected (no channel)' };
}

/**
 * $disconnect handler for channel WebSocket connections.
 *
 * Cleans up the connection from all subscribed channels.
 * Note: We don't have the channelId here, so we'd need to track it
 * or query by connectionId. For now, the TTL will clean up stale connections.
 */
export async function channelDisconnectHandler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;

  console.log(`[WS Disconnect] connectionId=${connectionId}`);

  // Note: We can't easily clean up channel connections here because
  // we don't store the reverse mapping (connectionId -> channel).
  // The TTL and stale connection detection in broadcastToChannel handle cleanup.
  // For a production system, we'd want to store the reverse mapping.

  return { statusCode: 200, body: 'Disconnected' };
}

/**
 * Verify session from JWT token (passed in message body).
 * Used for WebSocket auth where cookies aren't available.
 */
async function verifyToken(token: string | undefined): Promise<SessionPayload | null> {
  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getSecret());

    if (!payload.sub || !payload.spaceId) {
      return null;
    }

    return {
      userId: payload.sub,
      spaceId: payload.spaceId as string,
    };
  } catch {
    return null;
  }
}

/**
 * Channel sync handler - authenticates and registers the connection.
 *
 * This handles the "sync" route for channel connections.
 * The client sends { request: "sync", channelId: "xxx", token: "jwt..." } after connecting.
 *
 * Authentication happens here (not on $connect) because browser WebSocket connections
 * don't reliably send cookies cross-origin. The token is the same JWT stored in
 * the cikada-session cookie — the frontend reads it and passes it explicitly.
 */
export async function channelSyncHandler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;

  console.log(`[WS Sync] connectionId=${connectionId}`);

  // Parse the request body
  let body: { request?: string; since?: string; channelId?: string; token?: string } = {};
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return { statusCode: 400, body: 'Invalid JSON' };
  }

  if (body.request !== 'sync') {
    return { statusCode: 400, body: 'Unknown request' };
  }

  // For channel sync, we need to know which channel to sync
  const channelId = body.channelId;
  if (!channelId) {
    console.log('[WS Sync] No channelId in sync request');
    return { statusCode: 400, body: 'Missing channelId in sync request' };
  }

  // Authenticate using token from message body
  // Try token first (explicit), then fall back to cookie (same-origin)
  let session = await verifyToken(body.token);
  if (!session) {
    const cookieHeader = event.headers?.cookie || event.headers?.Cookie;
    session = await verifySession(cookieHeader);
  }

  if (!session) {
    console.log(`[WS Sync] Auth failed for channel ${channelId}`);
    return { statusCode: 401, body: 'Unauthorized: valid token required' };
  }

  console.log(`[WS Sync] Auth successful, registering connection for space=${session.spaceId}, channel=${channelId}`);

  // Now register the connection (deferred from $connect)
  await registerChannelConnection(session.spaceId, channelId, connectionId);

  console.log(`[WS Sync] Connection registered, syncing channel ${channelId}`);

  // Fetch message history from storage
  const storage = getStorage();
  const messages = await storage.getMessages(session.spaceId, channelId, {
    since: body.since,
    limit: 100,
  });

  console.log(`[WS Sync] Sending ${messages.length} messages to ${connectionId}`);

  // Send each message as a Tymbal Set frame
  for (const msg of messages) {
    const frame = tymbal.set(msg.id, {
      type: msg.type,
      sender: msg.sender,
      senderType: msg.senderType,
      content: msg.content,
      timestamp: msg.timestamp,
      mentions: msg.mentions,
    });
    await sendToConnection(connectionId, frame);
  }

  // Send sync acknowledgment with latest timestamp
  const latestTimestamp =
    messages.length > 0
      ? messages[messages.length - 1].timestamp
      : new Date().toISOString();
  await sendToConnection(connectionId, tymbal.sync(latestTimestamp));

  console.log(`[WS Sync] Sync complete for channel ${channelId}`);

  return { statusCode: 200, body: 'Synced' };
}
