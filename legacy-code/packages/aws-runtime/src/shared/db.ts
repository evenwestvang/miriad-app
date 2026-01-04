/**
 * DynamoDB Utilities
 *
 * Shared database operations for all Lambda handlers.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

// Lazy-initialized clients
let _docClient: DynamoDBDocumentClient | null = null;

function getDocClient(): DynamoDBDocumentClient {
  if (!_docClient) {
    const client = new DynamoDBClient({});
    _docClient = DynamoDBDocumentClient.from(client);
  }
  return _docClient;
}

// Table names from environment
const getConnectionsTable = () => process.env.CONNECTIONS_TABLE!;
const getThreadsTable = () => process.env.THREADS_TABLE!;
const getThreadMetaTable = () => process.env.THREAD_META_TABLE!;

// =============================================================================
// Types
// =============================================================================

export interface ThreadMeta {
  threadId: string;
  agentName: string;
  status: "starting" | "running" | "waiting" | "completed" | "terminated" | "error";
  callbackId?: string | null;
  durableExecutionArn?: string;
  createdAt: string;
  updatedAt?: string;
  // Sub-agent support
  parentThreadId?: string;      // If spawned by another agent
  childThreadIds?: string[];    // Spawned children (for tracking)
  spawnInput?: unknown;         // Input from parent's spawn() call
  result?: unknown;             // Completion result (for quick access)
  completedAt?: string;         // When thread completed/terminated
}

export interface StoredMessage {
  threadId: string;
  msgId: string;
  value: Record<string, unknown>;
  createdAt: string;
}

export interface Connection {
  threadId: string;
  connectionId: string;
  connectedAt: string;
  ttl: number;
}

// =============================================================================
// Connection Management
// =============================================================================

/**
 * Register a WebSocket connection for a thread
 */
export async function registerConnection(
  threadId: string,
  connectionId: string
): Promise<void> {
  const ttl = Math.floor(Date.now() / 1000) + 86400; // 24h TTL
  await getDocClient().send(
    new PutCommand({
      TableName: getConnectionsTable(),
      Item: {
        threadId,
        connectionId,
        connectedAt: new Date().toISOString(),
        ttl,
      },
    })
  );
}

/**
 * Remove a WebSocket connection
 */
export async function removeConnection(
  threadId: string,
  connectionId: string
): Promise<void> {
  await getDocClient().send(
    new DeleteCommand({
      TableName: getConnectionsTable(),
      Key: { threadId, connectionId },
    })
  );
}

/**
 * Get all connections for a thread
 */
export async function getConnections(threadId: string): Promise<Connection[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getConnectionsTable(),
      KeyConditionExpression: "threadId = :tid",
      ExpressionAttributeValues: { ":tid": threadId },
    })
  );
  return (result.Items as Connection[]) ?? [];
}

/**
 * Find connection by connectionId (uses GSI)
 */
export async function findConnectionByConnectionId(
  connectionId: string
): Promise<Connection | null> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getConnectionsTable(),
      IndexName: "connectionId-index",
      KeyConditionExpression: "connectionId = :cid",
      ExpressionAttributeValues: { ":cid": connectionId },
    })
  );
  return (result.Items?.[0] as Connection) ?? null;
}

// =============================================================================
// Thread Messages
// =============================================================================

/**
 * Persist a message to the thread
 */
export async function persistMessage(
  threadId: string,
  msgId: string,
  value: Record<string, unknown>
): Promise<void> {
  await getDocClient().send(
    new PutCommand({
      TableName: getThreadsTable(),
      Item: {
        threadId,
        msgId,
        value,
        createdAt: new Date().toISOString(),
      },
    })
  );
}

/**
 * Get all messages for a thread (sorted by ULID)
 */
export async function getThreadHistory(
  threadId: string,
  since?: string
): Promise<StoredMessage[]> {
  const result = await getDocClient().send(
    new QueryCommand({
      TableName: getThreadsTable(),
      KeyConditionExpression: since
        ? "threadId = :tid AND msgId > :since"
        : "threadId = :tid",
      ExpressionAttributeValues: since
        ? { ":tid": threadId, ":since": since }
        : { ":tid": threadId },
    })
  );
  return (result.Items as StoredMessage[]) ?? [];
}

