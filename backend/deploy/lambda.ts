/**
 * AWS Lambda entry point for Cast backend
 *
 * Uses Hono's AWS Lambda adapter to handle API Gateway requests.
 * Strips the API Gateway stage prefix from paths.
 *
 * Uses real PlanetScale storage and DynamoDB-backed connection manager.
 * Agent runtime uses placeholder - Fly.io runtime will be added in Phase 2.
 * WebSocket broadcasts go through API Gateway Management API.
 */

import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { createApp, createDynamoDBConnectionManager } from '@cast/server';
import { createPostgresStorage } from '@cast/storage';
import type { AgentRuntime, AgentRuntimeState } from '@cast/runtime';

// =============================================================================
// Configuration
// =============================================================================

const CONNECTIONS_TABLE = process.env.CONNECTIONS_TABLE!;
const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT ?? '';

// Agent runtime config (Fly.io will be added in Phase 2)
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

// Placeholder runtime - Fly.io runtime will be added in Phase 2
// For now, Lambda relies on roster callbackUrl for remote agents (they self-register on checkin)
const placeholderRuntime: AgentRuntime = {
  activate: async () => ({ agentId: '', containerId: '', port: 8080, status: 'offline' as const, lastActivity: '', createdAt: '' }),
  sendMessage: async () => {},
  suspend: async () => {},
  getStatus: () => null,
  isOnline: () => false,
  getAllOnline: () => [],
  shutdown: async () => {},
};

// Use placeholder for now - Fly.io runtime will be added in Phase 2
const runtime = placeholderRuntime;

// =============================================================================
// Create App
// =============================================================================

const app = createApp({
  storage,
  runtime,
  connectionManager,
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
