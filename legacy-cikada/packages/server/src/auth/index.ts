/**
 * Auth Module
 *
 * Session management and authentication middleware.
 */

export {
  createSession,
  verifySession,
  clearSession,
  type SessionPayload,
} from './session.js';

export {
  authMiddleware,
  type AuthenticatedRequest,
  type AuthOptions,
} from './middleware.js';

export {
  startSanityAuthFlow,
  handleSanityAuthCallback,
  extractUserInfo,
  getOrRegisterClient,
  clearPendingSanityAuthStates,
  getPendingSanityAuthStateCount,
  setOAuthBaseUrl,
  getOAuthBaseUrl,
  resetOAuthBaseUrl,
  type SanityUserInfo,
  type PendingSanityAuthState,
} from './sanity-auth.js';

export {
  handleMockOAuthRequest,
  handleMockOAuthCallback,
  clearMockOAuthState,
  getPendingCodeCount,
  getRegisteredClientCount,
  type MockOAuthHandlerOptions,
} from './mock-oauth.js';

export {
  generateContainerToken,
  verifyContainerToken,
  type ContainerTokenPayload,
} from './container-token.js';

export {
  getAuthStateStorage,
  setAuthStateStorage,
  resetAuthStateStorage,
  createInMemoryAuthStateStorage,
  createDynamoDBAuthStateStorage,
  type AuthStateStorage,
  type DynamoDBAuthStateStorageOptions,
} from './auth-state-storage.js';

export {
  getOAuthClientStorage,
  setOAuthClientStorage,
  resetOAuthClientStorage,
  createInMemoryOAuthClientStorage,
  createDynamoDBOAuthClientStorage,
  type OAuthClientStorage,
  type OAuthClientCredentials,
  type DynamoDBOAuthClientStorageOptions,
} from './oauth-client-storage.js';
