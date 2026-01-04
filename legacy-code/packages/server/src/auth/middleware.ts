/**
 * Auth Middleware
 *
 * Extracts spaceId from session and attaches to request.
 * Supports two auth mechanisms:
 * 1. Session cookies (for browser clients)
 * 2. Container tokens (for Docker containers)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { verifySession, type SessionPayload } from './session.js';
import { verifyContainerToken, type ContainerTokenPayload } from './container-token.js';

// =============================================================================
// Types
// =============================================================================

export interface AuthenticatedRequest extends IncomingMessage {
  /** The authenticated user's ID (from JWT sub claim) */
  userId: string;
  /** The space/tenant ID (from JWT spaceId claim) */
  spaceId: string;
  /** The channel ID (from container token, if present) */
  channelId?: string;
  /** The agent callsign (from container token, if present) */
  callsign?: string;
}

export interface AuthOptions {
  /** Whether authentication is enabled */
  enabled: boolean;
}

type RequestHandler = (
  req: IncomingMessage,
  res: ServerResponse
) => void | Promise<void>;

// =============================================================================
// Constants
// =============================================================================

/** Routes that bypass authentication (for auth flows and internal services) */
const PUBLIC_ROUTES = [
  '/mock-auth',
  '/mock-auth/',
  '/mock-auth/login',
  '/mock-auth/callback',
  '/mock-auth/logout',
  '/auth/sanity/login',
  '/auth/sanity/callback',
  '/auth/sanity/logout',
  '/mock-oauth/authorize',
  '/mock-oauth/token',
  '/mock-oauth/register',
  '/mock-oauth/callback',
  '/health',
  '/favicon.ico',
  // Internal endpoints for Docker container callbacks
  '/thread',
];

// Container token auth replaces PUBLIC_ROUTE_PATTERNS - containers authenticate
// with HMAC tokens instead of bypassing auth entirely

// =============================================================================
// Middleware
// =============================================================================

/**
 * Create auth middleware that extracts spaceId from session.
 *
 * If auth is disabled, defaults to spaceId='default'.
 * If auth is enabled, verifies JWT and extracts claims.
 */
export function authMiddleware(
  options: AuthOptions,
  handler: RequestHandler
): RequestHandler {
  return async (req: IncomingMessage, res: ServerResponse) => {
    // Set CORS headers early - before any auth checks that might return 401
    // This ensures the browser can read 401 responses for proper auth handling
    // Note: Cannot use wildcard '*' with credentials - must echo the actual origin
    const origin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Cikada-Token');
    res.setHeader('Access-Control-Allow-Credentials', 'true');

    // Handle preflight requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || '/';
    const pathname = url.split('?')[0];

    // Check if route is public (bypass auth)
    const isPublicRoute = PUBLIC_ROUTES.some(
      (route) => pathname === route || pathname.startsWith(route + '/')
    );

    if (!options.enabled) {
      // Auth disabled - use default space
      (req as AuthenticatedRequest).userId = 'anonymous';
      (req as AuthenticatedRequest).spaceId = 'default';
      return handler(req, res);
    }

    if (isPublicRoute) {
      // Public route - allow without session but still try to extract if present
      const session = await verifySession(req);
      if (session) {
        (req as AuthenticatedRequest).userId = session.userId;
        (req as AuthenticatedRequest).spaceId = session.spaceId;
      } else {
        (req as AuthenticatedRequest).userId = 'anonymous';
        (req as AuthenticatedRequest).spaceId = 'default';
      }
      return handler(req, res);
    }

    // Check for container token (X-Cikada-Token header)
    const containerToken = req.headers['x-cikada-token'] as string | undefined;
    if (containerToken) {
      const tokenPayload = verifyContainerToken(containerToken);
      if (tokenPayload) {
        // Valid container token - authenticate as the agent
        console.log(`[Auth] Container token valid for ${tokenPayload.callsign} (space: ${tokenPayload.spaceId}, channel: ${tokenPayload.channelId})`);
        (req as AuthenticatedRequest).userId = `agent:${tokenPayload.callsign}`;
        (req as AuthenticatedRequest).spaceId = tokenPayload.spaceId;
        (req as AuthenticatedRequest).channelId = tokenPayload.channelId;
        (req as AuthenticatedRequest).callsign = tokenPayload.callsign;
        return handler(req, res);
      }
      // Invalid token - log for debugging
      console.log(`[Auth] Container token invalid or verification failed for ${pathname}`);
    }

    // Session-based auth for browser clients
    const session = await verifySession(req);

    if (!session) {
      // Log auth failure details for debugging
      const hasToken = !!containerToken;
      console.log(`[Auth] 401 Unauthorized: ${pathname} (token present: ${hasToken}, session: none)`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized', message: 'No valid session' }));
      return;
    }

    // Attach session info to request
    (req as AuthenticatedRequest).userId = session.userId;
    (req as AuthenticatedRequest).spaceId = session.spaceId;

    return handler(req, res);
  };
}
