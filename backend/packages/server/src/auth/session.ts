/**
 * Session Management
 *
 * JWT-based session handling for user authentication.
 * Sessions are stored in httpOnly cookies for security.
 */

import { sign, verify } from 'hono/jwt';
import type { Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

// =============================================================================
// Types
// =============================================================================

export type AuthMode = 'dev' | 'workos';

export interface SessionPayload {
  /** User ID */
  userId: string;
  /** Space ID */
  spaceId: string;
  /** Authentication mode */
  mode: AuthMode;
  /** Issued at timestamp */
  iat: number;
  /** Expiration timestamp */
  exp: number;
}

export interface SessionData {
  userId: string;
  spaceId: string;
  mode: AuthMode;
}

// =============================================================================
// Configuration
// =============================================================================

const COOKIE_NAME = 'cast_session';
const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Get the JWT secret from environment or use a default for dev.
 * In production, JWT_SECRET must be set.
 */
function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('JWT_SECRET environment variable is required in production');
    }
    // Default secret for local development only
    return 'cast-dev-secret-do-not-use-in-production';
  }
  return secret;
}

// =============================================================================
// Session Functions
// =============================================================================

/**
 * Create a new session JWT token.
 */
export async function createSession(
  userId: string,
  spaceId: string,
  mode: AuthMode
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + Math.floor(SESSION_DURATION_MS / 1000);

  const payload = {
    userId,
    spaceId,
    mode,
    iat: now,
    exp,
  };

  return await sign(payload, getJwtSecret());
}

/**
 * Parse and verify a session from the request cookie.
 * Returns null if no valid session exists.
 */
export async function parseSession(c: Context): Promise<SessionData | null> {
  const token = getCookie(c, COOKIE_NAME);
  if (!token) {
    return null;
  }

  try {
    const payload = await verify(token, getJwtSecret()) as unknown as SessionPayload;

    // Check expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      return null;
    }

    // Validate required fields exist
    if (!payload.userId || !payload.spaceId || !payload.mode) {
      return null;
    }

    return {
      userId: payload.userId,
      spaceId: payload.spaceId,
      mode: payload.mode,
    };
  } catch {
    // Invalid or expired token
    return null;
  }
}

/**
 * Set the session cookie on the response.
 */
export function setSessionCookie(c: Context, token: string): void {
  setCookie(c, COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(SESSION_DURATION_MS / 1000),
  });
}

/**
 * Clear the session cookie.
 */
export function clearSessionCookie(c: Context): void {
  deleteCookie(c, COOKIE_NAME, {
    path: '/',
  });
}
