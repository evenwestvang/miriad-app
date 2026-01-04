/**
 * Orchestrator Lambda Handler
 *
 * Manages Fargate container lifecycle for Claude Code threads:
 * - Cold start: No container → start task → wait healthy → forward message
 * - Warm: Container running → forward directly to container IP
 * - Resume: Container stopped → start NEW task (same EFS) → forward message
 *
 * Invoked by send-message handler for claude-code agent type.
 */

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import {
  getContainerState,
  createContainerState,
  setContainerRunning,
  setContainerStopped,
  touchContainerActivity,
  isContainerReady,
  type ContainerState,
} from "./container-state.js";
import {
  startTask,
  stopTask,
  waitForTaskHealthy,
  sendMessageToContainer,
  describeTask,
} from "./ecs-tasks.js";
import {
  broadcastContainerStarting,
  broadcastContainerReady,
  broadcastContainerError,
} from "./broadcast.js";

// =============================================================================
// Types
// =============================================================================

interface OrchestratorEvent {
  threadId: string;
  content: string;
}

interface OrchestratorResult {
  status: "processing" | "error";
  threadId: string;
  containerStatus: string;
  message?: string;
}

// Environment
const getAnthropicApiKeyArn = () => process.env.ANTHROPIC_API_KEY_ARN!;

// =============================================================================
// Handler
// =============================================================================

/**
 * Direct invocation handler (from send-message Lambda)
 */
export async function orchestratorHandler(
  event: OrchestratorEvent
): Promise<OrchestratorResult> {
  const { threadId, content } = event;

  console.log(`[Orchestrator] Processing message for thread ${threadId}`);

  try {
    // Get current container state
    let state = await getContainerState(threadId);
    console.log(
      `[Orchestrator] Container state:`,
      state ? { status: state.status, taskArn: state.taskArn } : "none"
    );

    // Handle based on container state
    if (isContainerReady(state)) {
      // Container running - forward message directly
      console.log(`[Orchestrator] Container ready, forwarding message`);
      await sendMessageToContainer(state!.privateIp, threadId, content);
      await touchContainerActivity(threadId);

      return {
        status: "processing",
        threadId,
        containerStatus: "running",
      };
    }

    if (state?.status === "starting") {
      // Task is starting - wait for it to be ready
      console.log(`[Orchestrator] Container starting, waiting for healthy...`);
      const info = await waitForTaskHealthy(state.taskArn);

      // Update state with IP
      await setContainerRunning(threadId, info.privateIp!);

      // Forward message
      await sendMessageToContainer(info.privateIp!, threadId, content);

      return {
        status: "processing",
        threadId,
        containerStatus: "running",
      };
    }

    // Need to start a new container (cold start or resume from stopped)
    console.log(`[Orchestrator] Starting new container for thread ${threadId}`);

    // Notify frontend that container is starting (cold start)
    await broadcastContainerStarting(threadId);

    // Check if there's a stale task we need to clean up
    if (state?.taskArn && state.status !== "stopped") {
      console.log(`[Orchestrator] Cleaning up stale task ${state.taskArn}`);
      try {
        const taskInfo = await describeTask(state.taskArn);
        if (taskInfo && taskInfo.status !== "STOPPED") {
          await stopTask(state.taskArn, "Stale task cleanup");
        }
      } catch (error) {
        console.log(`[Orchestrator] Stale task cleanup error (ignored):`, error);
      }
    }

    // Start new task
    const startResult = await startTask(threadId, getAnthropicApiKeyArn());

    // Create or update container state
    await createContainerState(threadId, startResult.taskArn);

    // Wait for task to become healthy
    console.log(`[Orchestrator] Waiting for container to become healthy...`);
    const info = await waitForTaskHealthy(startResult.taskArn);

    // Update state with IP
    await setContainerRunning(threadId, info.privateIp!);

    // Notify frontend that container is ready
    await broadcastContainerReady(threadId);

    // Forward message to container
    console.log(`[Orchestrator] Container healthy, forwarding message`);
    await sendMessageToContainer(info.privateIp!, threadId, content);

    return {
      status: "processing",
      threadId,
      containerStatus: "running",
    };
  } catch (error) {
    console.error(`[Orchestrator] Error processing message:`, error);

    // Notify frontend of error
    await broadcastContainerError(
      threadId,
      error instanceof Error ? error.message : "Unknown error"
    );

    return {
      status: "error",
      threadId,
      containerStatus: "error",
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/**
 * HTTP handler (if invoked via API Gateway)
 */
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
  let body: { content: string };
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

  const result = await orchestratorHandler({ threadId, content: body.content });

  const statusCode = result.status === "error" ? 500 : 202;
  return {
    statusCode,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(result),
  };
};

/**
 * Stop container handler (for cleanup or explicit shutdown)
 */
export async function stopContainerHandler(event: {
  threadId: string;
  reason?: string;
}): Promise<{ status: string }> {
  const { threadId, reason } = event;

  console.log(`[Orchestrator] Stop requested for thread ${threadId}`);

  const state = await getContainerState(threadId);

  if (!state) {
    console.log(`[Orchestrator] No container state found for ${threadId}`);
    return { status: "not_found" };
  }

  if (state.status === "stopped") {
    console.log(`[Orchestrator] Container already stopped for ${threadId}`);
    return { status: "already_stopped" };
  }

  try {
    // Stop the ECS task
    await stopTask(state.taskArn, reason);

    // Update state to stopped
    await setContainerStopped(threadId);

    console.log(`[Orchestrator] Container stopped for ${threadId}`);
    return { status: "stopped" };
  } catch (error) {
    console.error(`[Orchestrator] Error stopping container:`, error);
    throw error;
  }
}
