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
import { serve } from '@hono/node-server';
import { verifyContainerToken, extractContainerToken } from './auth.js';
import {
  initializeConfig,
  registerService,
  unregisterService,
  getService,
  getServiceOwner,
  listServices,
  buildServiceId,
} from './config.js';
import { randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';

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
 * Request: { tunnelHash: "...", serviceName?: "..." }
 * Response: {
 *   success: true,
 *   serviceToken: "...",  // Token for rathole connection
 *   controlPort: 2333,    // Rathole control port to connect to
 *   serviceName: "..."    // Service ID to use in client config ({serviceName}-{hash} or {hash})
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

  // Get tunnel hash and optional service name from request body
  let tunnelHash: string;
  let serviceName: string | undefined;
  try {
    const body = await c.req.json();
    tunnelHash = body.tunnelHash;
    serviceName = body.serviceName;
  } catch {
    return c.json({ success: false, error: 'Invalid request body' }, 400);
  }

  if (!tunnelHash || typeof tunnelHash !== 'string' || tunnelHash.length < 32) {
    return c.json({ success: false, error: 'Invalid tunnelHash' }, 400);
  }

  // Validate serviceName if provided
  if (serviceName !== undefined && typeof serviceName !== 'string') {
    return c.json({ success: false, error: 'Invalid serviceName' }, 400);
  }

  // Generate a unique token for this service (rathole uses this to authenticate)
  const serviceToken = randomBytes(32).toString('hex');

  // Register service in rathole config with owner info for auth verification
  const result = registerService(
    tunnelHash,
    serviceToken,
    {
      spaceId: payload.spaceId,
      channelId: payload.channelId,
      callsign: payload.callsign,
    },
    serviceName
  );

  // Check for registration error
  if ('error' in result) {
    return c.json({ success: false, error: result.error }, 400);
  }

  const service = result;
  console.log(
    `[Register] Container ${payload.callsign} registered ${service.serviceId} on port ${service.port}`
  );

  return c.json({
    success: true,
    serviceToken: service.token,  // Use token from service entry (handles re-registration)
    serviceName: service.serviceId,  // Return full serviceId for rathole config
    controlPort: parseInt(process.env.RATHOLE_CONTROL_PORT || '2333', 10),
    controlHost: process.env.RATHOLE_CONTROL_HOST || undefined,
    assignedPort: service.port,
  });
});

/**
 * DELETE /clients/:serviceId
 *
 * Unregister a tunnel client.
 * Requires CAST_AUTH_TOKEN from the container that originally registered this service.
 *
 * serviceId can be:
 * - {serviceName}-{hash} for named services
 * - {hash} for the default service
 */
app.delete('/clients/:serviceId', async (c) => {
  const serviceId = c.req.param('serviceId');

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

  // Verify the requester owns this service
  const owner = getServiceOwner(serviceId);
  if (!owner) {
    // Service exists in TOML but owner unknown (server restarted)
    // Allow deletion if service exists - the container re-registering will reclaim ownership
    const service = getService(serviceId);
    if (!service) {
      return c.json({ success: false, error: 'Service not found' }, 404);
    }
    console.log(`[Unregister] Owner unknown for ${serviceId}, allowing deletion by ${payload.callsign}`);
  } else {
    // Verify ownership: must match spaceId, channelId, and callsign
    if (
      owner.spaceId !== payload.spaceId ||
      owner.channelId !== payload.channelId ||
      owner.callsign !== payload.callsign
    ) {
      console.log(
        `[Unregister] Denied: ${payload.callsign} tried to unregister ${serviceId} owned by ${owner.callsign}`
      );
      return c.json({ success: false, error: 'Not authorized to unregister this service' }, 403);
    }
  }

  const removed = unregisterService(serviceId);
  if (!removed) {
    return c.json({ success: false, error: 'Service not found' }, 404);
  }

  console.log(`[Unregister] Container ${payload.callsign} unregistered ${serviceId}`);
  return c.json({ success: true });
});

// =============================================================================
// Debug endpoints removed for security
// =============================================================================
// GET /clients/:hash and GET /clients were removed because they exposed
// tunnel hashes, which are credentials in the URL-as-auth model.
// See: tunnel-audit-v1 for details.
//
// If admin debugging is needed, add proper authentication or use
// CloudWatch logs / direct ECS exec instead.

