/**
 * WebSocket Sync Handler
 *
 * Handles {"request": "sync", "since": "..."} messages from clients.
 * Sends back all messages since the given timestamp.
 */

import type { APIGatewayProxyWebsocketHandlerV2 } from "aws-lambda";
import { findConnectionByConnectionId, getThreadHistory } from "../../shared/db.js";
import { sendToConnection } from "../../shared/broadcast.js";
import { tymbal } from "@cikada/core/tymbal";

interface SyncRequest {
  request: "sync";
  since?: string;
}

export const handler: APIGatewayProxyWebsocketHandlerV2 = async (event) => {
  const connectionId = event.requestContext.connectionId;

  // Parse the sync request
  let request: SyncRequest;
  try {
    request = JSON.parse(event.body ?? "{}");
  } catch {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  if (request.request !== "sync") {
    return { statusCode: 400, body: "Expected sync request" };
  }

  // Find the thread for this connection
  const conn = await findConnectionByConnectionId(connectionId);
  if (!conn) {
    return { statusCode: 400, body: "Connection not found" };
  }

  console.log(
    `Sync request for thread ${conn.threadId}, since: ${request.since ?? "beginning"}`
  );

  // Get messages since timestamp
  const messages = await getThreadHistory(conn.threadId, request.since);

  console.log(`Sending ${messages.length} messages to ${connectionId}`);

  // Send each message as a Set frame
  for (const msg of messages) {
    const frame = tymbal.set(msg.msgId, msg.value);
    await sendToConnection(connectionId, frame);
  }

  // Send sync acknowledgment with latest timestamp
  const latestTimestamp =
    messages.length > 0
      ? messages[messages.length - 1].createdAt
      : new Date().toISOString();
  await sendToConnection(connectionId, tymbal.sync(latestTimestamp));

  return { statusCode: 200, body: "Synced" };
};
