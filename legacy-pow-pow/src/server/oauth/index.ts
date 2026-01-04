/**
 * OAuth 2.1 support for MCP servers
 *
 * Implements OAuth 2.1 with PKCE as required by the MCP specification.
 */

export {
  discoverOAuthMetadata,
  resolveOAuthEndpoints,
  clearMetadataCache,
  supportsPKCE,
  type OAuthServerMetadata,
  type ResolvedOAuthEndpoints,
} from "./discovery.js";

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
  handleOAuthRequest,
  handleOAuthStatus,
  handleOAuthStart,
  handleOAuthDisconnect,
  handleOAuthCallback,
  type OAuthApiDependencies,
  type OAuthStatusResponse,
  type OAuthStartRequest,
  type OAuthStartResponse,
  type OAuthDisconnectRequest,
} from "./api.js";

export {
  exchangeCodeForTokens,
  refreshAccessToken,
  checkTokenExpiry,
  needsRefresh,
  getValidAccessToken,
  buildAuthorizationHeader,
  selectAuthMethod,
  OAuthTokenError,
  type TokenResponse,
  type TokenData,
  type TokenErrorResponse,
  type TokenEndpointAuthMethod,
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
  getValidOAuthToken,
  resolveMcpConfigsWithOAuth,
  type ResolvedMcpConfigWithAuth,
} from "./integration.js";

export {
  registerClient,
  getOrRegisterClient,
  getStoredRegistration,
  saveRegistration,
  deleteRegistration,
  fileRegistrationStore,
  ClientRegistrationError,
  type ClientRegistrationRequest,
  type ClientRegistrationResponse,
  type StoredClientRegistration,
  type ClientRegistrationStore,
} from "./registration.js";
