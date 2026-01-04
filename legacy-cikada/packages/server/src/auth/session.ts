/**
 * Session Management
 *
 * JWT cookie-based sessions with spaceId claim for multi-tenancy.
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose';
import type { IncomingMessage, ServerResponse } from 'node:http';

// =============================================================================
// Types
// =============================================================================

export interface SessionPayload {
  userId: string;
  spaceId: string;
}

interface JWTSessionClaims extends JWTPayload {
  sub: string; // userId
  spaceId: string;
}

// =============================================================================
// Constants
// =============================================================================

const COOKIE_NAME = 'cikada-session';
const SESSION_EXPIRY = '24h';
const DEFAULT_SECRET = 'cikada-dev-secret-change-in-production';

// Get secret as Uint8Array for jose
function getSecret(): Uint8Array {
  const secret = process.env.SESSION_SECRET || DEFAULT_SECRET;
  return new TextEncoder().encode(secret);
}

// =============================================================================
// Cookie Helpers
// =============================================================================

function parseCookies(req: IncomingMessage): Record<string, string> {
  const cookies: Record<string, string> = {};
  const cookieHeader = req.headers.cookie;

  if (cookieHeader) {
    for (const cookie of cookieHeader.split(';')) {
      const [name, ...rest] = cookie.trim().split('=');
      if (name && rest.length > 0) {
        cookies[name] = rest.join('=');
      }
    }
  }

  return cookies;
}

function setCookie(res: ServerResponse, name: string, value: string, maxAge: number, isSecureContext: boolean): void {
  // SameSite=None requires Secure flag - browsers reject SameSite=None without Secure
  // For local HTTP development, use SameSite=Lax instead
  const sameSite = isSecureContext ? 'SameSite=None' : 'SameSite=Lax';

  const cookie = [
    `${name}=${value}`,
    'Path=/',
    `Max-Age=${maxAge}`,
    'HttpOnly',
    sameSite,
    ...(isSecureContext ? ['Secure'] : []),
  ];

  // Handle multiple Set-Cookie headers
  const existing = res.getHeader('Set-Cookie');
  const cookies = existing
    ? Array.isArray(existing)
      ? [...existing, cookie.join('; ')]
      : [existing as string, cookie.join('; ')]
    : [cookie.join('; ')];

  res.setHeader('Set-Cookie', cookies);
}

function clearCookie(res: ServerResponse, name: string, isSecureContext: boolean): void {
  setCookie(res, name, '', 0, isSecureContext);
}

// =============================================================================
// Session API
// =============================================================================

/**
 * Determine if the request is in a secure context (HTTPS).
 * Used to decide whether to set the Secure flag on cookies.
 */
function isSecureRequest(req: IncomingMessage): boolean {
  // Check x-forwarded-proto header (set by proxies/load balancers)
  const forwardedProto = req.headers['x-forwarded-proto'];
  if (forwardedProto === 'https') return true;

  // Check origin header
  const origin = req.headers.origin;
  if (origin?.startsWith('https://')) return true;

  // Default to secure in production (Lambda behind API Gateway is always HTTPS)
  if (process.env.NODE_ENV === 'production') return true;

  return false;
}

/**
 * Create a new session and set the JWT cookie.
 */
export async function createSession(
  req: IncomingMessage,
  res: ServerResponse,
  payload: SessionPayload
): Promise<void> {
  const { userId, spaceId } = payload;

  const token = await new SignJWT({ spaceId } as JWTSessionClaims)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setExpirationTime(SESSION_EXPIRY)
    .sign(getSecret());

  // 24 hours in seconds
  const maxAge = 24 * 60 * 60;
  const isSecure = isSecureRequest(req);
  setCookie(res, COOKIE_NAME, token, maxAge, isSecure);
}

/**
 * Verify the session cookie and extract the payload.
 * Returns null if no valid session exists.
 */
export async function verifySession(
  req: IncomingMessage
): Promise<SessionPayload | null> {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];

  if (!token) {
    return null;
  }

  try {
    const { payload } = await jwtVerify(token, getSecret());
    const claims = payload as JWTSessionClaims;

    if (!claims.sub || !claims.spaceId) {
      return null;
    }

    return {
      userId: claims.sub,
      spaceId: claims.spaceId,
    };
  } catch {
    // Invalid or expired token
    return null;
  }
}

/**
 * Clear the session cookie.
 */
export function clearSession(req: IncomingMessage, res: ServerResponse): void {
  const isSecure = isSecureRequest(req);
  clearCookie(res, COOKIE_NAME, isSecure);
}
