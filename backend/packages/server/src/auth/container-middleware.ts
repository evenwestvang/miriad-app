/**
 * Container Authentication Middleware
 *
 * Hono middleware that verifies container tokens and injects
 * the decoded payload into the request context.
 */

import type { Context, Next } from 'hono';
import { verifyContainerToken, type ContainerTokenPayload } from './container-token.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended context variables for authenticated container requests.
 */
export interface ContainerAuthVariables {
  container: ContainerTokenPayload;
}

// =============================================================================
// Middleware
// =============================================================================

/**
 * Middleware that requires a valid container or agent token.
 *
 * Expects token in Authorization header: `Container <token>` or `Agent <token>`
 *
 * On success, sets `c.get('container')` with the decoded payload.
 * On failure, returns 401 Unauthorized.
 */
export function requireContainerAuth() {
  return async (c: Context<{ Variables: ContainerAuthVariables }>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (!authHeader) {
      return c.json({ error: 'Missing Authorization header' }, 401);
    }

    // Parse "Container <token>" or "Agent <token>" format
    const match = authHeader.match(/^(Container|Agent)\s+(.+)$/i);
    if (!match) {
      return c.json({ error: 'Invalid Authorization format (expected: Container <token> or Agent <token>)' }, 401);
    }

    const token = match[2];
    const payload = verifyContainerToken(token);

    if (!payload) {
      return c.json({ error: 'Invalid container token' }, 401);
    }

    // Inject decoded payload into context
    c.set('container', payload);

    await next();
  };
}

/**
 * Middleware that optionally parses a container token.
 *
 * Unlike requireContainerAuth, this allows requests without tokens.
 * Use when endpoints support both authenticated and unauthenticated access.
 *
 * On success, sets `c.get('container')` with the decoded payload.
 * On missing/invalid token, continues without setting container.
 */
export function optionalContainerAuth() {
  return async (c: Context<{ Variables: ContainerAuthVariables }>, next: Next) => {
    const authHeader = c.req.header('Authorization');

    if (authHeader) {
      const match = authHeader.match(/^(Container|Agent)\s+(.+)$/i);
      if (match) {
        const payload = verifyContainerToken(match[2]);
        if (payload) {
          c.set('container', payload);
        }
      }
    }

    await next();
  };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Type guard to check if container auth is present in context.
 */
export function hasContainerAuth(c: Context<{ Variables: ContainerAuthVariables }>): boolean {
  return c.get('container') !== undefined;
}

/**
 * Get container payload from context.
 * Throws if not authenticated (use after requireContainerAuth).
 */
export function getContainerAuth(c: Context<{ Variables: ContainerAuthVariables }>): ContainerTokenPayload {
  const container = c.get('container');
  if (!container) {
    throw new Error('Container auth not present (missing requireContainerAuth middleware?)');
  }
  return container;
}
