/**
 * WebSocket Broadcasting
 *
 * Send Tymbal frames to connected clients via API Gateway Management API.
 */

import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { getConnections, removeConnection } from "./db.js";

// Lazy-initialized client
let _apiGwClient: ApiGatewayManagementApiClient | null = null;

function getApiGwClient(): ApiGatewayManagementApiClient {
  if (!_apiGwClient) {
    _apiGwClient = new ApiGatewayManagementApiClient({
      endpoint: `https://${process.env.WEBSOCKET_ENDPOINT}`,
    });
  }
  return _apiGwClient;
}

export interface BroadcastResult {
  sent: number;
  failed: number;
}

/**
 * Broadcast a Tymbal frame to all connections for a thread
 */
export async function broadcast(
  threadId: string,
  frame: string
): Promise<BroadcastResult> {
  const connections = await getConnections(threadId);
  console.log(`[Broadcast] Thread ${threadId}: ${connections.length} connections`);

  if (connections.length === 0) {
    return { sent: 0, failed: 0 };
  }

  const client = getApiGwClient();
  const payload = frame.endsWith("\n") ? frame : frame + "\n";
  console.log(`[Broadcast] Sending to ${connections.length} connections, payload length: ${payload.length}`);

  const results = await Promise.allSettled(
    connections.map(async (conn) => {
      try {
        console.log(`[Broadcast] Posting to connection ${conn.connectionId}`);
        await client.send(
          new PostToConnectionCommand({
            ConnectionId: conn.connectionId,
            Data: Buffer.from(payload),
          })
        );
        console.log(`[Broadcast] Successfully sent to ${conn.connectionId}`);
      } catch (error) {
        // Check if connection is stale (410 Gone)
        const httpStatus =
          (error as { statusCode?: number }).statusCode ??
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode;

        console.error(`[Broadcast] Error sending to ${conn.connectionId}: ${httpStatus}`, error);

        if (httpStatus === 410) {
          // Connection is stale, remove it
          await removeConnection(threadId, conn.connectionId);
        }
        throw error;
      }
    })
  );

  const result = {
    sent: results.filter((r) => r.status === "fulfilled").length,
    failed: results.filter((r) => r.status === "rejected").length,
  };
  console.log(`[Broadcast] Result: sent=${result.sent}, failed=${result.failed}`);

  return result;
}

/**
 * Check if a thread has any active listeners
 */
export async function hasListeners(threadId: string): Promise<boolean> {
  const connections = await getConnections(threadId);
  return connections.length > 0;
}

/**
 * Send a frame to a specific connection
 */
export async function sendToConnection(
  connectionId: string,
  frame: string
): Promise<void> {
  const client = getApiGwClient();
  const payload = frame.endsWith("\n") ? frame : frame + "\n";

  await client.send(
    new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(payload),
    })
  );
}
