/**
 * Container Token
 *
 * Provisional token for Docker container authentication.
 *
 * Token format: base64(spaceId:channelId:callsign):hmac
 * The HMAC is computed over the payload using a server secret.
 *
 * This allows containers to authenticate without session cookies
 * while ensuring they can only access their assigned space/channel.
 */

import { createHmac } from 'node:crypto';

// =============================================================================
// Configuration
// =============================================================================

// Stable dev secret - used when no environment variable is set
// This ensures tokens survive server restarts during development
// In production, CIKADA_CONTAINER_SECRET should be set to a secure random value
const DEV_SECRET = 'cikada-dev-container-secret-do-not-use-in-production';

// Use environment variable or fall back to stable dev secret
const CONTAINER_SECRET = process.env.CIKADA_CONTAINER_SECRET ?? DEV_SECRET;

// Log once at startup
if (!process.env.CIKADA_CONTAINER_SECRET) {
  console.log('[ContainerToken] Using stable dev secret (set CIKADA_CONTAINER_SECRET in production)');
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
 * @returns Token string to pass to container
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
