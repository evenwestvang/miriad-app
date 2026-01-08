/**
 * DynamoDB-backed Connection Manager for AWS Lambda
 *
 * Implements the ConnectionManager interface using:
 * - DynamoDB for connection state persistence
 * - API Gateway Management API for sending messages to WebSocket connections
 *
 * This replaces the in-memory connection manager for serverless deployments
 * where Lambda functions cannot hold WebSocket connections directly.
 */

import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from '@aws-sdk/client-apigatewaymanagementapi';
import type { ConnectionManager, ConnectionInfo, ConnectionManagerOptions } from './connection-manager.js';

// =============================================================================
// Types
// =============================================================================

export interface DynamoDBConnectionManagerOptions {
  /** DynamoDB table name for connections */
  tableName: string;
  /** API Gateway WebSocket endpoint URL (e.g., https://abc123.execute-api.us-east-1.amazonaws.com/stag) */
  apiGatewayEndpoint: string;
  /** AWS region */
  region?: string;
  /** TTL in seconds for connection records (default: 24 hours) */
  ttlSeconds?: number;
}

/**
 * Connection record stored in DynamoDB.
 * Note: We don't store the WebSocket instance since Lambda doesn't hold connections.
 */
interface DynamoDBConnectionRecord {
  connectionId: string;
  channelId: string;
  connectedAt: string;
  ttl: number;
  agentCallsign?: string;
  containerId?: string;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a DynamoDB-backed ConnectionManager for AWS Lambda deployments.
 *
 * Key differences from in-memory manager:
 * - No WebSocket instances (API Gateway owns the connections)
 * - broadcast() uses API Gateway Management API to POST to connections
 * - State persisted to DynamoDB with TTL for automatic cleanup
 */
export function createDynamoDBConnectionManager(
  options: DynamoDBConnectionManagerOptions
): ConnectionManager {
  const {
    tableName,
    apiGatewayEndpoint,
    region = process.env.AWS_REGION || 'us-east-1',
    ttlSeconds = 24 * 60 * 60, // 24 hours default
  } = options;

  const dynamodb = new DynamoDBClient({ region });
  const apiGateway = new ApiGatewayManagementApiClient({
    region,
    endpoint: apiGatewayEndpoint,
  });

  // -------------------------------------------------------------------------
  // Helper Functions
  // -------------------------------------------------------------------------

  async function saveConnection(record: DynamoDBConnectionRecord): Promise<void> {
    const item: Record<string, { S: string } | { N: string }> = {
      connectionId: { S: record.connectionId },
      channelId: { S: record.channelId },
      connectedAt: { S: record.connectedAt },
      ttl: { N: record.ttl.toString() },
    };

    if (record.agentCallsign) {
      item.agentCallsign = { S: record.agentCallsign };
    }
    if (record.containerId) {
      item.containerId = { S: record.containerId };
    }

    await dynamodb.send(
      new PutItemCommand({
        TableName: tableName,
        Item: item,
      })
    );
  }

  async function deleteConnection(connectionId: string): Promise<void> {
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: tableName,
        Key: {
          connectionId: { S: connectionId },
        },
      })
    );
  }

  async function getConnectionRecord(
    connectionId: string
  ): Promise<DynamoDBConnectionRecord | undefined> {
    const result = await dynamodb.send(
      new GetItemCommand({
        TableName: tableName,
        Key: {
          connectionId: { S: connectionId },
        },
      })
    );

    if (!result.Item) return undefined;

    return {
      connectionId: result.Item.connectionId?.S || connectionId,
      channelId: result.Item.channelId?.S || '',
      connectedAt: result.Item.connectedAt?.S || new Date().toISOString(),
      ttl: parseInt(result.Item.ttl?.N || '0', 10),
      agentCallsign: result.Item.agentCallsign?.S,
      containerId: result.Item.containerId?.S,
    };
  }

  async function getChannelConnectionRecords(
    channelId: string
  ): Promise<DynamoDBConnectionRecord[]> {
    // Query GSI on channelId
    const result = await dynamodb.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: 'ChannelIndex',
        KeyConditionExpression: 'channelId = :channelId',
        ExpressionAttributeValues: {
          ':channelId': { S: channelId },
        },
      })
    );

    if (!result.Items) return [];

    return result.Items.map((item) => ({
      connectionId: item.connectionId?.S || '',
      channelId: item.channelId?.S || channelId,
      connectedAt: item.connectedAt?.S || new Date().toISOString(),
      ttl: parseInt(item.ttl?.N || '0', 10),
      agentCallsign: item.agentCallsign?.S,
      containerId: item.containerId?.S,
    }));
  }

  async function postToConnection(connectionId: string, data: string): Promise<boolean> {
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
        console.log(`[DynamoDB ConnectionManager] Connection ${connectionId} is gone, removing`);
        await deleteConnection(connectionId);
        return false;
      }
      console.error(`[DynamoDB ConnectionManager] Error posting to ${connectionId}:`, error);
      throw error;
    }
  }

  /**
   * Convert DynamoDB record to ConnectionInfo.
   * Note: ws is a dummy object since we can't hold actual WebSocket instances in Lambda.
   */
  function recordToConnectionInfo(record: DynamoDBConnectionRecord): ConnectionInfo {
    return {
      id: record.connectionId,
      // @ts-expect-error - ws is not a real WebSocket in Lambda context
      ws: null, // Not available in Lambda - use API Gateway Management API
      channelId: record.channelId,
      agentCallsign: record.agentCallsign,
      containerId: record.containerId,
      connectedAt: new Date(record.connectedAt),
    };
  }

  // -------------------------------------------------------------------------
  // ConnectionManager Interface
  // -------------------------------------------------------------------------

  return {
    /**
     * Add a connection to DynamoDB.
     * Called from $connect Lambda handler.
     */
    addConnection(ws, channelId, opts = {}) {
      // In Lambda, we don't have a WebSocket instance - the connectionId comes from API Gateway
      // This method is called with the connectionId stored in the 'ws' parameter slot
      const connectionId = (ws as unknown as { connectionId: string }).connectionId || `conn_${Date.now()}`;
      const now = new Date();
      const record: DynamoDBConnectionRecord = {
        connectionId,
        channelId,
        connectedAt: now.toISOString(),
        ttl: Math.floor(now.getTime() / 1000) + ttlSeconds,
        agentCallsign: opts.agentCallsign,
        containerId: opts.containerId,
      };

      // Note: This is async but interface is sync - caller should await saveConnectionAsync
      saveConnection(record).catch((err) =>
        console.error('[DynamoDB ConnectionManager] Failed to save connection:', err)
      );

      return recordToConnectionInfo(record);
    },

    /**
     * Remove a connection from DynamoDB.
     * Called from $disconnect Lambda handler.
     */
    removeConnection(connectionId) {
      deleteConnection(connectionId).catch((err) =>
        console.error('[DynamoDB ConnectionManager] Failed to delete connection:', err)
      );
    },

    /**
     * Switch a connection to a different channel.
     * Updates the record in DynamoDB with the new channelId.
     */
    switchChannel(connectionId, newChannelId) {
      // For DynamoDB, we need to update the record async
      // This is a fire-and-forget update since interface is sync
      (async () => {
        try {
          const record = await getConnectionRecord(connectionId);
          if (record) {
            record.channelId = newChannelId;
            await saveConnection(record);
            console.log(`[DynamoDB ConnectionManager] Switched ${connectionId} to ${newChannelId}`);
          }
        } catch (err) {
          console.error('[DynamoDB ConnectionManager] Failed to switch channel:', err);
        }
      })();
      // Return undefined since we can't get sync result from DynamoDB
      return undefined;
    },

    /**
     * Get all connections for a channel.
     * Returns empty array - use async version getChannelConnectionsAsync instead.
     */
    getChannelConnections(channelId) {
      // Sync interface can't do DynamoDB query - return empty
      // Use getChannelConnectionsAsync for actual data
      console.warn('[DynamoDB ConnectionManager] getChannelConnections is sync but DynamoDB is async');
      return [];
    },

    /**
     * Get a connection by ID.
     * Returns undefined - use async version getConnectionAsync instead.
     */
    getConnection(connectionId) {
      console.warn('[DynamoDB ConnectionManager] getConnection is sync but DynamoDB is async');
      return undefined;
    },

    /**
     * Broadcast a frame to all connections in a channel.
     * Uses API Gateway Management API to POST to each connection.
     */
    async broadcast(channelId, frame) {
      const records = await getChannelConnectionRecords(channelId);

      const results = await Promise.allSettled(
        records.map((record) => postToConnection(record.connectionId, frame))
      );

      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        console.warn(
          `[DynamoDB ConnectionManager] Broadcast to ${channelId}: ${results.length - failures.length}/${results.length} succeeded`
        );
      }
    },

    /**
     * Send a frame to a specific connection.
     */
    async send(connectionId, frame) {
      const success = await postToConnection(connectionId, frame);
      if (!success) {
        throw new Error(`Connection ${connectionId} not found or stale`);
      }
    },

    /**
     * Get total connection count.
     * Returns 0 - would require full table scan.
     */
    getConnectionCount() {
      return 0; // Not efficiently queryable without scan
    },

    /**
     * Get connection count for a channel.
     * Returns 0 - use async version for actual count.
     */
    getChannelConnectionCount(channelId) {
      return 0; // Use async version
    },

    /**
     * Close all connections.
     * No-op for Lambda - connections are managed by API Gateway.
     */
    closeAll() {
      // No-op for Lambda
    },
  };
}

