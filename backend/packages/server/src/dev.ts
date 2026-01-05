/**
 * Local development server
 *
 * Run with: pnpm dev
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from backend root (two levels up from packages/server/src)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../../.env');
console.log(`[dev] Loading .env from: ${envPath}`);
const result = config({ path: envPath, override: true });
if (result.error) {
  console.log(`[dev] .env load error: ${result.error.message}`);
} else {
  console.log(`[dev] .env loaded successfully (overrides shell env)`);
}

import { createServer, type IncomingMessage } from 'http';
import { createApp } from './app.js';
import { createConnectionManager, type ConnectionInfo } from './websocket/index.js';
import { createPostgresStorage, type Storage } from '@cast/storage';
import { DockerOrchestrator } from '@cast/runtime';
import { WebSocketServer, WebSocket } from 'ws';
import type { Duplex } from 'stream';

// =============================================================================
// Configuration
// =============================================================================

const port = parseInt(process.env.PORT ?? '3232', 10);
const spaceId = process.env.SPACE_ID ?? 'default-space';

// Database connection
const connectionString =
  process.env.PLANETSCALE_URL ??
  process.env.DATABASE_URL ??
  (() => {
    // Default local dev connection (PlanetScale)
    const host = 'us-east-2.pg.psdb.cloud';
    const port = '6432';
    const user = process.env.PS_USER ?? '';
    const pass = process.env.PS_PASS ?? '';
    const db = 'postgres';
    if (!user || !pass) {
      console.warn('⚠️  No database credentials found. Set PLANETSCALE_URL or PS_USER/PS_PASS');
      return '';
    }
    return `postgres://${user}:${pass}@${host}:${port}/${db}`;
  })();

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(`Starting Cast backend on http://localhost:${port}`);

  // ---------------------------------------------------------------------------
  // Initialize Storage
  // ---------------------------------------------------------------------------

  if (!connectionString) {
    console.error('❌ No database connection string. Set PLANETSCALE_URL environment variable.');
    process.exit(1);
  }

  const storage = createPostgresStorage({ connectionString });
  await storage.initialize();
  console.log('✅ Storage initialized');

  // ---------------------------------------------------------------------------
  // Initialize WebSocket Connection Manager with sync handler
  // ---------------------------------------------------------------------------

  const connectionManager = createConnectionManager({
    onSyncRequest: async (connection: ConnectionInfo, since?: string) => {
      // Fetch message history and send to client
      try {
        const messages = await storage.getMessages(spaceId, connection.channelId, {
          since,
          limit: 100,
        });

        // Send each message as a SetFrame
        for (const msg of messages) {
          const frame = JSON.stringify({
            i: msg.id,
            t: msg.timestamp,
            v: {
              type: msg.type,
              content: msg.content,
              sender: msg.sender,
              senderType: msg.senderType,
            },
          });
          if (connection.ws.readyState === WebSocket.OPEN) {
            connection.ws.send(frame);
          }
        }
      } catch (error) {
        console.error('[Sync] Error fetching messages:', error);
      }
    },
  });
  console.log('✅ Connection manager initialized');

  // ---------------------------------------------------------------------------
  // Initialize Container Orchestrator (Docker for local dev)
  // ---------------------------------------------------------------------------

  const orchestrator = new DockerOrchestrator({
    imageName: process.env.AGENT_IMAGE ?? 'claude-code:local',
    castApiUrl: process.env.CAST_API_URL ?? `http://host.docker.internal:${port}`,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  });
  console.log('✅ Docker orchestrator initialized');

  // ---------------------------------------------------------------------------
  // Create App
  // ---------------------------------------------------------------------------

  const app = createApp({
    storage,
    orchestrator,
    connectionManager,
    spaceId,
  });

  // ---------------------------------------------------------------------------
  // Start Server with WebSocket Support
  // ---------------------------------------------------------------------------

  // Create HTTP server that handles both Hono routes and WebSocket upgrades
  const server = createServer(async (req, res) => {
    // Convert Node request to Fetch API Request
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value) {
        headers.set(key, Array.isArray(value) ? value[0] : value);
      }
    }

    const fetchReq = new Request(url.toString(), {
      method: req.method,
      headers,
      body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
      duplex: 'half',
    } as RequestInit);

    const response = await app.fetch(fetchReq);

    // Write response
    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (response.body) {
      const reader = response.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      };
      pump().catch((err) => {
        console.error('[HTTP] Response stream error:', err);
        res.end();
      });
    } else {
      res.end();
    }
  });

  // WebSocket server for /channels/:channelId/stream
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://localhost:${port}`);
    const pathname = url.pathname;

    // Match /channels/:channelId/stream
    const match = pathname.match(/^\/channels\/([^/]+)\/stream$/);
    if (!match) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    const channelId = match[1];

    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`[WebSocket] Client connected to channel: ${channelId}`);
      connectionManager.addConnection(ws, channelId);
    });
  });

  server.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
    console.log(`   Health check: http://localhost:${port}/health`);
    console.log(`   WebSocket: ws://localhost:${port}/channels/:channelId/stream`);
    console.log(`   Space ID: ${spaceId}`);
  });

  // ---------------------------------------------------------------------------
  // Graceful Shutdown
  // ---------------------------------------------------------------------------

  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    connectionManager.closeAll();
    server.close();
    await storage.close();
    console.log('✅ Storage closed');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
