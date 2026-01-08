/**
 * AWS Lambda WebSocket Handlers
 *
 * Handles API Gateway WebSocket events for real-time streaming.
 * Uses DynamoDB to persist connection state across Lambda invocations.
 *
 * Routes:
 * - $connect: Store connection in DynamoDB, send initial sync
 * - $disconnect: Remove connection from DynamoDB
 * - $default: Handle Tymbal frames (sync requests, etc.)
 */

import type {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketEventV2,
} from 'aws-lambda';
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
  GetItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { createPostgresStorage } from '@cast/storage';
import { parseFrame, isSyncRequest } from '@cast/core';

// =============================================================================
// Configuration
// =============================================================================

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT!;
const PLANETSCALE_URL = process.env.PLANETSCALE_URL!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// Cache for channel -> spaceId lookups (survives across Lambda invocations in warm container)
const channelSpaceCache = new Map<string, string>();
const TTL_SECONDS = 24 * 60 * 60; // 24 hours

// =============================================================================
// Clients (reused across invocations)
// =============================================================================

const dynamodb = new DynamoDBClient({ region: REGION });

// API Gateway Management client - endpoint URL without wss:// prefix
function getApiGatewayClient(endpoint: string) {
  // Convert wss://abc.execute-api.region.amazonaws.com/stage to https://abc.execute-api.region.amazonaws.com/stage
  const httpsEndpoint = endpoint.replace('wss://', 'https://');
  return new ApiGatewayManagementApiClient({
    region: REGION,
    endpoint: httpsEndpoint,
  });
}

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

// =============================================================================
// DynamoDB Helpers
// =============================================================================

interface ConnectionRecord {
  connectionId: string;
  channelId: string;
  connectedAt: string;
  ttl: number;
}

async function saveConnection(record: ConnectionRecord): Promise<void> {
  await dynamodb.send(
    new PutItemCommand({
      TableName: CONNECTIONS_TABLE,
      Item: {
        connectionId: { S: record.connectionId },
        channelId: { S: record.channelId },
        connectedAt: { S: record.connectedAt },
        ttl: { N: record.ttl.toString() },
      },
    })
  );
}

async function deleteConnection(connectionId: string): Promise<void> {
  await dynamodb.send(
    new DeleteItemCommand({
      TableName: CONNECTIONS_TABLE,
      Key: {
        connectionId: { S: connectionId },
      },
    })
  );
}

async function getConnection(connectionId: string): Promise<ConnectionRecord | null> {
  const result = await dynamodb.send(
    new GetItemCommand({
      TableName: CONNECTIONS_TABLE,
      Key: {
        connectionId: { S: connectionId },
      },
    })
  );

  if (!result.Item) return null;

  return {
    connectionId: result.Item.connectionId?.S ?? connectionId,
    channelId: result.Item.channelId?.S ?? '',
    connectedAt: result.Item.connectedAt?.S ?? new Date().toISOString(),
    ttl: parseInt(result.Item.ttl?.N ?? '0', 10),
  };
}

async function getChannelConnections(channelId: string): Promise<ConnectionRecord[]> {
  const result = await dynamodb.send(
    new QueryCommand({
      TableName: CONNECTIONS_TABLE,
      IndexName: 'ChannelIndex',
      KeyConditionExpression: 'channelId = :channelId',
      ExpressionAttributeValues: {
        ':channelId': { S: channelId },
      },
    })
  );

  if (!result.Items) return [];

  return result.Items.map((item) => ({
    connectionId: item.connectionId?.S ?? '',
    channelId: item.channelId?.S ?? channelId,
    connectedAt: item.connectedAt?.S ?? new Date().toISOString(),
    ttl: parseInt(item.ttl?.N ?? '0', 10),
  }));
}

// =============================================================================
// WebSocket Helpers
// =============================================================================

async function sendToConnection(
  apiGateway: ApiGatewayManagementApiClient,
  connectionId: string,
  data: string
): Promise<boolean> {
  try {
    await apiGateway.send(
      new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: new TextEncoder().encode(data),
      })
    );
    return true;
  } catch (error) {
    if (error instanceof GoneException) {
      // Connection is stale, clean it up
      console.log(`[WebSocket] Connection ${connectionId} is gone, removing`);
      await deleteConnection(connectionId);
      return false;
    }
    console.error(`[WebSocket] Error sending to ${connectionId}:`, error);
    throw error;
  }
}

// =============================================================================
// $connect Handler
// =============================================================================

export async function connectHandler(
  event: APIGatewayProxyWebsocketEventV2
): Promise<APIGatewayProxyResultV2> {
  const connectionId = event.requestContext.connectionId;
  const channelId = event.queryStringParameters?.channelId;

  console.log(`[WebSocket] $connect: ${connectionId}, channelId: ${channelId}`);

  if (!channelId) {
    console.error('[WebSocket] Missing channelId query parameter');
    return {
      statusCode: 400,
      body: 'Missing channelId query parameter',
    };
  }

  try {
    // Save connection to DynamoDB
    const now = new Date();
    await saveConnection({
      connectionId,
      channelId,
      connectedAt: now.toISOString(),
      ttl: Math.floor(now.getTime() / 1000) + TTL_SECONDS,
    });

    console.log(`[WebSocket] Connection ${connectionId} saved for channel ${channelId}`);

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
    await deleteConnection(connectionId);
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
    // Get connection info
    const connection = await getConnection(connectionId);
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
      console.log(`[WebSocket] Sync request from ${connectionId}, since: ${frame.since}`);

      const storage = await getStorage();

      // Look up spaceId from channel (with caching)
      let spaceId = channelSpaceCache.get(connection.channelId);
      if (!spaceId) {
        const channel = await storage.getChannelById(connection.channelId);
        if (!channel) {
          console.error(`[WebSocket] Channel ${connection.channelId} not found`);
          return { statusCode: 404, body: 'Channel not found' };
        }
        spaceId = channel.spaceId;
        channelSpaceCache.set(connection.channelId, spaceId);
        console.log(`[WebSocket] Cached spaceId ${spaceId} for channel ${connection.channelId}`);
      }

      const messages = await storage.getMessages(spaceId, connection.channelId, {
        since: frame.since,
        limit: 100,
      });

      // Build NDJSON payload with all messages + sync response in one send
      // This avoids N sequential API Gateway calls (major latency improvement)
      const frames = messages.map(msg => JSON.stringify({
        i: msg.id,
        t: msg.timestamp,
        v: {
          type: msg.type,
          sender: msg.sender,
          senderType: msg.senderType,
          content: msg.content,
        },
      }));

      // Add sync response at the end
      frames.push(JSON.stringify({ sync: new Date().toISOString() }));

      // Send all frames as single NDJSON payload
      const apiGateway = getApiGatewayClient(WEBSOCKET_ENDPOINT);
      await sendToConnection(apiGateway, connectionId, frames.join('\n'));

      console.log(`[WebSocket] Sent ${messages.length} messages + sync response to ${connectionId}`);
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
  frame: string,
  endpoint: string = WEBSOCKET_ENDPOINT
): Promise<void> {
  const connections = await getChannelConnections(channelId);
  if (connections.length === 0) {
    console.log(`[Broadcast] No connections for channel ${channelId}`);
    return;
  }

  const apiGateway = getApiGatewayClient(endpoint);
  const results = await Promise.allSettled(
    connections.map((conn) => sendToConnection(apiGateway, conn.connectionId, frame))
  );

  const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value).length;
  console.log(`[Broadcast] Sent to ${succeeded}/${connections.length} connections in ${channelId}`);
}
