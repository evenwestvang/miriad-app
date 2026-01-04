/**
 * @cikada/server
 *
 * Cikada Channels Service - HTTP API and WebSocket streaming.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import type { Storage } from '@cikada/storage';
import { createHttpHandler } from './http.js';
import { createWss } from './websocket.js';
import { AgentManager } from './agent-manager.js';
import { createEmbeddingService, createKBIndexer, type KBIndexer } from './embeddings.js';
import { createTymbalFrameHandler } from '@cikada/core';

// =============================================================================
// Types
// =============================================================================

export interface ServerOptions {
  storage: Storage;
  port?: number;
  /** Enable Docker sandbox for Claude Code agents */
  enableSandbox?: boolean;
  /** OpenAI API key for semantic search (optional - uses OPENAI_API_KEY env var if not provided) */
  openaiApiKey?: string;
  /** Enable mock authentication for local development (direct login bypass) */
  mockAuth?: boolean;
  /** Enable Sanity OAuth authentication (uses mock OAuth in dev by default) */
  sanityAuth?: boolean;
  /** Force real Sanity OAuth even in dev mode */
  useSanityOAuth?: boolean;
}

export interface CikadaServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  port: number;
}

// =============================================================================
// Server Factory
// =============================================================================

export function createServer(options: ServerOptions): CikadaServer {
  const { storage, port = 3001, enableSandbox, openaiApiKey, mockAuth, sanityAuth, useSanityOAuth } = options;

  let httpServer: Server;
  let actualPort = port;

  // Placeholder broadcast - will be replaced after WSS is created
  let broadcastFn: (channelId: string, frame: string) => Promise<void> = async () => {};

  // Placeholder AgentManager - needed for tymbalHandler's routeMessage
  let agentManager: AgentManager;

  // Create TymbalFrameHandler for unified frame processing
  // This is shared between HTTP endpoints and AgentManager
  const tymbalHandler = createTymbalFrameHandler({
    storage,
    broadcast: (channelId, frame) => broadcastFn(channelId, frame),
    routeMessage: (spaceId, channelId, sender, content) =>
      agentManager.routeMessage(spaceId, channelId, sender, content),
  });

  // Create AgentManager with TymbalFrameHandler
  agentManager = new AgentManager({
    storage,
    broadcast: (channelId, frame) => broadcastFn(channelId, frame),
    enableSandbox,
    serverPort: port,
    tymbalHandler,
  });

  // Hardcoded spaceId for Phase 1 - later phases will extract from session
  const spaceId = 'default';

  // Create KB indexer for semantic search (optional - requires OpenAI API key)
  let kbIndexer: KBIndexer | undefined;
  const embeddingService = createEmbeddingService({ apiKey: openaiApiKey });
  if (embeddingService) {
    kbIndexer = createKBIndexer({
      embeddingService,
      storage,
      spaceId,
    });
    console.log('[Cikada] Semantic search enabled');
  }

  // Create HTTP handler
  const httpHandler = createHttpHandler({
    storage,
    broadcast: (channelId, frame) => broadcastFn(channelId, frame),
    agentManager,
    kbIndexer,
    embeddingService: embeddingService ?? undefined,
    mockAuth,
    sanityAuth,
    useSanityOAuth,
    authEnabled: mockAuth || sanityAuth,
    baseUrl: `http://localhost:${port}`,
  });

  // Create HTTP server
  httpServer = createHttpServer(httpHandler);

  // Create WebSocket server (auth enabled matches HTTP handler)
  const authEnabled = mockAuth || sanityAuth;
  const wss = createWss({ server: httpServer, storage, authEnabled });
  broadcastFn = wss.broadcast;

  return {
    get port() {
      return actualPort;
    },

    start(): Promise<void> {
      return new Promise((resolve, reject) => {
        httpServer.on('error', reject);
        httpServer.listen(port, () => {
          const addr = httpServer.address();
          if (addr && typeof addr === 'object') {
            actualPort = addr.port;
          }
          console.log(`[Cikada] Server running at http://localhost:${actualPort}`);
          console.log(`[Cikada] WebSocket at ws://localhost:${actualPort}/channels/:channelId/stream`);
          resolve();
        });
      });
    },

    stop(): Promise<void> {
      return new Promise((resolve) => {
        wss.wss.close();
        httpServer.close(() => resolve());
      });
    },
  };
}

// Re-exports
export { createHttpHandler } from './http.js';
export { createWebSocketHandler, createWss } from './websocket.js';
export { AgentManager, parseMentions, type ManagedAgent, type AgentState, type AgentOutput } from './agent-manager.js';
export {
  createEmbeddingService,
  createKBIndexer,
  buildEmbeddingText,
  type EmbeddingService,
  type EmbeddingServiceOptions,
  type KBIndexer,
  type KBIndexerOptions,
} from './embeddings.js';
export { bootstrap, seedSpace, getRootChannelId, type SeedSpaceOptions } from './bootstrap.js';
export {
  createSession,
  verifySession,
  clearSession,
  authMiddleware,
  startSanityAuthFlow,
  handleSanityAuthCallback,
  getOrRegisterClient,
  getAuthStateStorage,
  setAuthStateStorage,
  resetAuthStateStorage,
  createInMemoryAuthStateStorage,
  createDynamoDBAuthStateStorage,
  getOAuthClientStorage,
  setOAuthClientStorage,
  resetOAuthClientStorage,
  createInMemoryOAuthClientStorage,
  createDynamoDBOAuthClientStorage,
  type SessionPayload,
  type AuthenticatedRequest,
  type AuthOptions,
  type SanityUserInfo,
  type AuthStateStorage,
  type DynamoDBAuthStateStorageOptions,
  type OAuthClientStorage,
  type OAuthClientCredentials,
  type DynamoDBOAuthClientStorageOptions,
} from './auth/index.js';
