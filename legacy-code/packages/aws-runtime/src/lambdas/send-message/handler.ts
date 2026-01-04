/**
 * Send Message Handler
 *
 * HTTP POST /thread/{threadId}/message
 *
 * Sends a user message to a thread:
 * 1. Persists the message
 * 2. Broadcasts to connected clients
 * 3. Invokes agent Lambda to process
 */

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  LambdaClient,
  InvokeCommand,
} from "@aws-sdk/client-lambda";
import {
  persistMessage,
  getThreadMeta,
  updateThreadMeta,
  createThread,
} from "../../shared/db.js";
import { broadcast } from "../../shared/broadcast.js";
import { tymbal } from "@cikada/core/tymbal";
import { generateMessageId } from "../../shared/ulid.js";

const lambda = new LambdaClient({});

interface MessageRequest {
  content: string;
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const threadId = event.pathParameters?.threadId;

  if (!threadId) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing threadId" }),
    };
  }

  // Parse request body
  let body: MessageRequest;
  try {
    body = JSON.parse(event.body ?? "{}");
  } catch {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Invalid JSON" }),
    };
  }

  if (!body.content) {
    return {
      statusCode: 400,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "Missing content" }),
    };
  }

  console.log(`Sending message to thread ${threadId}`);

  // Get or create thread metadata
  let meta = await getThreadMeta(threadId);
  if (!meta) {
    // Auto-create thread with default agent
    const defaultAgent = process.env.DEFAULT_AGENT ?? "simple";
    console.log(`Thread ${threadId} not found, creating with agent ${defaultAgent}`);
    try {
      meta = await createThread(threadId, defaultAgent);
    } catch (error) {
      // Thread may have been created by concurrent request
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        meta = await getThreadMeta(threadId);
      }
      if (!meta) throw error;
    }
  }

  // Generate message ID and build user message
  const msgId = generateMessageId();
  const value = { type: "user", content: body.content };

  // Persist message
  await persistMessage(threadId, msgId, value);
  console.log(`Persisted message ${msgId}`);

  // Broadcast to connected clients
  const broadcastResult = await broadcast(threadId, tymbal.set(msgId, value));
  console.log(`Broadcast to ${broadcastResult.sent} connections`);

  // Resume or invoke agent Lambda to process the message
  const agentFunctionName = process.env.AGENT_FUNCTION_NAME;
  const sdkAgentFunctionName = process.env.SDK_AGENT_FUNCTION_NAME;
  const orchestratorFunctionName = process.env.ORCHESTRATOR_FUNCTION_NAME;

  // Check if this is an SDK agent thread
  const isSDKAgent = meta.agentName === "sdk-sandbox";
  // Check if this is a Claude Code (Fargate) thread
  const isClaudeCode = meta.agentName === "claude-code";

  if (isClaudeCode && orchestratorFunctionName) {
    // Claude Code: invoke the orchestrator Lambda (manages Fargate containers)
    try {
      console.log(`Invoking orchestrator for claude-code thread ${threadId}`);

      await lambda.send(
        new InvokeCommand({
          FunctionName: orchestratorFunctionName,
          InvocationType: "Event", // Async invocation
          Payload: JSON.stringify({
            threadId,
            content: body.content,
          }),
        })
      );

      // Update thread status (orchestrator manages container state separately)
      await updateThreadMeta(threadId, { status: "running" });
      console.log("Orchestrator invoked");
    } catch (error) {
      console.error("Failed to invoke orchestrator:", error);
    }
  } else if (isSDKAgent && sdkAgentFunctionName) {
    // SDK Agent: invoke the SDK agent Lambda
    try {
      if (meta.status !== "running") {
        console.log(`Invoking SDK agent for thread ${threadId}`);

        await lambda.send(
          new InvokeCommand({
            FunctionName: sdkAgentFunctionName,
            InvocationType: "Event", // Async invocation
            Payload: JSON.stringify({
              threadId,
              workdirBase: process.env.WORKDIR_BASE ?? "/tmp",
            }),
          })
        );

        await updateThreadMeta(threadId, { status: "running" });
        console.log("SDK agent invoked");
      } else {
        console.log("SDK agent already running, skipping invocation");
      }
    } catch (error) {
      console.error("Failed to invoke SDK agent:", error);
    }
  } else if (agentFunctionName) {
    try {
      // Durable execution callback support removed - feature not in public SDK
      // TODO: Re-enable when AWS Lambda Durable Execution is GA
      if (meta.status !== "running") {
        // No waiting execution, start a new one
        console.log(`Invoking agent ${meta.agentName} for thread ${threadId}`);

        await lambda.send(
          new InvokeCommand({
            FunctionName: agentFunctionName,
            Qualifier: "live", // Use the published alias for durable functions
            InvocationType: "Event", // Async invocation
            Payload: JSON.stringify({
              threadId,
              agentName: meta.agentName,
            }),
          })
        );

        // Update thread status
        await updateThreadMeta(threadId, { status: "running" });
        console.log("Agent invoked");
      } else {
        console.log("Agent already running, skipping invocation");
      }
    } catch (error) {
      console.error("Failed to invoke/resume agent:", error);
      // Don't fail the request - message is persisted
    }
  }

  return {
    statusCode: 202,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ msgId, threadId }),
  };
};
