/**
 * @cast/server/apps - App integration registry and OAuth handlers
 */

export {
  APP_REGISTRY,
  getAppDefinition,
  getAllApps,
  getOAuthCredentials,
  isAppConfigured,
  getConfiguredApps,
  type AppDefinition,
  type TokenSet,
  type McpConfig,
  type OAuthConfig,
} from './registry.js';
