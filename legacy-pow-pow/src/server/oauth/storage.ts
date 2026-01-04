/**
 * OAuth Token Storage
 *
 * Persists OAuth tokens to the filesystem at ~/.cast/oauth-tokens/
 * with appropriate file permissions for security.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { type TokenData, checkTokenExpiry, needsRefresh } from "./tokens.js";

/**
 * Stored token data with metadata.
 */
export interface StoredToken extends TokenData {
  /** When the token was issued/stored (ISO 8601) */
  issuedAt: string;

  /** The MCP server URL this token is for */
  mcpUrl: string;

  /** The OAuth client ID used for this token (for refresh) */
  clientId?: string;
}

/**
 * Default base directory for cast data.
 */
const CAST_DIR = process.env.CAST_DIR || path.join(os.homedir(), ".cast");

/**
 * Directory for OAuth tokens.
 */
const TOKENS_DIR = path.join(CAST_DIR, "oauth-tokens");

/**
 * Ensure the tokens directory exists with proper permissions.
 */
function ensureTokensDir(channel: string): string {
  const channelDir = path.join(TOKENS_DIR, sanitizePathComponent(channel));

  if (!fs.existsSync(channelDir)) {
    // Create directory with 700 permissions (owner only)
    fs.mkdirSync(channelDir, { recursive: true, mode: 0o700 });
  }

  return channelDir;
}

/**
 * Sanitize a path component to prevent directory traversal.
 */
