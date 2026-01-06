/**
 * Session Authentication Middleware
 *
 * Middleware that extracts session data from cookies and makes it
 * available to route handlers via Hono context.
 */

import type { Context, Next, MiddlewareHandler } from 'hono';
import { parseSession, type SessionData } from './session.js';

// =============================================================================
// Context Type Extensions
// =============================================================================

/**
 * Variables set by the session middleware.
 * Use with Hono generics: Hono<{ Variables: SessionVariables }>
 */
export interface SessionVariables {
  /** User ID from session (undefined if not authenticated) */
  userId?: string;
  /** Space ID from session (undefined if not authenticated) */
  spaceId?: string;
  /** Full session data (undefined if not authenticated) */
  session?: SessionData;
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Middleware that parses session from cookie and sets context variables.
 * Does NOT enforce authentication - use requireAuth for protected routes.
 */
export const sessionMiddleware: MiddlewareHandler = async (c: Context, next: Next) => {
  const session = await parseSession(c);

  if (session) {
    c.set('userId', session.userId);
    c.set('spaceId', session.spaceId);
    c.set('session', session);
  }

  await next();
};

/**
 * Middleware that requires a valid session.
 * Returns 401 if no valid session exists.
 */
export const requireAuth: MiddlewareHandler = async (c: Context, next: Next) => {
  const session = await parseSession(c);

  if (!session) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  c.set('userId', session.userId);
  c.set('spaceId', session.spaceId);
  c.set('session', session);

  await next();
};

/**
 * Helper to get spaceId from context with type safety.
 * Throws if spaceId is not set (should only be called after requireAuth).
 */
export function getSpaceId(c: Context): string {
  const spaceId = c.get('spaceId');
  if (!spaceId) {
    throw new Error('spaceId not found in context - ensure requireAuth middleware is applied');
  }
  return spaceId;
}

/**
 * Helper to get userId from context with type safety.
 * Throws if userId is not set (should only be called after requireAuth).
 */
export function getUserId(c: Context): string {
  const userId = c.get('userId');
  if (!userId) {
    throw new Error('userId not found in context - ensure requireAuth middleware is applied');
  }
  return userId;
}
