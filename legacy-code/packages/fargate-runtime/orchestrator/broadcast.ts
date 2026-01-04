/**
 * Tymbal Broadcasting for Orchestrator
 *
 * Broadcasts status messages to connected WebSocket clients.
 * Used to notify frontend of container lifecycle events.
 */

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";

// Lazy-initialized clients
let _apiGwClient: ApiGatewayManagementApiClient | null = null;
let _docClient: DynamoDBDocumentClient | null = null;

function getApiGwClient(): ApiGatewayManagementApiClient {
  if (!_apiGwClient) {
    const endpoint = process.env.WEBSOCKET_ENDPOINT;
    if (!endpoint) {
      throw new Error("WEBSOCKET_ENDPOINT not configured");
    }
    _apiGwClient = new ApiGatewayManagementApiClient({
      endpoint: `https://${endpoint}`,
    });
  }
  return _apiGwClient;
}

function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    const client = new DynamoDBClient({});
    _docClient = DynamoDBDocumentClient.from(client);
  }
  return _docClient;
}

const getConnectionsTable = () => process.env.CONNECTIONS_TABLE!;

// =============================================================================
// ULID Generation (simplified)
// =============================================================================

function generateUlid(): string {
  const timestamp = Date.now().toString(36).padStart(10, "0");
  const random = Math.random().toString(36).substring(2, 10);
  return `${timestamp}${random}`.toUpperCase();
}

// =============================================================================
// Tymbal Frame Helpers
// =============================================================================

export interface StatusFrame {
  i: string;
  t: string;
  v: {
    type: "status";
    content: "container_starting" | "container_ready" | "container_error";
  };
}

/**
 * Create a status frame in the format expected by the frontend:
 * { "i": "msgId", "t": "timestamp", "v": { "type": "status", "content": "container_starting" }}
 */
function createStatusFrame(
  status: "container_starting" | "container_ready" | "container_error"
): string {
  const frame: StatusFrame = {
    i: generateUlid(),
    t: new Date().toISOString(),
    v: {
      type: "status",
      content: status,
    },
  };
  return JSON.stringify(frame);
}

// =============================================================================
// Connection Lookup
// =============================================================================

interface Connection {
  threadId: string;
  connectionId: string;
}

async function getConnections(threadId: string): Promise<Connection[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getConnectionsTable(),
      KeyConditionExpression: "threadId = :tid",
      ExpressionAttributeValues: { ":tid": threadId },
    })
  );
  return (result.Items as Connection[]) ?? [];
}

// =============================================================================
// Broadcasting
// =============================================================================

export interface BroadcastResult {
  sent: number;
  failed: number;
}

/**
 * Broadcast a Tymbal frame to all connections for a thread
 */
async function broadcastFrame(
  threadId: string,
  frame: string
): Promise<BroadcastResult> {
  // Check if WebSocket endpoint is configured
  if (!process.env.WEBSOCKET_ENDPOINT) {
    console.log(`[Broadcast] WebSocket not configured, skipping broadcast`);
    return { sent: 0, failed: 0 };
  }

  const connections = await getConnections(threadId);
  console.log(`[Broadcast] Thread ${threadId}: ${connections.length} connections`);

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
      } catch (error) {
        console.error(`[Broadcast] Error sending to ${conn.connectionId}:`, error);
        throw error;
      }
    })
  );

  return {
    sent: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Broadcast container_starting status to connected clients
 */
export async function broadcastContainerStarting(
  threadId: string
): Promise<BroadcastResult> {
  console.log(`[Broadcast] Sending container_starting for ${threadId}`);
  const frame = createStatusFrame("container_starting");
  return broadcastFrame(threadId, frame);
}

/**
 * Broadcast container_ready status to connected clients
 */
export async function broadcastContainerReady(
  threadId: string
): Promise<BroadcastResult> {
  console.log(`[Broadcast] Sending container_ready for ${threadId}`);
  const frame = createStatusFrame("container_ready");
  return broadcastFrame(threadId, frame);
}

/**
 * Broadcast container_error status to connected clients
 */
export async function broadcastContainerError(
  threadId: string,
  _message?: string
): Promise<BroadcastResult> {
  console.log(`[Broadcast] Sending container_error for ${threadId}`);
  const frame = createStatusFrame("container_error");
  return broadcastFrame(threadId, frame);
}
