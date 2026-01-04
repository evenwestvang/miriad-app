/**
 * ECS Task Management
 *
 * Start/stop Fargate tasks for Claude Code containers.
 */

import {
  ECSClient,
  RunTaskCommand,
  StopTaskCommand,
  DescribeTasksCommand,
  type Task,
} from "@aws-sdk/client-ecs";

// Lazy-initialized client
let _ecsClient: ECSClient | null = null;

function getECSClient(): ECSClient {
  if (!_ecsClient) {
    _ecsClient = new ECSClient({});
  }
  return _ecsClient;
}

// Configuration from environment
const getClusterArn = () => process.env.CLUSTER_ARN!;
const getTaskDefinition = () => process.env.TASK_DEFINITION!;
const getSubnetIds = () => process.env.SUBNET_IDS!.split(",");
const getSecurityGroupId = () => process.env.SECURITY_GROUP_ID!;
const getCikadaApiUrl = () => process.env.CIKADA_API_URL!;
const getEfsFileSystemId = () => process.env.EFS_FILE_SYSTEM_ID;
const getEfsAccessPointId = () => process.env.EFS_ACCESS_POINT_ID;

// =============================================================================
// Types
// =============================================================================

export interface StartTaskResult {
  taskArn: string;
  status: string;
}

export interface TaskInfo {
  taskArn: string;
  status: string;
  privateIp: string | null;
  healthStatus: string | null;
}

// =============================================================================
// ECS Task Operations
// =============================================================================

/**
 * Start a new Fargate task for a thread
 */
export async function startTask(
  threadId: string,
  anthropicApiKeyArn: string
): Promise<StartTaskResult> {
  console.log(`[ECS] Starting task for thread ${threadId}`);

  const result = await getECSClient().send(
    new RunTaskCommand({
      cluster: getClusterArn(),
      taskDefinition: getTaskDefinition(),
      launchType: "FARGATE",
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: getSubnetIds(),
          securityGroups: [getSecurityGroupId()],
          assignPublicIp: "DISABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: "claude-code",
            environment: [
              { name: "THREAD_ID", value: threadId },
              { name: "CIKADA_API_URL", value: getCikadaApiUrl() },
              // Workspace path includes threadId for EFS organization
              { name: "WORKSPACE_DIR", value: `/workspace/${threadId}` },
            ],
          },
        ],
      },
      // Tag task for cost tracking and identification
      tags: [
        { key: "threadId", value: threadId },
        { key: "service", value: "claude-code" },
      ],
      // Enable ECS Exec for debugging if needed
      enableExecuteCommand: true,
    })
  );

  if (!result.tasks || result.tasks.length === 0) {
    const failures = result.failures?.map((f) => f.reason).join(", ");
    throw new Error(`Failed to start task: ${failures || "unknown error"}`);
  }

  const task = result.tasks[0];
  console.log(`[ECS] Task started: ${task.taskArn}, status: ${task.lastStatus}`);

  return {
    taskArn: task.taskArn!,
    status: task.lastStatus!,
  };
}

/**
 * Stop a running Fargate task
 */
export async function stopTask(taskArn: string, reason?: string): Promise<void> {
  console.log(`[ECS] Stopping task ${taskArn}`);

  await getECSClient().send(
    new StopTaskCommand({
      cluster: getClusterArn(),
      task: taskArn,
      reason: reason ?? "Orchestrator initiated shutdown",
    })
  );

  console.log(`[ECS] Task stop requested: ${taskArn}`);
}

/**
 * Get task information including private IP
 */
export async function describeTask(taskArn: string): Promise<TaskInfo | null> {
  const result = await getECSClient().send(
    new DescribeTasksCommand({
      cluster: getClusterArn(),
      tasks: [taskArn],
    })
  );

  if (!result.tasks || result.tasks.length === 0) {
    return null;
  }

  const task = result.tasks[0];
  return taskToInfo(task);
}

/**
 * Wait for task to become healthy (with timeout)
 */
export async function waitForTaskHealthy(
  taskArn: string,
  timeoutMs: number = 120_000, // 2 minutes default
  pollIntervalMs: number = 5_000 // 5 seconds
): Promise<TaskInfo> {
  console.log(`[ECS] Waiting for task ${taskArn} to become healthy...`);

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const info = await describeTask(taskArn);

    if (!info) {
      throw new Error(`Task ${taskArn} not found`);
    }

    console.log(
      `[ECS] Task status: ${info.status}, health: ${info.healthStatus}, IP: ${info.privateIp}`
    );

    // Check if task failed
    if (info.status === "STOPPED") {
      throw new Error(`Task ${taskArn} stopped unexpectedly`);
    }

    // Task is running and has an IP - check health
    if (info.status === "RUNNING" && info.privateIp) {
      // If container has health check configured, wait for HEALTHY
      if (info.healthStatus === "HEALTHY") {
        console.log(`[ECS] Task ${taskArn} is healthy`);
        return info;
      }

      // If no health check or unknown, try HTTP health check
      if (!info.healthStatus || info.healthStatus === "UNKNOWN") {
        const isHealthy = await checkContainerHealth(info.privateIp);
        if (isHealthy) {
          console.log(`[ECS] Task ${taskArn} passed HTTP health check`);
          return info;
        }
      }
    }

    // Wait before next poll
    await sleep(pollIntervalMs);
  }

  throw new Error(`Timeout waiting for task ${taskArn} to become healthy`);
}

/**
 * Check container health via HTTP
 */
async function checkContainerHealth(privateIp: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${privateIp}:8080/health`, {
      method: "GET",
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (response.ok) {
      const data = await response.json();
      return data.status === "healthy" || data.status === "processing";
    }

    return false;
  } catch (error) {
    console.log(`[ECS] Health check failed for ${privateIp}:`, error);
    return false;
  }
}

/**
 * Send message to container
 */
export async function sendMessageToContainer(
  privateIp: string,
  threadId: string,
  content: string
): Promise<void> {
  console.log(`[ECS] Sending message to container at ${privateIp}`);

  const response = await fetch(`http://${privateIp}:8080/message`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content,
      threadId,
    }),
    signal: AbortSignal.timeout(30_000), // 30 second timeout
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to send message to container: ${response.status} ${errorText}`
    );
  }

  const result = await response.json();
  console.log(`[ECS] Container accepted message:`, result);
}

// =============================================================================
// Helpers
// =============================================================================

function taskToInfo(task: Task): TaskInfo {
  // Extract private IP from network attachments
  let privateIp: string | null = null;
  for (const attachment of task.attachments ?? []) {
    if (attachment.type === "ElasticNetworkInterface") {
      for (const detail of attachment.details ?? []) {
        if (detail.name === "privateIPv4Address") {
          privateIp = detail.value ?? null;
          break;
        }
      }
    }
  }

  // Extract container health status
  let healthStatus: string | null = null;
  for (const container of task.containers ?? []) {
    if (container.name === "claude-code") {
      healthStatus = container.healthStatus ?? null;
      break;
    }
  }

  return {
    taskArn: task.taskArn!,
    status: task.lastStatus!,
    privateIp,
    healthStatus,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
