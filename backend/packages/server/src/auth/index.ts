/**
 * @cast/server - Authentication module
 *
 * Container token authentication for agent-to-server communication.
 * User session authentication for spaces & auth.
 */

// Token generation and verification
export {
  generateContainerToken,
  verifyContainerToken,
  type ContainerTokenPayload,
} from './container-token.js';

// Hono middleware
export {
  requireContainerAuth,
  optionalContainerAuth,
  hasContainerAuth,
  getContainerAuth,
  type ContainerAuthVariables,
} from './container-middleware.js';

// User session management
export {
  createSession,
  parseSession,
  setSessionCookie,
  clearSessionCookie,
  verifySessionToken,
  parseSessionCookie,
  type SessionData,
  type AuthMode,
} from './session.js';

// Session middleware
export {
  sessionMiddleware,
  requireAuth,
  getSpaceId,
  getUserId,
  type SessionVariables,
} from './session-middleware.js';

// Dev auth routes
export { createDevAuthRoutes, type DevAuthOptions } from './dev.js';

// WorkOS auth routes (production)
export { createWorkOSAuthRoutes, type WorkOSAuthOptions } from './workos.js';
