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
import { createLocalConnectionManager, type LocalConnectionInfo } from './websocket/index.js';
import { createPostgresStorage, type Storage } from '@cast/storage';
import { DockerRuntime, FlyRuntime, AgentStateManager } from '@cast/runtime';
import { createRuntimeConnectionManager } from './runtimes/index.js';
import { WebSocketServer, WebSocket } from 'ws';
import type { Duplex } from 'stream';
import { parseSessionCookie, verifySessionToken } from './auth/index.js';

// =============================================================================
// Configuration
// =============================================================================

const port = parseInt(process.env.PORT ?? '3234', 10);
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
  // Note: Database migrations are run separately via: pnpm --filter @cast/storage migrate
  console.log('✅ Storage connected');

  // ---------------------------------------------------------------------------
  // Initialize WebSocket Connection Manager with sync handler
  // ---------------------------------------------------------------------------

  // Track authorized channels per connection to avoid repeated auth checks
  type ExtendedConnection = LocalConnectionInfo & {
    session?: { userId: string; spaceId: string };
    authorizedChannels?: Set<string>;
  };

  const connectionManager = createLocalConnectionManager({
    storage,
    onSyncRequest: async (connection: LocalConnectionInfo, channelId: string, since?: string, before?: string, limit?: number) => {
      console.log(`[Sync] Received sync request for channel: ${channelId}, since: ${since}, before: ${before}, limit: ${limit}`);
      const t0 = performance.now();
      try {
        const extConn = connection as ExtendedConnection;
        const session = extConn.session;
        console.log(`[Sync] Session: ${session ? `userId=${session.userId}, spaceId=${session.spaceId}` : 'none'}`);
        console.log(`[Sync] Connection channelId: ${connection.channelId}`);

        // Check if channel is already authorized (cache hit)
        const isAuthorized = extConn.authorizedChannels?.has(channelId);

        if (!isAuthorized) {
          // Authorize channel access (only on first access to this channel)
          const channel = await storage.getChannelById(channelId);
          if (!channel) {
            console.log(`[Sync] Channel not found: ${channelId}`);
            connection.ws.send(JSON.stringify({ error: 'channel_not_found', message: 'Channel not found' }));
            return;
          }

          if (session && channel.spaceId !== session.spaceId) {
            console.log(`[Sync] User ${session.userId} not authorized for channel ${channelId}`);
            connection.ws.send(JSON.stringify({ error: 'forbidden', message: 'Not authorized for this channel' }));
            return;
          }

          // Cache authorization
          if (!extConn.authorizedChannels) {
            extConn.authorizedChannels = new Set();
          }
          extConn.authorizedChannels.add(channelId);
        }

        // Switch channel if different from current
        if (channelId !== connection.channelId) {
          connectionManager.switchChannel(connection.connectionId, channelId);
        }

        // Fetch message history and send to client
        // Use provided limit, default to 25 for fast initial sync
        const effectiveLimit = limit ?? 25;
        const messages = await storage.getMessagesByChannelId(channelId, {
          since,
          before,
          limit: effectiveLimit,
          // Get newest messages for initial sync (no cursors), oldest-first for incremental
          newestFirst: !since && !before,
          includeToolCalls: true,
        });
        const t1 = performance.now();

        // Build NDJSON payload with all messages + sync response
        // Each frame includes 'c' (channelId) so client can route messages correctly
        const frames = messages.map(msg => {
          // For tool_call and tool_result messages, the content is stored as a JSON string
          // containing the full message data. We need to extract and flatten these fields
          // so the frontend receives them in the same format as streaming messages.
          // Include method and attachmentSlugs from metadata
          const metadata = msg.metadata as { method?: string; attachmentSlugs?: string[] } | undefined;
          let frameValue: Record<string, unknown> = {
            type: msg.type,
            content: msg.content,
            sender: msg.sender,
            senderType: msg.senderType,
            ...(metadata?.method && { method: metadata.method }),
            ...(metadata?.attachmentSlugs?.length && { attachmentSlugs: metadata.attachmentSlugs }),
          };

          if (msg.type === 'tool_call' || msg.type === 'tool_result') {
            try {
              // Content may be a JSON string or already an object
              const parsed = typeof msg.content === 'string'
                ? JSON.parse(msg.content)
                : msg.content;

              if (msg.type === 'tool_call') {
                frameValue = {
                  type: 'tool_call',
                  sender: parsed.sender || msg.sender,
                  senderType: parsed.senderType || msg.senderType,
                  toolCallId: parsed.toolCallId,
                  name: parsed.name,
                  args: parsed.args,
                };
              } else if (msg.type === 'tool_result') {
                frameValue = {
                  type: 'tool_result',
                  sender: parsed.sender || msg.sender,
                  senderType: parsed.senderType || msg.senderType,
                  toolCallId: parsed.toolCallId,
                  content: parsed.content,
                  isError: parsed.isError,
                };
              }
            } catch {
              // If parsing fails, fall back to original format
              console.warn(`[Sync] Failed to parse ${msg.type} content:`, msg.id);
            }
          }

          return JSON.stringify({
            i: msg.id,
            t: msg.timestamp,
            v: frameValue,
            c: channelId, // Channel ID for client routing
          });
        });

        // Add sync response at the end
        // Include hasMore flag - if we got fewer messages than requested, there are no more
        const hasMore = messages.length >= effectiveLimit;
        frames.push(JSON.stringify({
          sync: new Date().toISOString(),
          hasMore,
          // Include first message ID for client to use as 'before' cursor for next request
          oldestId: messages.length > 0 ? messages[0].id : undefined,
        }));
        const t2 = performance.now();

        // Send all frames as single NDJSON payload
        if (connection.ws.readyState === WebSocket.OPEN) {
          connection.ws.send(frames.join('\n'));
        }
        const t3 = performance.now();

        console.log(`[Sync] Timing: auth+getMessages=${(t1-t0).toFixed(1)}ms, serialize=${(t2-t1).toFixed(1)}ms, send=${(t3-t2).toFixed(1)}ms, total=${(t3-t0).toFixed(1)}ms (${messages.length} msgs)`);
      } catch (error) {
        console.error('[Sync] Error:', error);
      }
    },
  });

  // Initialize the connection manager (creates ws_connections table)
  await connectionManager.initialize();
  console.log('✅ Connection manager initialized');

  // ---------------------------------------------------------------------------
  // Initialize Agent Runtime (AGENT_RUNTIME=fly for Fly.io, default=docker)
  // ---------------------------------------------------------------------------

  const agentRuntime = process.env.AGENT_RUNTIME ?? 'docker';

  let runtime;
  if (agentRuntime === 'fly') {
    const flyApiToken = process.env.FLY_API_TOKEN;
    const flyAppName = process.env.FLY_APP_NAME;
    if (!flyApiToken || !flyAppName) {
      console.error('❌ AGENT_RUNTIME=fly requires FLY_API_TOKEN and FLY_APP_NAME');
      process.exit(1);
    }
    const flyMemoryMb = parseInt(process.env.FLY_MEMORY_MB ?? '8192', 10);
    const flyCpus = parseInt(process.env.FLY_CPUS ?? '4', 10);
    const flyCpuKind = (process.env.FLY_CPU_KIND ?? 'performance') as 'shared' | 'performance';
    runtime = new FlyRuntime({
      flyAppName,
      flyApiToken,
      flyRegion: process.env.FLY_REGION ?? 'iad',
      imageName: process.env.FLY_IMAGE ?? 'registry.fly.io/cast-agent-spike:latest',
      castApiUrl: process.env.CAST_API_URL ?? `http://host.docker.internal:${port}`,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
      storage,
      spaceId,
      memoryMb: flyMemoryMb,
      cpus: flyCpus,
      cpuKind: flyCpuKind,
    });
    console.log(`✅ Fly.io runtime initialized: ${flyCpus} ${flyCpuKind} CPUs, ${flyMemoryMb}MB`);
  } else if (agentRuntime === 'docker') {
    runtime = new DockerRuntime({
      imageName: process.env.AGENT_IMAGE ?? 'claude-code:local',
      castApiUrl: process.env.CAST_API_URL ?? `http://host.docker.internal:${port}`,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    });
    console.log('✅ Docker runtime initialized');
  } else {
    console.error(`❌ Unknown AGENT_RUNTIME: ${agentRuntime}. Use 'fly' or 'docker'.`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Initialize Runtime Connection Manager (for LocalRuntime WS connections)
  // ---------------------------------------------------------------------------

  const agentStateManager = new AgentStateManager();
  const runtimeConnectionManager = createRuntimeConnectionManager({
    storage,
    connectionManager,
    agentStateManager,
    requireAuth: false, // Dev mode - no auth required
    pingIntervalMs: 60000,
  });
  console.log('✅ Runtime connection manager initialized');

  // ---------------------------------------------------------------------------
  // Create App
  // ---------------------------------------------------------------------------

  const app = createApp({
    storage,
    runtime,
    connectionManager,
    runtimeSend: (connectionId, data) => runtimeConnectionManager.send(connectionId, data),
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

  // WebSocket server for /stream and /runtimes/connect
  const wss = new WebSocketServer({ noServer: true });
  const runtimeWss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(request.url ?? '/', `http://localhost:${port}`);
    const pathname = url.pathname;
    const protocol = url.searchParams.get('protocol');

    // ---------------------------------------------------------------------------
    // Runtime WebSocket: /runtimes/connect OR ?protocol=runtime
    // Phase 2a: Dev mode - no auth required
    // Both paths supported for backwards compatibility with existing clients
    // ---------------------------------------------------------------------------
    if (pathname === '/runtimes/connect' || protocol === 'runtime') {
      runtimeWss.handleUpgrade(request, socket, head, (ws) => {
        console.log(`[Runtimes] New WebSocket connection (${pathname === '/runtimes/connect' ? 'path' : 'query param'})`);
        const authHeader = request.headers.authorization;
        runtimeConnectionManager.handleConnection(ws as unknown as WebSocket, authHeader);
      });
      return;
    }

    // ---------------------------------------------------------------------------
    // Channel Stream WebSocket: /stream (persistent connection, channel via sync)
    // Requires session authentication
    // ---------------------------------------------------------------------------
    if (pathname !== '/stream') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // Authenticate via session cookie
    const sessionToken = parseSessionCookie(request.headers.cookie);
    const session = sessionToken ? await verifySessionToken(sessionToken) : null;

    if (!session) {
      console.log(`[WebSocket] Unauthorized connection attempt`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    // Store session on the WebSocket for later channel authorization
    wss.handleUpgrade(request, socket, head, (ws) => {
      console.log(`[WebSocket] User ${session.userId} connected (persistent)`);
      // Use placeholder channel - will be set by first sync request
      const connInfo = connectionManager.addConnection(ws, '__pending__');
      // Attach session to connection for channel auth during sync
      (connInfo as LocalConnectionInfo & { session: typeof session }).session = session;
    });
  });

  server.listen(port, () => {
    console.log(`✅ Server running at http://localhost:${port}`);
    console.log(`   Health check: http://localhost:${port}/health`);
    console.log(`   WebSocket: ws://localhost:${port}/stream`);
    console.log(`   Runtimes: ws://localhost:${port}/runtimes/connect`);
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
