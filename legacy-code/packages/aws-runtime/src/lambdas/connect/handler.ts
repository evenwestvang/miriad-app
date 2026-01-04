/**
 * WebSocket $connect Handler
 *
 * Registers a new WebSocket connection for a thread.
 * The threadId is passed as a query parameter: ?threadId=xxx
 */

import type { APIGatewayProxyHandler } from "aws-lambda";
import { registerConnection } from "../../shared/db.js";

interface WebSocketConnectEvent {
  requestContext: {
    connectionId: string;
    routeKey: string;
  };
  queryStringParameters?: {
    threadId?: string;
  };
}

export const handler: APIGatewayProxyHandler = async (event) => {
  const wsEvent = event as unknown as WebSocketConnectEvent;
  const connectionId = wsEvent.requestContext.connectionId;
  const threadId = wsEvent.queryStringParameters?.threadId;

  if (!threadId) {
    return {
      statusCode: 400,
      body: "Missing threadId query parameter",
    };
  }

  console.log(`Connection ${connectionId} joining thread ${threadId}`);

  // Register connection (even if thread doesn't exist yet)
  await registerConnection(threadId, connectionId);

  return { statusCode: 200, body: "Connected" };
};