// =============================================================================
// Async Helper Functions (for Lambda handlers)
// =============================================================================

/**
 * Async version of addConnection for Lambda handlers.
 */
export async function addConnectionAsync(
  manager: ReturnType<typeof createDynamoDBConnectionManager>,
  connectionId: string,
  channelId: string,
  options: DynamoDBConnectionManagerOptions,
  opts?: { agentCallsign?: string; containerId?: string }
): Promise<void> {
  const {
    tableName,
    region = process.env.AWS_REGION || 'us-east-1',
    ttlSeconds = 24 * 60 * 60,
  } = options;

  const dynamodb = new DynamoDBClient({ region });
  const now = new Date();

  const item: Record<string, { S: string } | { N: string }> = {
    connectionId: { S: connectionId },
    channelId: { S: channelId },
    connectedAt: { S: now.toISOString() },
    ttl: { N: (Math.floor(now.getTime() / 1000) + ttlSeconds).toString() },
  };

  if (opts?.agentCallsign) {
    item.agentCallsign = { S: opts.agentCallsign };
  }
  if (opts?.containerId) {
    item.containerId = { S: opts.containerId };
  }

  await dynamodb.send(
    new PutItemCommand({
      TableName: tableName,
      Item: item,
    })
  );
}

/**
 * Async version of removeConnection for Lambda handlers.
 */