// =============================================================================
// Thread Metadata
// =============================================================================

/**
 * Get thread metadata
 */
export async function getThreadMeta(
  threadId: string
): Promise<ThreadMeta | null> {
  const result = await getDocClient().send(
    new GetCommand({
      TableName: getThreadMetaTable(),
      Key: { threadId },
    })
  );
  return (result.Item as ThreadMeta) ?? null;
}

/**
 * Create a new thread
 */
export async function createThread(
  threadId: string,
  agentName: string,
  options?: {
    durableExecutionArn?: string;
    parentThreadId?: string;
    spawnInput?: unknown;
  }
): Promise<ThreadMeta> {
  const meta: ThreadMeta = {
    threadId,
    agentName,
    status: "starting",
    durableExecutionArn: options?.durableExecutionArn,
    parentThreadId: options?.parentThreadId,
    spawnInput: options?.spawnInput,
    createdAt: new Date().toISOString(),
  };

  await getDocClient().send(
    new PutCommand({
      TableName: getThreadMetaTable(),
      Item: meta,
      ConditionExpression: "attribute_not_exists(threadId)",
    })
  );

  return meta;
}

/**
 * Add a child thread ID to a parent thread
 */
export async function addChildThread(
  parentThreadId: string,
  childThreadId: string
): Promise<void> {
  await getDocClient().send(
    new UpdateCommand({
      TableName: getThreadMetaTable(),
      Key: { threadId: parentThreadId },
      UpdateExpression: "SET #children = list_append(if_not_exists(#children, :empty), :child), #updated = :now",
      ExpressionAttributeNames: {
        "#children": "childThreadIds",
        "#updated": "updatedAt",
      },
      ExpressionAttributeValues: {
        ":child": [childThreadId],
        ":empty": [],
        ":now": new Date().toISOString(),
      },
    })
  );
}

/**
 * Update thread metadata
 */
export async function updateThreadMeta(
  threadId: string,
  updates: Partial<Omit<ThreadMeta, "threadId" | "createdAt">>
): Promise<void> {
  const keys = Object.keys(updates);
  if (keys.length === 0) return;

  // Always update updatedAt
  const allUpdates = { ...updates, updatedAt: new Date().toISOString() };

  // Separate SET and REMOVE operations
  const setKeys: string[] = [];
  const removeKeys: string[] = [];

  for (const key of Object.keys(allUpdates)) {
    const value = allUpdates[key as keyof typeof allUpdates];
    if (value === undefined || value === null) {
      removeKeys.push(key);
    } else {
      setKeys.push(key);
    }
  }

  // Build expressions
  const expressionParts: string[] = [];
  const expressionAttrNames: Record<string, string> = {};
  const expressionAttrValues: Record<string, unknown> = {};

  if (setKeys.length > 0) {
    expressionParts.push(
      "SET " + setKeys.map((k, i) => `#sk${i} = :sv${i}`).join(", ")
    );
    setKeys.forEach((k, i) => {
      expressionAttrNames[`#sk${i}`] = k;
      expressionAttrValues[`:sv${i}`] = allUpdates[k as keyof typeof allUpdates];
    });
  }

  if (removeKeys.length > 0) {
    expressionParts.push(
      "REMOVE " + removeKeys.map((k, i) => `#rk${i}`).join(", ")
    );
    removeKeys.forEach((k, i) => {
      expressionAttrNames[`#rk${i}`] = k;
    });
  }

  if (expressionParts.length === 0) return;

  await getDocClient().send(
    new UpdateCommand({
      TableName: getThreadMetaTable(),
      Key: { threadId },
      UpdateExpression: expressionParts.join(" "),
      ExpressionAttributeNames: expressionAttrNames,
      ...(Object.keys(expressionAttrValues).length > 0 && {
        ExpressionAttributeValues: expressionAttrValues,
      }),
    })
  );
}

/**
 * Check if thread exists
 */
export async function threadExists(threadId: string): Promise<boolean> {
  const meta = await getThreadMeta(threadId);
  return meta !== null;
}
