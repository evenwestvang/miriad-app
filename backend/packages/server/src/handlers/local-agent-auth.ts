/**
 * Local Agent Server Auth Handlers
 *
 * REST API routes for local agent server authentication.
 *
 * Endpoints:
 * - POST /api/local-agents/bootstrap-token    - Generate bootstrap token (UI)
 * - POST /api/local-agents/bootstrap          - Exchange bootstrap for server credentials (CLI)
 * - POST /api/local-agents/agent-token        - Issue agent token (server requests)
 *
 * Flow:
 * 1. User clicks "Connect Local Agent" in CAST UI
 * 2. UI calls /bootstrap-token → gets connection string
 * 3. User runs `init "cast://..."` command
 * 4. CLI calls /bootstrap → exchanges token for server credentials
 * 5. Server uses credentials to request agent tokens via /agent-token
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { createHmac, randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Storage } from '@cast/storage';
import { generateContainerToken, parseSession } from '../auth/index.js';

// =============================================================================
// Configuration
// =============================================================================

// Secret for signing server credentials (use env var in production)
const SERVER_SECRET = process.env.CAST_SERVER_SECRET ?? 'cast-dev-server-secret-do-not-use-in-production';

if (!process.env.CAST_SERVER_SECRET) {
  console.log('[LocalAgentAuth] Using dev secret (set CAST_SERVER_SECRET in production)');
}

// Bootstrap token expiry (10 minutes)
const BOOTSTRAP_TOKEN_TTL_MS = 10 * 60 * 1000;

// =============================================================================
// Types
// =============================================================================

export interface LocalAgentAuthOptions {
  /** Storage backend */
  storage: Storage;
  /** API host for connection string (e.g., api.cast.dev) */
  apiHost: string;
  /** WebSocket host for connection string (e.g., ws.cast.dev) */
  wsHost: string;
}

interface BootstrapToken {
  token: string;
  spaceId: string;
  userId: string;
  expiresAt: Date;
  consumed: boolean;
}

interface ServerCredentials {
  serverId: string;
  spaceId: string;
  userId: string;
  secret: string;
  createdAt: Date;
  revokedAt: Date | null;
}

// In-memory storage for bootstrap tokens (short-lived, no persistence needed)
const bootstrapTokens = new Map<string, BootstrapToken>();

// In-memory storage for server credentials (should be persisted in production)
// For Stage 3 MVP, we'll use in-memory; can add DB storage later
const serverCredentials = new Map<string, ServerCredentials>();

// =============================================================================
// Zod Schemas
// =============================================================================

const BootstrapTokenRequestSchema = z.object({
  // No required fields - uses session for spaceId
});

const BootstrapExchangeSchema = z.object({
  bootstrapToken: z.string().min(1),
});

const AgentTokenRequestSchema = z.object({
  channelId: z.string().min(1),
  callsign: z.string().min(1),
});

// =============================================================================
// Helper Functions
// =============================================================================

function generateBootstrapToken(): string {
  return `bst_${randomBytes(24).toString('base64url')}`;
}

function generateServerId(): string {
  return `srv_${ulid()}`;
}

function generateServerSecret(serverId: string, spaceId: string): string {
  // HMAC-signed server secret
  const data = `${serverId}:${spaceId}`;
  const hmac = createHmac('sha256', SERVER_SECRET).update(data).digest('base64url');
  return `sk_cast_${hmac}`;
}

function verifyServerSecret(secret: string): { serverId: string; spaceId: string } | null {
  // Find matching server credentials
  for (const creds of serverCredentials.values()) {
    if (creds.secret === secret && !creds.revokedAt) {
      return { serverId: creds.serverId, spaceId: creds.spaceId };
    }
  }
  return null;
}

function formatZodError(error: z.ZodError): { error: string; details: Array<{ path: string; message: string }> } {
  return {
    error: 'validation_error',
    details: error.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    })),
  };
}

// Cleanup expired bootstrap tokens periodically
setInterval(() => {
  const now = new Date();
  for (const [token, data] of bootstrapTokens.entries()) {
    if (data.expiresAt < now || data.consumed) {
      bootstrapTokens.delete(token);
    }
  }
}, 60 * 1000); // Every minute

// =============================================================================
// Route Factory
// =============================================================================

