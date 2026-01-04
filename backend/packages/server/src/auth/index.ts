/**
 * @cast/server - Authentication module
 *
 * Container token authentication for agent-to-server communication.
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
