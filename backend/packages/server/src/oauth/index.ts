/**
 * OAuth 2.1 Module for HTTP MCP Servers
 *
 * Provides OAuth authentication support for MCP servers using HTTP transport.
 * Implements OAuth 2.1 with PKCE as required by the MCP specification.
 *
 * @example
 * ```typescript
 * import { startOAuthFlow, validateCallback, exchangeCodeForTokens } from './oauth';
 *
 * // Start OAuth flow
 * const { authorizationUrl, state } = await startOAuthFlow({
 *   mcpSlug: 'my-mcp',
 *   channelId: 'channel-123',
 *   spaceId: 'space-456',
 *   mcpUrl: 'https://mcp.example.com',
 *   baseUrl: 'https://app.cast.fm',
 *   clientId: 'my-client-id',
 * });
 *
 * // Handle callback
 * const { code, pendingState } = validateCallback({ code, state });
 *
 * // Exchange code for tokens
 * const tokens = await exchangeCodeForTokens(
 *   pendingState.endpoints.tokenEndpoint,
 *   code,
 *   pendingState.codeVerifier,
 *   pendingState.redirectUri,
 *   pendingState.clientId
 * );
 * ```
 */

// Types
export type { OAuthConfig, StoredOAuthTokens, OAuthStatus } from './types.js';
export { OAUTH_SECRET_KEYS } from './types.js';

// PKCE utilities
export { generatePKCE, generateState, generateCodeVerifier, generateCodeChallenge, verifyPKCE } from './pkce.js';
export type { PKCEPair, CodeChallengeMethod } from './pkce.js';

// OAuth discovery
export { discoverOAuthMetadata, resolveOAuthEndpoints, clearMetadataCache, supportsPKCE } from './discovery.js';
export type { OAuthServerMetadata, ResolvedOAuthEndpoints } from './discovery.js';

// Token operations
export {
  exchangeCodeForTokens,
  refreshAccessToken,
  checkTokenExpiry,
  needsRefresh,
  getValidAccessToken,
  buildAuthorizationHeader,
  selectAuthMethod,
  OAuthTokenError,
} from './tokens.js';
export type { TokenResponse, TokenData, TokenErrorResponse, TokenEndpointAuthMethod } from './tokens.js';

// OAuth flow
export {
  startOAuthFlow,
  buildAuthorizationUrl,
  validateCallback,
  getPendingState,
  cleanupExpiredStates,
  OAuthCallbackError,
} from './flow.js';
export type {
  PendingAuthState,
  StartOAuthFlowParams,
  StartOAuthFlowResult,
  OAuthCallbackParams,
  ValidatedCallback,
} from './flow.js';

// Storage adapter
export { getOAuthTokens, getOAuthStatus, saveOAuthTokens, deleteOAuthTokens } from './storage.js';
export type { OAuthTokenData, OAuthTokenStatus } from './storage.js';

// Client registration (RFC 7591)
export {
  getOrRegisterClient,
  registerClient,
  getStoredRegistration,
  saveRegistration,
  deleteRegistration,
  clearRegistrationCache,
  ClientRegistrationError,
} from './registration.js';
export type {
  ClientRegistrationRequest,
  ClientRegistrationResponse,
  StoredClientRegistration,
} from './registration.js';

// Routes
export { createOAuthRoutes } from './routes.js';
export type { OAuthRoutesOptions } from './routes.js';