function sanitizePathComponent(component: string): string {
  // Remove any path separators and special characters
  return component.replace(/[\/\\:*?"<>|]/g, "_");
}

/**
 * Get the token file path for a channel/MCP combination.
 */
function getTokenPath(channel: string, mcpSlug: string): string {
  const channelDir = ensureTokensDir(channel);
  return path.join(channelDir, `${sanitizePathComponent(mcpSlug)}.json`);
}

/**
 * Get stored token for an MCP.
 *
 * @param channel - The channel containing the MCP artifact
 * @param mcpSlug - The system.mcp artifact slug
 * @returns The stored token or null if not found
 */
export function getStoredToken(
  channel: string,
  mcpSlug: string
): StoredToken | null {
  const tokenPath = getTokenPath(channel, mcpSlug);

  try {
    if (!fs.existsSync(tokenPath)) {
      return null;
    }

    const data = fs.readFileSync(tokenPath, "utf-8");
    return JSON.parse(data) as StoredToken;
  } catch (error) {
    console.error(
      `[oauth] Failed to read token for ${channel}/${mcpSlug}:`,
      error
    );
    return null;
  }
}

/**
 * Save token for an MCP.
 *
 * @param channel - The channel containing the MCP artifact
 * @param mcpSlug - The system.mcp artifact slug
 * @param token - The token data to store
 * @param mcpUrl - The MCP server URL
 */
export function saveToken(
  channel: string,
  mcpSlug: string,
  token: TokenData,
  mcpUrl: string,
  clientId?: string
): void {
  const tokenPath = getTokenPath(channel, mcpSlug);

  const storedToken: StoredToken = {
    ...token,
    issuedAt: new Date().toISOString(),
    mcpUrl,
    clientId,
  };

  try {
    // Write with 600 permissions (owner read/write only)
    fs.writeFileSync(tokenPath, JSON.stringify(storedToken, null, 2), {
      mode: 0o600,
    });
  } catch (error) {
    console.error(
      `[oauth] Failed to save token for ${channel}/${mcpSlug}:`,
      error
    );
    throw error;
  }
}

/**
 * Delete stored token for an MCP.
 *
 * @param channel - The channel containing the MCP artifact
 * @param mcpSlug - The system.mcp artifact slug
 */
export function deleteToken(channel: string, mcpSlug: string): void {
  const tokenPath = getTokenPath(channel, mcpSlug);

  try {
    if (fs.existsSync(tokenPath)) {
      fs.unlinkSync(tokenPath);
    }
  } catch (error) {
    console.error(
      `[oauth] Failed to delete token for ${channel}/${mcpSlug}:`,
      error
    );
    // Don't throw - deletion failure is not critical
  }
}

/**
 * Check if a stored token is expired.
 *
 * @param token - The stored token
 * @returns true if the token is expired
 */
export function isTokenExpired(token: StoredToken): boolean {
  return checkTokenExpiry(token.expiresAt) === "expired";
}

/**
 * Check if a stored token needs refresh (expired or expiring soon).
 *
 * @param token - The stored token
 * @returns true if the token should be refreshed
 */
export function tokenNeedsRefresh(token: StoredToken): boolean {
  return needsRefresh(token.expiresAt);
}

/**
 * List all stored tokens for a channel.
 *
 * @param channel - The channel to list tokens for
 * @returns Array of { mcpSlug, token } objects
 */
export function listTokens(
  channel: string
): Array<{ mcpSlug: string; token: StoredToken }> {
  const channelDir = path.join(TOKENS_DIR, sanitizePathComponent(channel));

  if (!fs.existsSync(channelDir)) {
    return [];
  }

  try {
    const files = fs.readdirSync(channelDir);
    const tokens: Array<{ mcpSlug: string; token: StoredToken }> = [];

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const mcpSlug = file.slice(0, -5); // Remove .json
      const token = getStoredToken(channel, mcpSlug);

      if (token) {
        tokens.push({ mcpSlug, token });
      }
    }

    return tokens;
  } catch (error) {
    console.error(`[oauth] Failed to list tokens for ${channel}:`, error);
    return [];
  }
}

/**
 * Delete all tokens for a channel.
 *
 * @param channel - The channel to clear tokens for
 */
export function clearChannelTokens(channel: string): void {
  const channelDir = path.join(TOKENS_DIR, sanitizePathComponent(channel));

  if (!fs.existsSync(channelDir)) {
    return;
  }

  try {
    const files = fs.readdirSync(channelDir);

    for (const file of files) {
      if (file.endsWith(".json")) {
        fs.unlinkSync(path.join(channelDir, file));
      }
    }

    // Remove the directory if empty
    const remaining = fs.readdirSync(channelDir);
    if (remaining.length === 0) {
      fs.rmdirSync(channelDir);
    }
  } catch (error) {
    console.error(`[oauth] Failed to clear tokens for ${channel}:`, error);
  }
}

/**
 * Get token status for an MCP.
 *
 * @param channel - The channel containing the MCP artifact
 * @param mcpSlug - The system.mcp artifact slug
 * @returns Status object with connection state and expiry info
 */
export function getTokenStatus(
  channel: string,
  mcpSlug: string
): {
  status: "connected" | "disconnected" | "expired";
  expiresAt?: string;
  scopes?: string[];
} {
  const token = getStoredToken(channel, mcpSlug);

  if (!token) {
    return { status: "disconnected" };
  }

  if (isTokenExpired(token)) {
    return {
      status: "expired",
      expiresAt: token.expiresAt,
    };
  }

  return {
    status: "connected",
    expiresAt: token.expiresAt,
    scopes: token.scopes,
  };
}

/**
 * Token store interface for dependency injection.
 */
export interface TokenStore {
  getToken(channel: string, mcpSlug: string): StoredToken | null;
  saveToken(
    channel: string,
    mcpSlug: string,
    token: TokenData,
    mcpUrl: string
  ): void;
  deleteToken(channel: string, mcpSlug: string): void;
  getStatus(
    channel: string,
    mcpSlug: string
  ): {
    status: "connected" | "disconnected" | "expired";
    expiresAt?: string;
    scopes?: string[];
  };
}

/**
 * Default token store using file system.
 */
export const fileTokenStore: TokenStore = {
  getToken: getStoredToken,
  saveToken,
  deleteToken,
  getStatus: getTokenStatus,
};
