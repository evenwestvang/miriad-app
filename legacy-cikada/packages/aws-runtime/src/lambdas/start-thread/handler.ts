/**
 * Start Thread Handler
 *
 * HTTP POST /thread
 *
 * Creates a new thread. The agent is invoked when the first message is sent.
 */

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createThread } from "../../shared/db.js";
import { generateMessageId } from "../../shared/ulid.js";

interface StartThreadRequest {
  agentName?: string;
  threadId?: string;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  // Parse request body
  let body: StartThreadRequest;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  const agentName = body.agentName ?? "simple";
  const threadId = body.threadId ?? generateMessageId();

  console.log(`Creating thread ${threadId} with agent ${agentName}`);

  // Create thread record (agent will be invoked on first message)
  try {
    await createThread(threadId, agentName);
  } catch (error) {
    // Thread may already exist if client retried
    if (
      (error as { name?: string }).name !== "ConditionalCheckFailedException"
    ) {
      throw error;
    }
    console.log(`Thread ${threadId} already exists`);
  }

  return {
    statusCode: 201,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ threadId, agentName }),
  };
};
