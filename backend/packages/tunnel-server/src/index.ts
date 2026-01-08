/**
 * Tunnel Server - Auth wrapper + health endpoint for rathole
 *
 * This service provides:
 * 1. Health check endpoint for ALB
 * 2. Auth validation endpoint for tunnel connections
 * 3. Management API for dynamic client registration (future)
 *
 * Architecture:
 * - ALB routes /health and /auth/* to this service
 * - rathole handles actual tunnel connections
 * - Container clients authenticate through this service before connecting to rathole
 */

import { Hono } from 'hono';
import { verifyContainerToken, extractContainerToken } from './auth.js';

const app = new Hono();

// =============================================================================
// Health Check
// =============================================================================

app.get('/health', (c) => {
  return c.json({ status: 'healthy', service: 'cast-tunnel-server' });
});

// =============================================================================
// Auth Validation Endpoint
// =============================================================================

/**
 * POST /auth/validate
 *
 * Container clients call this to validate their token and get their tunnel hash.
 * Request: { token: "..." } or Authorization: Container <token> header
 * Response: { valid: true, tunnelHash: "...", payload: {...} } or { valid: false }
 *
 * Note: tunnelHash lookup requires a call to CAST backend or database access.
 * For now, we just validate the token format. The tunnel hash mapping
 * will be added in Task 4 (backend integration).
 */
app.post('/auth/validate', async (c) => {
  // Get token from body or header
  let token: string | null = null;

  const authHeader = c.req.header('Authorization');
  token = extractContainerToken(authHeader);

  if (!token) {
    try {
      const body = await c.req.json();
      token = body.token;
    } catch {
      // Ignore JSON parse errors
    }
  }

  if (!token) {
    return c.json({ valid: false, error: 'No token provided' }, 401);
  }

  const payload = verifyContainerToken(token);
  if (!payload) {
    return c.json({ valid: false, error: 'Invalid token' }, 401);
  }

  // TODO: Look up tunnelHash from roster table based on payload
  // For now, return placeholder - this will be implemented in Task 4
  return c.json({
    valid: true,
    payload,
    // tunnelHash: await getTunnelHashFromRoster(payload),
    message: 'Token valid. tunnelHash lookup to be implemented in Task 4.',
  });
});

// =============================================================================
// Management API (Future)
// =============================================================================

/**
 * These endpoints will be used for dynamic client registration
 * once we determine the best approach from @fox's rathole research.
 *
 * Potential endpoints:
 * - POST /clients/register - Register a new tunnel client
 * - DELETE /clients/:hash - Remove a tunnel client
 * - GET /clients/:hash/status - Check connection status
 */

// =============================================================================
// Server Startup
// =============================================================================

const port = parseInt(process.env.PORT || '2333', 10);

console.log(`[TunnelServer] Starting on port ${port}`);

export default {
  port,
  fetch: app.fetch,
};
