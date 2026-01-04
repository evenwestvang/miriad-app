/**
 * WebSocket $disconnect Handler
 *
 * Removes a WebSocket connection when it disconnects.
 */

import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { findConnectionByConnectionId, removeConnection } from "../../shared/db.js";

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;

  console.log(`Connection ${connectionId} disconnecting`);

  // Find and remove the connection
  const conn = await findConnectionByConnectionId(connectionId);
  if (conn) {
    await removeConnection(conn.threadId, connectionId);
    console.log(`Removed connection ${connectionId} from thread ${conn.threadId}`);
  }

  return { statusCode: 200, body: "Disconnected" };
};
