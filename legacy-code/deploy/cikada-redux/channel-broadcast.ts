/**
 * Channel WebSocket Broadcasting
 *
 * Broadcasts Tymbal frames to WebSocket connections subscribed to a channel.
 * Uses the existing ConnectionsTable but with channel-based keys.
 *
 * Key format: CHANNEL#{spaceId}#{channelId}
 * This allows reusing the thread-based infrastructure for channels.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  DeleteCommand,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from "@aws-sdk/client-apigatewaymanagementapi";

// =============================================================================
// Types
// =============================================================================

export interface ChannelConnection {
  /** Composite key: CHANNEL#{spaceId}#{channelId} */
  subscriptionKey: string;
  /** WebSocket connection ID */
  connectionId: string;
  /** When the connection was registered */
  connectedAt: string;
  /** TTL for automatic cleanup (epoch seconds) */
  ttl: number;
  /** Space ID (for reference) */
  spaceId: string;
  /** Channel ID (for reference) */
  channelId: string;
}

export interface BroadcastResult {
  /** Number of connections successfully sent to */
  sent: number;
  /** Number of connections that failed (and were cleaned up) */
  failed: number;
}

// =============================================================================
// Clients (lazy-initialized)
// =============================================================================

let _docClient: DynamoDBDocumentClient | null = null;
let _apiGwClient: ApiGatewayManagementApiClient | null = null;

function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    const client = new DynamoDBClient({});
    _docClient = DynamoDBDocumentClient.from(client);
  }
  return _docClient;
}

function getApiGwClient(): ApiGatewayManagementApiClient {
  if (!_apiGwClient) {
    const endpoint = process.env.WEBSOCKET_ENDPOINT;
    if (!endpoint) {
      throw new Error("WEBSOCKET_ENDPOINT environment variable not set");
    }
    _apiGwClient = new ApiGatewayManagementApiClient({
      endpoint: endpoint.startsWith("https://") ? endpoint : `https://${endpoint}`,
    });
  }
  return _apiGwClient;
}

function getConnectionsTable(): string {
  const table = process.env.CONNECTIONS_TABLE;
  if (!table) {
    throw new Error("CONNECTIONS_TABLE environment variable not set");
  }
  return table;
}

// =============================================================================
// Key Utilities
// =============================================================================

/**
 * Create a subscription key for a channel.
 */
function makeChannelKey(spaceId: string, channelId: string): string {
  return `CHANNEL#${spaceId}#${channelId}`;
}

// =============================================================================
// Connection Management
// =============================================================================

/**
 * Register a WebSocket connection for a channel.
 */
export async function registerChannelConnection(
  spaceId: string,
  channelId: string,
  connectionId: string
): Promise<void> {
  const subscriptionKey = makeChannelKey(spaceId, channelId);
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24h TTL

  await getDocClient().send(
    new PutCommand({
      TableName: getConnectionsTable(),
      Item: {
        // Use threadId column for subscription key (reusing existing table schema)
        threadId: subscriptionKey,
        connectionId,
        connectedAt: new Date().toISOString(),
        ttl,
        // Store additional metadata for debugging/queries
        spaceId,
        channelId,
      },
    })
  );

  console.log(
    `[ChannelBroadcast] Registered connection ${connectionId} for ${subscriptionKey}`
  );
}

/**
 * Remove a WebSocket connection from a channel.
 */
export async function removeChannelConnection(
  spaceId: string,
  channelId: string,
  connectionId: string
): Promise<void> {
  const subscriptionKey = makeChannelKey(spaceId, channelId);

  await getDocClient().send(
    new DeleteCommand({
      TableName: getConnectionsTable(),
      Key: {
        threadId: subscriptionKey,
        connectionId,
      },
    })
  );

  console.log(
    `[ChannelBroadcast] Removed connection ${connectionId} from ${subscriptionKey}`
  );
}

/**
 * Get all connections for a channel.
 */
export async function getChannelConnections(
  spaceId: string,
  channelId: string
): Promise<ChannelConnection[]> {
  const subscriptionKey = makeChannelKey(spaceId, channelId);

  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getConnectionsTable(),
      KeyConditionExpression: "threadId = :key",
      ExpressionAttributeValues: {
        ":key": subscriptionKey,
      },
    })
  );

  return (result.Items || []).map((item) => ({
    subscriptionKey: item.threadId as string,
    connectionId: item.connectionId as string,
    connectedAt: item.connectedAt as string,
    ttl: item.ttl as number,
    spaceId: item.spaceId as string,
    channelId: item.channelId as string,
  }));
}

// =============================================================================
// Broadcasting
// =============================================================================

/**
 * Broadcast a Tymbal frame to all connections for a channel.
 * Handles stale connections by removing them from the table.
 */
export async function broadcastToChannel(
  spaceId: string,
  channelId: string,
  frame: string
): Promise<BroadcastResult> {
  const connections = await getChannelConnections(spaceId, channelId);

  console.log(
    `[ChannelBroadcast] Broadcasting to ${connections.length} connections in ${spaceId}/${channelId}`
  );

  if (connections.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const client = getApiGwClient();
  const payload = frame.endsWith("\n") ? frame : frame + "\n";

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      try {
        await client.send(
          new PostToConnectionCommand({
            ConnectionId: conn.connectionId,
            Data: Buffer.from(payload),
          })
        );
        console.log(
          `[ChannelBroadcast] Sent to connection ${conn.connectionId}`
        );
      } catch (error) {
        // Check if connection is stale (410 Gone)
        if (error instanceof GoneException) {
          console.log(
            `[ChannelBroadcast] Connection ${conn.connectionId} is stale, removing`
          );
          await removeChannelConnection(spaceId, channelId, conn.connectionId);
        } else {
          // Check for 410 status in error metadata
          const httpStatus =
            (error as { statusCode?: number }).statusCode ??
            (error as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode;

          if (httpStatus === 410) {
            console.log(
              `[ChannelBroadcast] Connection ${conn.connectionId} returned 410, removing`
            );
            await removeChannelConnection(spaceId, channelId, conn.connectionId);
          } else {
            console.error(
              `[ChannelBroadcast] Error sending to ${conn.connectionId}:`,
              error
            );
          }
        }
        throw error;
      }
    })
  );

  const result = {
    sent: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };

  console.log(
    `[ChannelBroadcast] Result: sent=${result.sent}, failed=${result.failed}`
  );

  return result;
}

/**
 * Check if a channel has any active listeners.
 */
export async function hasChannelListeners(
  spaceId: string,
  channelId: string
): Promise<boolean> {
  const connections = await getChannelConnections(spaceId, channelId);
  return connections.length > 0;
}

/**
 * Create a broadcast function bound to a specific channel.
 * This is the interface expected by the reactive handler.
 */
export function createChannelBroadcaster(
  spaceId: string,
  channelId: string
): (frame: string) => Promise<void> {
  return async (frame: string) => {
    await broadcastToChannel(spaceId, channelId, frame);
  };
}
