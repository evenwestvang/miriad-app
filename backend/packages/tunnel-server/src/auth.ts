/**
 * Container Token Authentication for Tunnel Server
 *
 * Reuses the same HMAC-based token verification as the main CAST backend.
 * Token format: base64url(spaceId:channelId:callsign).hmac
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// =============================================================================
// Configuration
// =============================================================================

const DEV_SECRET = 'cast-dev-container-secret-do-not-use-in-production';

const ENV_SECRET = process.env.CAST_CONTAINER_SECRET;

if (process.env.NODE_ENV === 'production' && !ENV_SECRET) {
  throw new Error('CAST_CONTAINER_SECRET is required in production');
}

const CONTAINER_SECRET = ENV_SECRET ?? DEV_SECRET;

if (!ENV_SECRET) {
  console.log('[TunnelAuth] Using dev secret (set CAST_CONTAINER_SECRET in production)');
}

// =============================================================================
// Types
// =============================================================================

export interface ContainerTokenPayload {
  spaceId: string;
  channelId: string;
  callsign: string;
}

// =============================================================================
// Token Functions
// =============================================================================

/**
 * Verify and decode a container auth token.
 * Same implementation as container-token.ts in main backend.
 */
export function verifyContainerToken(token: string): ContainerTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [encodedData, providedHmac] = parts;

  let data: string;
  try {
    data = Buffer.from(encodedData, 'base64url').toString('utf-8');
  } catch {
    return null;
  }

  const expectedHmac = createHmac('sha256', CONTAINER_SECRET).update(data).digest('base64url');
  const providedBuffer = Buffer.from(providedHmac);
  const expectedBuffer = Buffer.from(expectedHmac);

  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  const dataParts = data.split(':');
  if (dataParts.length !== 3) {
    return null;
  }

  return {
    spaceId: dataParts[0],
    channelId: dataParts[1],
    callsign: dataParts[2],
  };
}

/**
 * Extract bearer token from Authorization header.
 * Expects: "Container <token>" format
 */
export function extractContainerToken(authHeader: string | undefined | null): string | null {
  if (!authHeader) return null;

  const match = authHeader.match(/^Container\s+(.+)$/i);
  return match ? match[1] : null;
}
