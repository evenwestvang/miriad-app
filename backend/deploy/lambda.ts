/**
 * AWS Lambda entry point for Cast backend
 *
 * Uses Hono's AWS Lambda adapter to handle API Gateway requests.
 * Strips the API Gateway stage prefix from paths.
 *
 * Uses real PlanetScale storage and PostgresConnectionManager.
 * Agent runtime uses placeholder - Fly.io runtime will be added in Phase 2.
 * WebSocket broadcasts go through API Gateway Management API.
 */

import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { handle } from 'hono/aws-lambda';
import { createApp } from '@cast/server';
import {
  createPostgresConnectionManager,
  ApiGatewaySender,
  type PostgresConnectionManager,
} from '@cast/server/websocket';
import { createPostgresStorage } from '@cast/storage';
import type { AgentRuntime } from '@cast/runtime';

// =============================================================================
// Configuration
// =============================================================================

const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT ?? '';
const PLANETSCALE_URL = process.env.PLANETSCALE_URL!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// =============================================================================
// Real Storage
// =============================================================================

// PlanetScale Postgres - same database as local dev
const storage = createPostgresStorage({
  connectionString: PLANETSCALE_URL,
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

// Postgres-backed connection manager for WebSocket broadcasts
// Uses API Gateway Management API to send to connections
let connectionManager: PostgresConnectionManager | null = null;

async function getConnectionManager(): Promise<PostgresConnectionManager> {
  if (!connectionManager) {
    // Ensure storage is initialized first
    await ensureStorageInitialized();

    // Convert wss:// to https:// for API Gateway Management API
    const httpsEndpoint = WEBSOCKET_ENDPOINT.replace('wss://', 'https://');

    const sender = new ApiGatewaySender({
      endpoint: httpsEndpoint,
      region: REGION,
    });

    connectionManager = createPostgresConnectionManager({
      storage,
      sender,
    });
  }
  return connectionManager;
}

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
// Lambda Handler
// =============================================================================

// App and handler are lazily initialized on first request
// This allows async initialization of storage and connection manager
let honoHandler: ReturnType<typeof handle> | null = null;

async function getHandler() {
  if (!honoHandler) {
    // Ensure storage and connection manager are initialized
    await ensureStorageInitialized();
    const manager = await getConnectionManager();

    // Create the app with real connection manager for broadcasting
    const app = createApp({
      storage,
      runtime,
      connectionManager: manager,
    });

    honoHandler = handle(app);
  }
  return honoHandler;
}

export const handler = async (event: APIGatewayProxyEventV2, context: Context) => {
  // Get or create the handler (initializes storage and connection manager)
  const h = await getHandler();

  // Strip the stage prefix from the path if present
  // API Gateway sends /stag/health but Hono expects /health
  const stage = event.requestContext?.stage;
  if (stage && event.rawPath?.startsWith(`/${stage}`)) {
    event.rawPath = event.rawPath.slice(stage.length + 1) || '/';
  }

  return h(event, context);
};
