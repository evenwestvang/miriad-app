/**
 * Container Token Authentication
 *
 * Generates and verifies tokens for Docker container authentication.
 * Token format: base64url(spaceId:channelId:callsign).hmac
 *
 * The HMAC ensures containers can only access their assigned space/channel.
 */

import { createHmac } from 'node:crypto';

// =============================================================================
// Configuration
// =============================================================================

// Stable dev secret - used when no environment variable is set
const DEV_SECRET = 'cast-dev-container-secret-do-not-use-in-production';

// Use environment variable or fall back to dev secret
const CONTAINER_SECRET = process.env.CAST_CONTAINER_SECRET ?? DEV_SECRET;

// Log once at startup
if (!process.env.CAST_CONTAINER_SECRET) {
  console.log('[ContainerToken] Using dev secret (set CAST_CONTAINER_SECRET in production)');
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
 * Generate a container auth token.
 *
 * @param payload - Space, channel, and callsign identifiers
 * @returns Token string to inject as CONTAINER_TOKEN env var
 */
export function generateContainerToken(payload: ContainerTokenPayload): string {
  const data = `${payload.spaceId}:${payload.channelId}:${payload.callsign}`;
  const encodedData = Buffer.from(data).toString('base64url');
  const hmac = createHmac('sha256', CONTAINER_SECRET).update(data).digest('base64url');
  return `${encodedData}.${hmac}`;
}

/**
 * Verify and decode a container auth token.
 *
 * @param token - Token string from container
 * @returns Decoded payload if valid, null if invalid
 */
export function verifyContainerToken(token: string): ContainerTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [encodedData, providedHmac] = parts;

  // Decode payload
  let data: string;
  try {
    data = Buffer.from(encodedData, 'base64url').toString('utf-8');
  } catch {
    return null;
  }

  // Verify HMAC
  const expectedHmac = createHmac('sha256', CONTAINER_SECRET).update(data).digest('base64url');
  if (providedHmac !== expectedHmac) {
    return null;
  }

  // Parse payload
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
