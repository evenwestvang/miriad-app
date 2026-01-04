/**
 * Container State DynamoDB Operations
 *
 * Manages Fargate container lifecycle state for Claude Code threads.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";

// Lazy-initialized client
let _docClient: DynamoDBDocumentClient | null = null;

function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    const client = new DynamoDBClient({});
    _docClient = DynamoDBDocumentClient.from(client);
  }
  return _docClient;
}

const getContainerStateTable = () => process.env.CONTAINER_STATE_TABLE!;

// =============================================================================
// Types
// =============================================================================

export type ContainerStatus = "starting" | "running" | "stopping" | "stopped";

export interface ContainerState {
  threadId: string; // Partition key
  taskArn: string; // ECS task ARN
  status: ContainerStatus;
  privateIp: string; // For direct HTTP communication
  lastActivity: string; // ISO timestamp
  createdAt: string;
  ttl?: number; // TTL for DynamoDB auto-cleanup
}

// =============================================================================
// Container State Operations
// =============================================================================

/**
 * Get container state for a thread
 */
export async function getContainerState(
  threadId: string
): Promise<ContainerState | null> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getContainerStateTable(),
      Key: { threadId },
    })
  );
  return (result.Item as ContainerState) ?? null;
}

/**
 * Create container state when starting a new task
 */
export async function createContainerState(
  threadId: string,
  taskArn: string
): Promise<ContainerState> {
  const now = new Date().toISOString();
  const state: ContainerState = {
    threadId,
    taskArn,
    status: "starting",
    privateIp: "", // Will be set once task is running
    lastActivity: now,
    createdAt: now,
  };

  await getDocClient().send(
    new PutCommand({
      TableName: getContainerStateTable(),
      Item: state,
    })
  );

  return state;
}

/**
 * Update container state to running with private IP
 */
export async function setContainerRunning(
  threadId: string,
  privateIp: string
): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getContainerStateTable(),
      Key: { threadId },
      UpdateExpression:
        "SET #status = :status, #ip = :ip, #activity = :now",
      ExpressionAttributeNames: {
        "#status": "status",
        "#ip": "privateIp",
        "#activity": "lastActivity",
      },
      ExpressionAttributeValues: {
        ":status": "running",
        ":ip": privateIp,
        ":now": now,
      },
    })
  );
}

/**
 * Update container state to stopping
 */
export async function setContainerStopping(threadId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getContainerStateTable(),
      Key: { threadId },
      UpdateExpression: "SET #status = :status, #activity = :now",
      ExpressionAttributeNames: {
        "#status": "status",
        "#activity": "lastActivity",
      },
      ExpressionAttributeValues: {
        ":status": "stopping",
        ":now": now,
      },
    })
  );
}

/**
 * Update container state to stopped with TTL for cleanup
 */
export async function setContainerStopped(threadId: string): Promise<void> {
  const now = new Date().toISOString();
  // TTL: 7 days after stopping (so we can resume with same EFS)
  const ttl = Math.floor(Date.now() / 1000) + 7 * 24 * 60 * 60;

  await getDocClient().send(
    new UpdateCommand({
      TableName: getContainerStateTable(),
      Key: { threadId },
      UpdateExpression:
        "SET #status = :status, #activity = :now, #ttl = :ttl REMOVE #ip",
      ExpressionAttributeNames: {
        "#status": "status",
        "#activity": "lastActivity",
        "#ttl": "ttl",
        "#ip": "privateIp",
      },
      ExpressionAttributeValues: {
        ":status": "stopped",
        ":now": now,
        ":ttl": ttl,
      },
    })
  );
}

/**
 * Touch last activity timestamp
 */
export async function touchContainerActivity(threadId: string): Promise<void> {
  const now = new Date().toISOString();
  await getDocClient().send(
    new UpdateCommand({
      TableName: getContainerStateTable(),
      Key: { threadId },
      UpdateExpression: "SET #activity = :now",
      ExpressionAttributeNames: {
        "#activity": "lastActivity",
      },
      ExpressionAttributeValues: {
        ":now": now,
      },
    })
  );
}

/**
 * Delete container state (for cleanup)
 */
export async function deleteContainerState(threadId: string): Promise<void> {
  await getDocClient().send(
    new DeleteCommand({
      TableName: getContainerStateTable(),
      Key: { threadId },
    })
  );
}

/**
 * Check if container is ready to receive messages
 */
export function isContainerReady(state: ContainerState | null): boolean {
  return state !== null && state.status === "running" && !!state.privateIp;
}