// =============================================================================
// Host-Based Routing Proxy
// =============================================================================

/**
 * Catch-all handler for user traffic.
 *
 * Extracts serviceId from Host header and proxies to rathole port.
 *
 * URL formats:
 * - {hash}.domain           -> serviceId = {hash} (default service)
 * - {serviceName}-{hash}.domain -> serviceId = {serviceName}-{hash} (named service)
 *
 * Note: This is a simple implementation. For production, consider using
 * a dedicated reverse proxy like nginx for better performance.
 */
app.all('*', async (c) => {
  const host = c.req.header('Host');
  if (!host) {
    return c.json({ error: 'No Host header' }, 400);
  }

  // Extract serviceId from subdomain
  // Format: {serviceName}-{hash}.domain or {hash}.domain
  // Hash is 32+ hex characters
  const subdomainMatch = host.match(/^([a-z0-9-]+)\./);
  if (!subdomainMatch) {
    // Not a tunnel request, could be direct access to tunnel server
    return c.json({ error: 'Invalid host format' }, 400);
  }

  const subdomain = subdomainMatch[1];

  // Parse subdomain to extract serviceId
  // Try to match {serviceName}-{hash} first, then just {hash}
  // Hash is 32+ hex chars at the end
  const serviceMatch = subdomain.match(/^(?:([a-z0-9]+)-)?([a-f0-9]{32,})$/);
  if (!serviceMatch) {
    return c.json({ error: 'Invalid tunnel URL format' }, 400);
  }

  const serviceName = serviceMatch[1];  // undefined for default service
  const hash = serviceMatch[2];
  const serviceId = serviceName ? `${serviceName}-${hash}` : hash;

  const service = getService(serviceId);

  if (!service) {
    return c.json({ error: 'Tunnel not found' }, 404);
  }

  // Proxy to rathole port
  const targetUrl = new URL(c.req.url);
  targetUrl.host = `localhost:${service.port}`;
  targetUrl.protocol = 'http:';

  console.log(`[Proxy] Starting proxy request to ${serviceId} on port ${service.port}`);
  console.log(`[Proxy] Target URL: ${targetUrl.toString()}`);
  console.log(`[Proxy] Method: ${c.req.method}, Path: ${new URL(c.req.url).pathname}`);

  // First, test raw TCP connectivity to the rathole port
  const tcpTestStart = Date.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: service.port }, () => {
        console.log(`[Proxy] TCP connect to port ${service.port} succeeded in ${Date.now() - tcpTestStart}ms`);
        socket.end();
        resolve();
      });
      socket.on('error', (err) => {
        console.error(`[Proxy] TCP connect to port ${service.port} failed:`, err.message);
        reject(err);
      });
      socket.setTimeout(5000, () => {
        console.error(`[Proxy] TCP connect to port ${service.port} timed out`);
        socket.destroy();
        reject(new Error('TCP connect timeout'));
      });
    });
  } catch (tcpErr) {
    console.error(`[Proxy] TCP test failed for ${serviceId}:`, tcpErr);
    return c.json({ error: 'Tunnel port not responding', details: String(tcpErr) }, 502);
  }

  try {
    console.log(`[Proxy] Creating fetch request to ${targetUrl.toString()}`);
    const proxyReq = new Request(targetUrl.toString(), {
      method: c.req.method,
      headers: c.req.raw.headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      duplex: 'half',
    });

    console.log(`[Proxy] Executing fetch...`);
    const fetchStart = Date.now();
    const response = await fetch(proxyReq);
    console.log(`[Proxy] Fetch completed in ${Date.now() - fetchStart}ms, status: ${response.status}`);

    // Return proxied response
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    console.error(`[Proxy] Error proxying to ${serviceId}:`, error);
    return c.json({ error: 'Proxy error', details: String(error) }, 502);
  }
});

// =============================================================================
// Server Startup
// =============================================================================

const port = parseInt(process.env.PORT || '8080', 10);

console.log(`[TunnelServer] Starting on port ${port}`);
console.log(`[TunnelServer] Rathole control port: ${process.env.RATHOLE_CONTROL_PORT || '2333'}`);

// Start the server using @hono/node-server (not Bun default exports)
serve({
  fetch: app.fetch,
  port,
}, (info) => {
  console.log(`[TunnelServer] Listening on http://localhost:${info.port}`);
});
