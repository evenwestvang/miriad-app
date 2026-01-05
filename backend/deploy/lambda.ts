/**
 * AWS Lambda entry point for Cast backend
 *
 * Uses Hono's AWS Lambda adapter to handle API Gateway requests.
 * Strips the API Gateway stage prefix from paths.
 *
 * Uses real PlanetScale storage and DynamoDB-backed connection manager.
 * Agent spawning uses FargateOrchestrator (when implemented).
 * WebSocket broadcasts go through API Gateway Management API.
 */

import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { createApp, createDynamoDBConnectionManager } from '@cast/server';
import { createPostgresStorage } from '@cast/storage';
import { FargateOrchestrator } from '@cast/runtime';

// =============================================================================
// Configuration
// =============================================================================

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT ?? '';

// ECS/Fargate config
const ECS_CLUSTER_ARN = process.env.ECS_CLUSTER_ARN;
const ECS_TASK_DEFINITION = process.env.ECS_TASK_DEFINITION;
const CONTAINER_STATE_TABLE = process.env.CONTAINER_STATE_TABLE;
const SUBNET_IDS = process.env.SUBNET_IDS;
const SECURITY_GROUP_IDS = process.env.SECURITY_GROUP_IDS;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const CAST_API_URL = process.env.CAST_API_URL;

// =============================================================================
// Real Storage
// =============================================================================

// PlanetScale Postgres - same database as local dev
const storage = createPostgresStorage({
  connectionString: process.env.PLANETSCALE_URL!,
});

// Initialize storage (create tables if not exists)
let storageInitialized = false;
async function ensureStorageInitialized() {
  if (!storageInitialized) {
    await storage.initialize();
    storageInitialized = true;
  }
}

// =============================================================================
// Connection Manager
// =============================================================================

// DynamoDB-backed connection manager for WebSocket broadcasts
// Uses API Gateway Management API to send to connections
const connectionManager = CONNECTIONS_TABLE && WEBSOCKET_ENDPOINT
  ? createDynamoDBConnectionManager({
      tableName: CONNECTIONS_TABLE,
      apiGatewayEndpoint: WEBSOCKET_ENDPOINT.replace('wss://', 'https://'),
    })
  : {
      // Fallback placeholder if env vars not set (during initial deploy)
      addConnection: () => ({} as never),
      removeConnection: () => {},
      getChannelConnections: () => [],
      getConnection: () => undefined,
      broadcast: async () => {},
      send: async () => {},
      getConnectionCount: () => 0,
      getChannelConnectionCount: () => 0,
      closeAll: () => {},
    };

// Placeholder orchestrator - used when Fargate config not available
const placeholderOrchestrator = {
  spawn: async () => ({ threadId: '', containerId: '', port: 8080, status: 'running' as const, lastActivity: '', createdAt: '' }),
  sendMessage: async () => {},
  stop: async () => {},
  getStatus: () => null,
  isRunning: () => false,
  getAllRunning: () => [],
  shutdown: async () => {},
};

// Use FargateOrchestrator when all required env vars are present
const orchestrator = ECS_CLUSTER_ARN && ECS_TASK_DEFINITION && CONTAINER_STATE_TABLE && SUBNET_IDS && SECURITY_GROUP_IDS && ANTHROPIC_API_KEY && CAST_API_URL
  ? new FargateOrchestrator({
      clusterArn: ECS_CLUSTER_ARN,
      taskDefinitionArn: ECS_TASK_DEFINITION,
      tableName: CONTAINER_STATE_TABLE,
      subnetIds: SUBNET_IDS.split(','),
      securityGroupIds: SECURITY_GROUP_IDS.split(','),
      castApiUrl: CAST_API_URL,
      anthropicApiKey: ANTHROPIC_API_KEY,
    })
  : placeholderOrchestrator;

// =============================================================================
// Create App
// =============================================================================

const app = createApp({
  storage,
  orchestrator,
  connectionManager,
  spaceId: process.env.SPACE_ID ?? 'default-space',
});

// =============================================================================
// Lambda Handler
// =============================================================================

const honoHandler = handle(app);

export const handler = async (event: APIGatewayProxyEventV2, context: Context) => {
  // Ensure storage is initialized on first request
  await ensureStorageInitialized();

  // Strip the stage prefix from the path if present
  // API Gateway sends /stag/health but Hono expects /health
  const stage = event.requestContext?.stage;
  if (stage && event.rawPath?.startsWith(`/${stage}`)) {
    event.rawPath = event.rawPath.slice(stage.length + 1) || '/';
  }

  return honoHandler(event, context);
};