export async function removeConnectionAsync(
  connectionId: string,
  options: Pick<DynamoDBConnectionManagerOptions, 'tableName' | 'region'>
): Promise<void> {
  const { tableName, region = process.env.AWS_REGION || 'us-east-1' } = options;
  const dynamodb = new DynamoDBClient({ region });

  await dynamodb.send(
    new DeleteItemCommand({
      TableName: tableName,
      Key: {
        connectionId: { S: connectionId },
      },
    })
  );
}

/**
 * Get connection record for a connectionId.
 */
export async function getConnectionAsync(
  connectionId: string,
  options: Pick<DynamoDBConnectionManagerOptions, 'tableName' | 'region'>
): Promise<DynamoDBConnectionRecord | undefined> {
  const { tableName, region = process.env.AWS_REGION || 'us-east-1' } = options;
  const dynamodb = new DynamoDBClient({ region });

  const result = await dynamodb.send(
    new GetItemCommand({
      TableName: tableName,
      Key: {
        connectionId: { S: connectionId },
      },
    })
  );

  if (!result.Item) return undefined;

  return {
    connectionId: result.Item.connectionId?.S || connectionId,
    channelId: result.Item.channelId?.S || '',
    connectedAt: result.Item.connectedAt?.S || new Date().toISOString(),
    ttl: parseInt(result.Item.ttl?.N || '0', 10),
    agentCallsign: result.Item.agentCallsign?.S,
    containerId: result.Item.containerId?.S,
  };
}
