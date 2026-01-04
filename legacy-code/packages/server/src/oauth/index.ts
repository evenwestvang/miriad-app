/**
 * OAuth 2.1 support for MCP servers
 *
 * Implements OAuth 2.1 with PKCE as required by the MCP specification.
 */

export {
  generatePKCE,
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  verifyPKCE,
  type PKCEPair,
  type CodeChallengeMethod,
} from "./pkce.js";

export {
  discoverOAuthMetadata,
  resolveOAuthEndpoints,
  clearMetadataCache,
  supportsPKCE,
  type OAuthServerMetadata,
  type ResolvedOAuthEndpoints,
  type OAuthConfig,
} from "./discovery.js";

export {
  exchangeCodeForTokens,
  refreshAccessToken,
  checkTokenExpiry,
  needsRefresh,
  getValidAccessToken,
  buildAuthorizationHeader,
  OAuthTokenError,
  type TokenResponse,
  type TokenData,
  type TokenErrorResponse,
} from "./tokens.js";

export {
  getStoredToken,
  saveToken,
  deleteToken,
  isTokenExpired,
  tokenNeedsRefresh,
  listTokens,
  clearChannelTokens,
  getTokenStatus,
  fileTokenStore,
  type StoredToken,
  type TokenStore,
} from "./storage.js";

export {
  buildAuthorizationUrl,
  startOAuthFlow,
  validateCallback,
  getPendingState,
  clearPendingStates,
  getPendingStateCount,
  OAuthCallbackError,
  type PendingAuthState,
  type StartOAuthFlowParams,
  type StartOAuthFlowResult,
  type OAuthCallbackParams,
  type ValidatedCallback,
} from "./flow.js";

export {
  registerClient,
  getOrRegisterClient,
  getStoredRegistration,
  saveRegistration,
  deleteRegistration,
  ClientRegistrationError,
  fileRegistrationStore,
  type ClientRegistrationRequest,
  type ClientRegistrationResponse,
  type StoredClientRegistration,
  type ClientRegistrationStore,
} from "./registration.js";

export {
  handleOAuthRequest,
  handleOAuthStatus,
  handleOAuthStart,
  handleOAuthDisconnect,
  handleOAuthCallback,
  type OAuthStatusResponse,
  type OAuthStartRequest,
  type OAuthStartResponse,
  type OAuthDisconnectRequest,
  type OAuthApiDependencies,
} from "./api.js";

export {
  getValidOAuthToken,
  resolveMcpConfigsWithOAuth,
  getAuthenticatedHeaders,
  type ResolvedMcpConfig,
  type McpReference,
  type McpArtifactResolver,
} from "./integration.js";