export function createLocalAgentAuthRoutes(options: LocalAgentAuthOptions): Hono {
  const { storage, apiHost, wsHost } = options;
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // POST /bootstrap-token - Generate bootstrap token (UI calls this)
  // ---------------------------------------------------------------------------
  app.post('/bootstrap-token', async (c) => {
    // Get user session (parse directly since middleware types aren't available here)
    const session = await parseSession(c);

    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const { userId, spaceId } = session;

    // Generate bootstrap token
    const token = generateBootstrapToken();
    const expiresAt = new Date(Date.now() + BOOTSTRAP_TOKEN_TTL_MS);

    // Store token
    bootstrapTokens.set(token, {
      token,
      spaceId,
      userId,
      expiresAt,
      consumed: false,
    });

    // Build connection string and command
    const connectionString = `cast://${token}@${apiHost}/${spaceId}`;
    const command = `npx @anthropic/cast-local-agent init "${connectionString}"`;

    return c.json({
      bootstrapToken: token,
      expiresAt: expiresAt.toISOString(),
      connectionString,
      command,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /bootstrap - Exchange bootstrap token for server credentials (CLI)
  // ---------------------------------------------------------------------------
  app.post('/bootstrap', async (c) => {
    // Parse request body
    const body = await c.req.json().catch(() => ({}));
    const parsed = BootstrapExchangeSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { bootstrapToken } = parsed.data;

    // Look up bootstrap token
    const tokenData = bootstrapTokens.get(bootstrapToken);

    if (!tokenData) {
      return c.json({ error: 'Invalid or expired bootstrap token' }, 401);
    }

    if (tokenData.consumed) {
      return c.json({ error: 'Bootstrap token already consumed' }, 409);
    }

    if (tokenData.expiresAt < new Date()) {
      bootstrapTokens.delete(bootstrapToken);
      return c.json({ error: 'Bootstrap token expired' }, 401);
    }

    // Mark token as consumed
    tokenData.consumed = true;

    // Generate server credentials
    const serverId = generateServerId();
    const secret = generateServerSecret(serverId, tokenData.spaceId);

    // Store server credentials
    const credentials: ServerCredentials = {
      serverId,
      spaceId: tokenData.spaceId,
      userId: tokenData.userId,
      secret,
      createdAt: new Date(),
      revokedAt: null,
    };
    serverCredentials.set(serverId, credentials);

    console.log(`[LocalAgentAuth] Issued server credentials ${serverId} for space ${tokenData.spaceId}`);

    return c.json({
      serverId,
      secret,
      spaceId: tokenData.spaceId,
      host: apiHost,
      wsHost,
    });
  });

  // ---------------------------------------------------------------------------
  // POST /agent-token - Issue agent token (server requests this)
  // ---------------------------------------------------------------------------
  app.post('/agent-token', async (c) => {
    // Parse Authorization header
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Server ')) {
      return c.json({ error: 'Authorization header required (Server <secret>)' }, 401);
    }

    const secret = authHeader.slice(7); // Remove 'Server ' prefix
    const serverAuth = verifyServerSecret(secret);

    if (!serverAuth) {
      return c.json({ error: 'Invalid server credentials' }, 401);
    }

    // Parse request body
    const body = await c.req.json().catch(() => ({}));
    const parsed = AgentTokenRequestSchema.safeParse(body);

    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { channelId, callsign } = parsed.data;

    // Verify channel exists and belongs to server's space
    const channel = await storage.getChannelById(channelId);

    if (!channel) {
      return c.json({ error: 'Channel not found' }, 404);
    }

    if (channel.spaceId !== serverAuth.spaceId) {
      return c.json({ error: 'Channel not accessible from this space' }, 403);
    }

    // Generate agent token (same format as containers)
    const token = generateContainerToken({
      spaceId: serverAuth.spaceId,
      channelId,
      callsign,
    });

    console.log(`[LocalAgentAuth] Issued agent token for ${callsign} in channel ${channelId}`);

    return c.json({ token });
  });

  // ---------------------------------------------------------------------------
  // GET /servers - List active servers for current user (UI calls this)
  // ---------------------------------------------------------------------------
  app.get('/servers', async (c) => {
    // Get user session
    const session = await parseSession(c);

    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const servers = getServerCredentialsByUser(session.userId);

    // Format response for frontend
    const formattedServers = servers.map((s) => ({
      serverId: s.serverId,
      spaceId: s.spaceId,
      connectedAt: s.createdAt.toISOString(),
      // Note: agentCount would require tracking active connections per server
      // For now, return 0 — can be enhanced later
      agentCount: 0,
      status: 'active',
    }));

    return c.json({ servers: formattedServers });
  });

  // ---------------------------------------------------------------------------
  // DELETE /servers/:id - Revoke a server (UI calls this)
  // ---------------------------------------------------------------------------
  app.delete('/servers/:id', async (c) => {
    // Get user session
    const session = await parseSession(c);

    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const serverId = c.req.param('id');

    // Verify server belongs to user before revoking
    const servers = getServerCredentialsByUser(session.userId);
    const server = servers.find((s) => s.serverId === serverId);

    if (!server) {
      return c.json({ error: 'Server not found' }, 404);
    }

    const revoked = revokeServerCredentials(serverId);

    if (!revoked) {
      return c.json({ error: 'Failed to revoke server' }, 500);
    }

    return c.json({ success: true });
  });

  return app;
}

// =============================================================================
// Server Auth Middleware (for WebSocket)
// =============================================================================

export interface ServerAuthResult {
  serverId: string;
  spaceId: string;
  userId: string;
}

/**
 * Verify server credentials from Authorization header.
 * For use in WebSocket upgrade handler.
 */
export function verifyServerAuth(authHeader: string | undefined): ServerAuthResult | null {
  if (!authHeader?.startsWith('Server ')) {
    return null;
  }

  const secret = authHeader.slice(7);
  const serverAuth = verifyServerSecret(secret);

  if (!serverAuth) {
    return null;
  }

  // Get full credentials
  const creds = serverCredentials.get(serverAuth.serverId);
  if (!creds) {
    return null;
  }

  return {
    serverId: creds.serverId,
    spaceId: creds.spaceId,
    userId: creds.userId,
  };
}

/**
 * Get all server credentials for a user (for UI listing).
 */
export function getServerCredentialsByUser(userId: string): Array<{
  serverId: string;
  spaceId: string;
  createdAt: Date;
}> {
  const results: Array<{ serverId: string; spaceId: string; createdAt: Date }> = [];

  for (const creds of serverCredentials.values()) {
    if (creds.userId === userId && !creds.revokedAt) {
      results.push({
        serverId: creds.serverId,
        spaceId: creds.spaceId,
        createdAt: creds.createdAt,
      });
    }
  }

  return results;
}

/**
 * Revoke server credentials.
 */
export function revokeServerCredentials(serverId: string): boolean {
  const creds = serverCredentials.get(serverId);
  if (!creds || creds.revokedAt) {
    return false;
  }

  creds.revokedAt = new Date();
  console.log(`[LocalAgentAuth] Revoked server credentials ${serverId}`);
  return true;
}
