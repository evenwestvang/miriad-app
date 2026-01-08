/**
 * Tunnel Server - Auth wrapper + routing proxy for rathole
 *
 * This service provides:
 * 1. Health check endpoint for ALB
 * 2. Client registration (containers authenticate and get assigned a port)
 * 3. Host-based routing proxy (routes {hash}.domain to correct rathole port)
 *
 * Architecture:
 * - ALB terminates TLS, forwards to Hono on :8080
 * - Container registers via /clients/register with CAST_AUTH_TOKEN
 * - Hono writes service entry to rathole config (hot-reload picks it up)
 * - User traffic: Hono extracts hash from Host header, proxies to rathole port
 * - rathole tunnels traffic to container
 */

import { Hono } from 'hono';
import { verifyContainerToken, extractContainerToken } from './auth.js';
import {
  initializeConfig,
  registerService,
  unregisterService,
  getService,
  listServices,
} from './config.js';
import { randomBytes } from 'node:crypto';

const app = new Hono();

// Initialize rathole config on startup
initializeConfig();

// =============================================================================
// Health Check
// =============================================================================

app.get('/health', (c) => {
  return c.json({
    status: 'healthy',
    service: 'cast-tunnel-server',
    clients: listServices().length,
  });
});

// =============================================================================
// Client Registration API
// =============================================================================

/**
 * POST /clients/register
 *
 * Container calls this to register for tunnel access.
 * Requires CAST_AUTH_TOKEN in Authorization header.
 *
 * Request: { tunnelHash: "..." }
 * Response: {
 *   success: true,
 *   serviceToken: "...",  // Token for rathole connection
 *   controlPort: 2333,    // Rathole control port to connect to
 *   serviceName: "..."    // Service name to use in client config
 * }
 */
app.post('/clients/register', async (c) => {
  // Validate container token
  const authHeader = c.req.header('Authorization');
  const token = extractContainerToken(authHeader);

  if (!token) {
    return c.json({ success: false, error: 'No auth token provided' }, 401);
  }

  const payload = verifyContainerToken(token);
  if (!payload) {
    return c.json({ success: false, error: 'Invalid auth token' }, 401);
  }

  // Get tunnel hash from request body
  let tunnelHash: string;
  try {
    const body = await c.req.json();
    tunnelHash = body.tunnelHash;
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }

  if (!tunnelHash || typeof tunnelHash !== 'string' || tunnelHash.length < 32) {
    return c.json({ success: false, error: 'Invalid tunnelHash' }, 400);
  }

  // Generate a unique token for this service (rathole uses this to authenticate)
  const serviceToken = randomBytes(32).toString('hex');

  // Register service in rathole config
  const service = registerService(tunnelHash, serviceToken);

  console.log(
    `[Register] Container ${payload.callsign} registered hash ${tunnelHash} on port ${service.port}`
  );

  return c.json({
    success: true,
    serviceToken,
    serviceName: tunnelHash,
    controlPort: parseInt(process.env.RATHOLE_CONTROL_PORT || '2333', 10),
    assignedPort: service.port,
  });
});

/**
 * DELETE /clients/:hash
 *
 * Unregister a tunnel client.
 * Requires CAST_AUTH_TOKEN (must match the container that registered).
 */
app.delete('/clients/:hash', async (c) => {
  const hash = c.req.param('hash');

  // Validate container token
  const authHeader = c.req.header('Authorization');
  const token = extractContainerToken(authHeader);

  if (!token) {
    return c.json({ success: false, error: 'No auth token provided' }, 401);
  }

  const payload = verifyContainerToken(token);
  if (!payload) {
    return c.json({ success: false, error: 'Invalid auth token' }, 401);
  }

  // TODO: Verify the token matches the container that registered this hash
  // For now, any valid token can unregister (will be tightened in Task 4)

  const removed = unregisterService(hash);
  if (!removed) {
    return c.json({ success: false, error: 'Service not found' }, 404);
  }

  console.log(`[Unregister] Container ${payload.callsign} unregistered hash ${hash}`);
  return c.json({ success: true });
});

/**
 * GET /clients/:hash
 *
 * Get service info (for debugging).
 */
app.get('/clients/:hash', (c) => {
  const hash = c.req.param('hash');
  const service = getService(hash);

  if (!service) {
    return c.json({ found: false }, 404);
  }

  return c.json({
    found: true,
    hash: service.hash,
    port: service.port,
    // Don't expose token
  });
});

/**
 * GET /clients
 *
 * List all registered clients (for debugging/admin).
 */
app.get('/clients', (c) => {
  const services = listServices();
  return c.json({
    count: services.length,
    clients: services.map((s) => ({ hash: s.hash, port: s.port })),
  });
});

// =============================================================================
// Host-Based Routing Proxy
// =============================================================================

/**
 * Catch-all handler for user traffic.
 *
 * Extracts hash from Host header ({hash}.domain), looks up the rathole port,
 * and proxies the request.
 *
 * Note: This is a simple implementation. For production, consider using
 * a dedicated reverse proxy like nginx for better performance.
 */
app.all('*', async (c) => {
  const host = c.req.header('Host');
  if (!host) {
    return c.json({ error: 'No Host header' }, 400);
  }

  // Extract hash from subdomain: {hash}.containers.domain.com
  const hashMatch = host.match(/^([a-z0-9]+)\./);
  if (!hashMatch) {
    // Not a tunnel request, could be direct access to tunnel server
    return c.json({ error: 'Invalid host format' }, 400);
  }

  const hash = hashMatch[1];
  const service = getService(hash);

  if (!service) {
    return c.json({ error: 'Tunnel not found' }, 404);
  }

  // Proxy to rathole port
  const targetUrl = new URL(c.req.url);
  targetUrl.host = `localhost:${service.port}`;
  targetUrl.protocol = 'http:';

  try {
    const proxyReq = new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      duplex: 'half',
    });

    const response = await fetch(proxyReq);

    // Return proxied response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    console.error(`[Proxy] Error proxying to ${hash}:`, error);
    return c.json({ error: 'Proxy error', details: String(error) }, 502);
  }
});

// =============================================================================
// Server Startup
// =============================================================================

const port = parseInt(process.env.PORT || '8080', 10);

console.log(`[TunnelServer] Starting on port ${port}`);
console.log(`[TunnelServer] Rathole control port: ${process.env.RATHOLE_CONTROL_PORT || '2333'}`);

export default {
  port,
  fetch: app.fetch,
};
