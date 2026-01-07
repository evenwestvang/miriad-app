/**
 * App Registry
 *
 * Built-in catalog of supported external service integrations.
 * Each app defines:
 * - OAuth configuration
 * - MCP derivation function (how to generate MCP config from tokens)
 * - Optional settings schema
 */

// =============================================================================
// Types
// =============================================================================

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface McpConfig {
  /** MCP server name (derived from artifact slug) */
  name?: string;
  /** Transport type */
  transport: 'stdio' | 'sse' | 'http';
  /** Command to run (for stdio transport) */
  command?: string;
  /** Arguments for command */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** URL for SSE/HTTP transport */
  url?: string;
  /** Headers for HTTP requests */
  headers?: Record<string, string>;
}

export interface OAuthConfig {
  /** Authorization URL */
  authorizationUrl: string;
  /** Token exchange URL */
  tokenUrl: string;
  /** OAuth scopes */
  scopes: string[];
  /** Client ID environment variable name */
  clientIdEnvVar: string;
  /** Client secret environment variable name */
  clientSecretEnvVar: string;
}

export interface AppDefinition {
  /** Unique identifier */
  id: string;
  /** Display name */
  name: string;
  /** Description */
  description: string;
  /** Icon (emoji or URL) */
  icon?: string;
  /** OAuth configuration */
  oauth: OAuthConfig;
  /** Derive MCP config from tokens and settings */
  deriveMcp: (tokens: TokenSet, settings?: Record<string, unknown>) => McpConfig;
  /** Provider-specific settings schema (JSON Schema) */
  settingsSchema?: Record<string, unknown>;
}

// =============================================================================
// App Registry
// =============================================================================

export const APP_REGISTRY: Record<string, AppDefinition> = {
  github: {
    id: 'github',
    name: 'GitHub',
    description: 'Access repositories, issues, PRs, and more',
    icon: '🐙',
    oauth: {
      authorizationUrl: 'https://github.com/login/oauth/authorize',
      tokenUrl: 'https://github.com/login/oauth/access_token',
      scopes: ['repo', 'read:user'],
      clientIdEnvVar: 'GITHUB_CLIENT_ID',
      clientSecretEnvVar: 'GITHUB_CLIENT_SECRET',
    },
    deriveMcp: (tokens) => ({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github'],
      env: {
        GITHUB_TOKEN: tokens.accessToken,
      },
    }),
  },

  sanity: {
    id: 'sanity',
    name: 'Sanity',
    description: 'Manage Sanity CMS content and datasets',
    icon: '📝',
    oauth: {
      authorizationUrl: 'https://api.sanity.io/v1/auth/oauth/authorize',
      tokenUrl: 'https://api.sanity.io/v1/auth/oauth/token',
      scopes: ['read', 'write'],
      clientIdEnvVar: 'SANITY_CLIENT_ID',
      clientSecretEnvVar: 'SANITY_CLIENT_SECRET',
    },
    deriveMcp: (tokens, settings) => ({
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@anthropics/sanity-mcp'],
      env: {
        SANITY_TOKEN: tokens.accessToken,
        ...(settings?.projectId ? { SANITY_PROJECT_ID: String(settings.projectId) } : {}),
      },
    }),
    settingsSchema: {
      type: 'object',
      properties: {
        projectId: {
          type: 'string',
          description: 'Sanity project ID',
        },
      },
    },
  },
};

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Get an app definition by provider ID.
 */
export function getAppDefinition(provider: string): AppDefinition | undefined {
  return APP_REGISTRY[provider];
}

/**
 * Get all available app definitions.
 */
export function getAllApps(): AppDefinition[] {
  return Object.values(APP_REGISTRY);
}

/**
 * Get OAuth credentials from environment variables.
 */
export function getOAuthCredentials(provider: string): { clientId: string; clientSecret: string } | null {
  const app = APP_REGISTRY[provider];
  if (!app) return null;

  const clientId = process.env[app.oauth.clientIdEnvVar];
  const clientSecret = process.env[app.oauth.clientSecretEnvVar];

  if (!clientId || !clientSecret) {
    return null;
  }

  return { clientId, clientSecret };
}

/**
 * Check if an app is configured (has OAuth credentials).
 */
export function isAppConfigured(provider: string): boolean {
  return getOAuthCredentials(provider) !== null;
}

/**
 * Get list of configured apps (apps with valid OAuth credentials).
 */
export function getConfiguredApps(): AppDefinition[] {
  return getAllApps().filter((app) => isAppConfigured(app.id));
}
