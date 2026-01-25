/**
 * OAuth types for HTTP MCP servers.
 *
 * These types define the OAuth configuration schema that will be added
 * to system.mcp artifact props.
 */

/**
 * OAuth authentication configuration for HTTP MCP servers.
 * Supports OAuth 2.1 with PKCE (required by MCP spec).
 */
export interface OAuthConfig {
  type: 'oauth';
  /** Authorization endpoint URL (auto-discovered via RFC 8414 if not set) */
  authorizationEndpoint?: string;
  /** Token endpoint URL (auto-discovered via RFC 8414 if not set) */
  tokenEndpoint?: string;
  /** OAuth client ID (uses dynamic registration or default if not set) */
  clientId?: string;
  /** OAuth scopes to request */
  scopes?: string[];
}

/**
 * Stored OAuth tokens for an MCP server.
 * These are stored encrypted in artifact secrets.
 */
export interface StoredOAuthTokens {
  /** The access token */
  accessToken: string;
  /** Refresh token for obtaining new access tokens */
  refreshToken?: string;
  /** When the access token expires (ISO 8601) */
  expiresAt?: string;
  /** The client ID used (needed for refresh) */
  clientId?: string;
}

/**
 * OAuth status as returned by the status endpoint.
 */
export type OAuthStatus = 'connected' | 'disconnected' | 'expired' | 'expiring_soon';

/**
 * Secret keys used for storing OAuth tokens on artifacts.
 */
export const OAUTH_SECRET_KEYS = {
  ACCESS_TOKEN: 'oauth_access_token',
  REFRESH_TOKEN: 'oauth_refresh_token',
  CLIENT_ID: 'oauth_client_id',
} as const;
