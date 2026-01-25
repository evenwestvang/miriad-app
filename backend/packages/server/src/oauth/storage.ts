/**
 * OAuth Token Storage Adapter
 *
 * Stores OAuth tokens in artifact secrets on system.mcp artifacts.
 * Uses the storage interface's secret operations for encryption.
 */

import type { Storage } from "@cast/storage";
import { OAUTH_SECRET_KEYS, type StoredOAuthTokens } from "./types.js";

/**
 * OAuth token status for UI display
 */
export interface OAuthTokenStatus {
  status: "connected" | "disconnected" | "expired";
  expiresAt?: string;
}

// Re-export for convenience
export type OAuthTokenData = StoredOAuthTokens;

/**
 * Check if a token is expired based on expiresAt timestamp
 */
function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() <= Date.now();
}

/**
 * Get OAuth token data for an MCP artifact
 */
export async function getOAuthTokens(
  storage: Storage,
  spaceId: string,
  channelId: string,
  mcpSlug: string
): Promise<OAuthTokenData | null> {
  const accessToken = await storage.getSecretValue(
    spaceId,
    channelId,
    mcpSlug,
    OAUTH_SECRET_KEYS.ACCESS_TOKEN
  );

  if (!accessToken) {
    return null;
  }

  const [refreshToken, clientId, accessTokenMeta] = await Promise.all([
    storage.getSecretValue(spaceId, channelId, mcpSlug, OAUTH_SECRET_KEYS.REFRESH_TOKEN),
    storage.getSecretValue(spaceId, channelId, mcpSlug, OAUTH_SECRET_KEYS.CLIENT_ID),
    storage.getSecretMetadata(channelId, mcpSlug, OAUTH_SECRET_KEYS.ACCESS_TOKEN),
  ]);

  return {
    accessToken,
    refreshToken: refreshToken ?? undefined,
    expiresAt: accessTokenMeta?.expiresAt ?? undefined,
    clientId: clientId ?? undefined,
  };
}

/**
 * Get OAuth connection status for an MCP artifact
 */
export async function getOAuthStatus(
  storage: Storage,
  spaceId: string,
  channelId: string,
  mcpSlug: string
): Promise<OAuthTokenStatus> {
  const accessToken = await storage.getSecretValue(
    spaceId,
    channelId,
    mcpSlug,
    OAUTH_SECRET_KEYS.ACCESS_TOKEN
  );

  if (!accessToken) {
    return { status: "disconnected" };
  }

  const accessTokenMeta = await storage.getSecretMetadata(
    channelId,
    mcpSlug,
    OAUTH_SECRET_KEYS.ACCESS_TOKEN
  );

  const expiresAt = accessTokenMeta?.expiresAt;

  if (isExpired(expiresAt)) {
    return { status: "expired", expiresAt };
  }

  return { status: "connected", expiresAt };
}

/**
 * Save OAuth tokens to an MCP artifact's secrets
 */
export async function saveOAuthTokens(
  storage: Storage,
  spaceId: string,
  channelId: string,
  mcpSlug: string,
  tokens: OAuthTokenData
): Promise<void> {
  // Save access token with expiry
  await storage.setSecret(spaceId, channelId, mcpSlug, OAUTH_SECRET_KEYS.ACCESS_TOKEN, {
    value: tokens.accessToken,
    expiresAt: tokens.expiresAt,
  });

  // Save refresh token (no expiry - it's long-lived)
  if (tokens.refreshToken) {
    await storage.setSecret(spaceId, channelId, mcpSlug, OAUTH_SECRET_KEYS.REFRESH_TOKEN, {
      value: tokens.refreshToken,
    });
  }

  // Save client ID for refresh requests
  if (tokens.clientId) {
    await storage.setSecret(spaceId, channelId, mcpSlug, OAUTH_SECRET_KEYS.CLIENT_ID, {
      value: tokens.clientId,
    });
  }
}

/**
 * Delete OAuth tokens from an MCP artifact
 */
export async function deleteOAuthTokens(
  storage: Storage,
  channelId: string,
  mcpSlug: string
): Promise<void> {
  await Promise.all([
    storage.deleteSecret(channelId, mcpSlug, OAUTH_SECRET_KEYS.ACCESS_TOKEN),
    storage.deleteSecret(channelId, mcpSlug, OAUTH_SECRET_KEYS.REFRESH_TOKEN),
    storage.deleteSecret(channelId, mcpSlug, OAUTH_SECRET_KEYS.CLIENT_ID),
  ]);
}
