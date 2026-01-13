/**
 * AWS Lambda entry point for Cast backend
 *
 * Uses Hono's AWS Lambda adapter to handle API Gateway requests.
 * Strips the API Gateway stage prefix from paths.
 *
 * Uses real PlanetScale storage and PostgresConnectionManager.
 * Agent runtime uses Fly.io for container orchestration.
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
import { FlyRuntime, type AgentRuntime } from '@cast/runtime';

// =============================================================================
// Configuration
// =============================================================================

const WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_ENDPOINT ?? '';
const PLANETSCALE_URL = process.env.PLANETSCALE_URL!;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

// Fly.io configuration
const FLY_API_TOKEN = process.env.FLY_API_TOKEN ?? '';
const FLY_APP_NAME = process.env.FLY_APP_NAME ?? 'cast-containers-staging';
const FLY_REGION = process.env.FLY_REGION ?? 'iad';
const FLY_IMAGE = process.env.FLY_IMAGE ?? '';
const CAST_API_URL = process.env.CAST_API_URL ?? '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';
const SPACE_ID = process.env.SPACE_ID ?? 'default';

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

// =============================================================================
// Fly.io Runtime
// =============================================================================

// Fly.io runtime for container orchestration
// Falls back to placeholder if Fly env vars are not configured
let runtime: AgentRuntime;

if (FLY_API_TOKEN && FLY_IMAGE && CAST_API_URL && ANTHROPIC_API_KEY) {
  runtime = new FlyRuntime({
    flyAppName: FLY_APP_NAME,
    flyApiToken: FLY_API_TOKEN,
    flyRegion: FLY_REGION,
    imageName: FLY_IMAGE,
    castApiUrl: CAST_API_URL,
    anthropicApiKey: ANTHROPIC_API_KEY,
    storage,
    spaceId: SPACE_ID,
  });
  console.log(`[Lambda] FlyRuntime initialized: app=${FLY_APP_NAME}, region=${FLY_REGION}`);
} else {
  // Placeholder runtime when Fly.io is not configured
  console.warn('[Lambda] FlyRuntime not configured - missing env vars. Using placeholder.');
  console.warn('[Lambda] Required: FLY_API_TOKEN, FLY_IMAGE, CAST_API_URL, ANTHROPIC_API_KEY');
  runtime = {
    activate: async () => ({ agentId: '', containerId: '', port: 8080, status: 'offline' as const, lastActivity: '', createdAt: '' }),
    sendMessage: async () => {},
    suspend: async () => {},
    getStatus: () => null,
    isOnline: () => false,
    getAllOnline: () => [],
    shutdown: async () => {},
  } as AgentRuntime;
}

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
