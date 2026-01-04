/**
 * AWS Lambda entry point for Cast backend
 *
 * Uses Hono's AWS Lambda adapter to handle API Gateway requests.
 * Strips the API Gateway stage prefix from paths.
 *
 * NOTE: This is a minimal Lambda handler for Phase 3.
 * In production, you'll need to:
 * - Wire up actual storage (PlanetScale or DynamoDB)
 * - Wire up container orchestrator (Fargate)
 * - Implement WebSocket via API Gateway WebSocket API
 */

import type { APIGatewayProxyEventV2, Context } from 'aws-lambda';
import { Hono } from 'hono';
import { handle } from 'hono/aws-lambda';
import { createApp } from '@cast/server';

// =============================================================================
// Placeholder Dependencies
// =============================================================================

// For Phase 3, we create a minimal working handler
// Production will need real implementations of these interfaces

// Placeholder storage - in production, use createPostgresStorage or DynamoDB adapter
const placeholderStorage = {
  saveMessage: async () => ({} as never),
  getMessage: async () => null,
  getMessages: async () => [],
  updateMessage: async () => {},
  deleteMessage: async () => {},
  createChannel: async () => ({} as never),
  getChannel: async () => null,
  getChannelByName: async () => null,
  listChannels: async () => [],
  updateChannel: async () => {},
  archiveChannel: async () => {},
  addToRoster: async () => ({} as never),
  getRosterEntry: async () => null,
  getRosterByCallsign: async () => null,
  listRoster: async () => [],
  updateRosterEntry: async () => {},
  removeFromRoster: async () => {},
  initialize: async () => {},
  close: async () => {},
};

// Placeholder orchestrator - in production, use FargateOrchestrator
const placeholderOrchestrator = {
  spawn: async () => ({ threadId: '', containerId: '', status: 'running' as const }),
  sendMessage: async () => {},
  getState: async () => null,
  stop: async () => {},
  stopAll: async () => {},
};

// Placeholder connection manager - Lambda uses API Gateway WebSocket API
const placeholderConnectionManager = {
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

// =============================================================================
// Create App
// =============================================================================

const app = createApp({
  storage: placeholderStorage,
  orchestrator: placeholderOrchestrator,
  connectionManager: placeholderConnectionManager,
  spaceId: process.env.SPACE_ID ?? 'default-space',
});

// =============================================================================
// Lambda Handler
// =============================================================================

const honoHandler = handle(app);

export const handler = async (event: APIGatewayProxyEventV2, context: Context) => {
  // Strip the stage prefix from the path if present
  // API Gateway sends /stag/health but Hono expects /health
  const stage = event.requestContext?.stage;
  if (stage && event.rawPath?.startsWith(`/${stage}`)) {
    event.rawPath = event.rawPath.slice(stage.length + 1) || '/';
  }

  return honoHandler(event, context);
};
