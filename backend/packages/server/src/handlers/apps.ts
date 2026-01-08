/**
 * App OAuth Handlers
 *
 * REST API routes for external app OAuth flows.
 *
 * Endpoints:
 * - GET  /auth/apps                        - List available apps
 * - GET  /auth/apps/:provider/connect      - Initiate OAuth flow
 * - GET  /auth/apps/callback               - OAuth callback
 * - POST /auth/apps/:provider/disconnect   - Clear tokens
 * - POST /auth/apps/:provider/refresh      - Refresh expired token
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import type { Storage } from '@cast/storage';
import {
  getAppDefinition,
  getConfiguredApps,
  getOAuthCredentials,
  type TokenSet,
} from '../apps/index.js';

// =============================================================================
// Types
// =============================================================================

export interface AppHandlerOptions {
  /** Storage backend */
  storage: Storage;
  /** Base URL for API (used for OAuth callback) */
  apiUrl: string;
  /** Base URL for frontend app (used for redirects after OAuth) */
  appUrl: string;
  /** Secret key for JWT state signing */
  jwtSecret: string;
}

interface OAuthState {
  spaceId: string;
  channelId: string;
  slug: string;
  provider: string;
  returnOrigin?: string;
}

// =============================================================================
// Zod Schemas
// =============================================================================

const ConnectQuerySchema = z.object({
  spaceId: z.string().min(1),
  channelId: z.string().min(1),
  slug: z.string().min(1),
  returnOrigin: z.string().url().optional(),
});

const DisconnectBodySchema = z.object({
  spaceId: z.string().min(1),
  channelId: z.string().min(1),
  slug: z.string().min(1),
});

const RefreshBodySchema = z.object({
  spaceId: z.string().min(1),
  channelId: z.string().min(1),
  slug: z.string().min(1),
});

// =============================================================================
// Helper Functions
// =============================================================================

function formatZodError(error: z.ZodError): { error: string; details: Array<{ path: string; message: string }> } {
  return {
    error: 'validation_error',
    details: error.errors.map((e) => ({
      path: e.path.join('.'),
      message: e.message,
    })),
  };
}

/**
 * Exchange authorization code for tokens.
 */
async function exchangeCodeForTokens(
  provider: string,
  code: string,
  redirectUri: string
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
}> {
  const app = getAppDefinition(provider);
  if (!app) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const credentials = getOAuthCredentials(provider);
  if (!credentials) {
    throw new Error(`OAuth not configured for ${provider}`);
  }

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  // GitHub uses a different grant_type approach
  if (provider !== 'github') {
    params.set('grant_type', 'authorization_code');
  }

  const response = await fetch(app.oauth.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${response.status} ${errorText}`);
  }

  // GitHub returns form-urlencoded by default, but we requested JSON
  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(`OAuth error: ${data.error_description || data.error}`);
  }

  if (!data.access_token) {
    throw new Error('No access_token in response');
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
    token_type: data.token_type || 'bearer',
  };
}

/**
 * Refresh an access token using refresh token.
 */
async function refreshAccessToken(
  provider: string,
  refreshToken: string
): Promise<{
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const app = getAppDefinition(provider);
  if (!app) {
    throw new Error(`Unknown provider: ${provider}`);
  }

  const credentials = getOAuthCredentials(provider);
  if (!credentials) {
    throw new Error(`OAuth not configured for ${provider}`);
  }

  const params = new URLSearchParams({
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch(app.oauth.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token refresh failed: ${response.status} ${errorText}`);
  }

  const data = await response.json() as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (data.error) {
    throw new Error(`OAuth error: ${data.error_description || data.error}`);
  }

  if (!data.access_token) {
    throw new Error('No access_token in response');
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_in: data.expires_in,
  };
}

// =============================================================================
// Route Factory
// =============================================================================

export function createAppRoutes(options: AppHandlerOptions): Hono {
  const { storage, apiUrl, appUrl, jwtSecret } = options;
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // GET /auth/apps - List available apps
  // ---------------------------------------------------------------------------
  app.get('/', async (c) => {
    const apps = getConfiguredApps().map((app) => ({
      id: app.id,
      name: app.name,
      description: app.description,
      icon: app.icon,
      scopes: app.oauth.scopes,
      settingsSchema: app.settingsSchema,
    }));

    return c.json({ apps });
  });

  // ---------------------------------------------------------------------------
  // GET /auth/apps/:provider/connect - Initiate OAuth flow
  // ---------------------------------------------------------------------------
  app.get('/:provider/connect', async (c) => {
    const provider = c.req.param('provider');

    // Validate query params
    const query = ConnectQuerySchema.safeParse({
      spaceId: c.req.query('spaceId'),
      channelId: c.req.query('channelId'),
      slug: c.req.query('slug'),
      returnOrigin: c.req.query('returnOrigin'),
    });

    if (!query.success) {
      return c.json(formatZodError(query.error), 400);
    }

    const { spaceId, channelId, slug, returnOrigin } = query.data;

    // Get app definition
    const appDef = getAppDefinition(provider);
    if (!appDef) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    // Check OAuth is configured
    const credentials = getOAuthCredentials(provider);
    if (!credentials) {
      return c.json({ error: `OAuth not configured for ${provider}` }, 503);
    }

    // Generate state JWT (include returnOrigin if provided)
    const state: OAuthState = { spaceId, channelId, slug, provider, returnOrigin };
    const stateToken = jwt.sign(state, jwtSecret, { expiresIn: '10m' });

    // Build authorization URL
    const redirectUri = `${apiUrl}/auth/apps/callback`;
    const authUrl = new URL(appDef.oauth.authorizationUrl);
    authUrl.searchParams.set('client_id', credentials.clientId);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('scope', appDef.oauth.scopes.join(' '));
    authUrl.searchParams.set('state', stateToken);

    // Provider-specific params
    if (provider === 'github') {
      authUrl.searchParams.set('allow_signup', 'false');
    }

    // Return authorization URL for frontend to handle navigation
    // (SPA pattern - avoids CORS issues with fetch following redirects)
    return c.json({ authorizationUrl: authUrl.toString() });
  });

  // ---------------------------------------------------------------------------
  // GET /auth/apps/callback - OAuth callback
  // ---------------------------------------------------------------------------
  app.get('/callback', async (c) => {
    const code = c.req.query('code');
    const stateToken = c.req.query('state');
    const error = c.req.query('error');
    const errorDescription = c.req.query('error_description');

    // Helper to get redirect base from state token (if valid)
    const getRedirectBase = (): string => {
      if (stateToken) {
        try {
          const decoded = jwt.verify(stateToken, jwtSecret) as OAuthState;
          return decoded.returnOrigin || appUrl;
        } catch {
          // State invalid, fall back to appUrl
        }
      }
      return appUrl;
    };

    // Handle OAuth errors
    if (error) {
      const redirectBase = getRedirectBase();
      const errorUrl = new URL(`${redirectBase}/oauth-error`);
      errorUrl.searchParams.set('error', error);
      if (errorDescription) {
        errorUrl.searchParams.set('description', errorDescription);
      }
      return c.redirect(errorUrl.toString());
    }

    if (!code || !stateToken) {
      return c.json({ error: 'Missing code or state parameter' }, 400);
    }

    // Verify and decode state
    let state: OAuthState;
    try {
      state = jwt.verify(stateToken, jwtSecret) as OAuthState;
    } catch {
      return c.json({ error: 'Invalid or expired state token' }, 400);
    }

    const { spaceId, channelId, slug, provider, returnOrigin } = state;

    // Use returnOrigin from state if provided, otherwise fall back to appUrl
    const redirectBase = returnOrigin || appUrl;

    try {
      // Exchange code for tokens
      const redirectUri = `${apiUrl}/auth/apps/callback`;
      const tokens = await exchangeCodeForTokens(provider, code, redirectUri);

      // Calculate expiry timestamp
      const expiresAt = tokens.expires_in
        ? new Date(Date.now() + tokens.expires_in * 1000).toISOString()
        : undefined;

      // Resolve channel to get internal ID
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        throw new Error(`Channel not found: ${channelId}`);
      }

      // Store access token as secret
      await storage.setSecret(spaceId, channel.id, slug, 'accessToken', {
        value: tokens.access_token,
        expiresAt,
      });

      // Store refresh token if provided
      if (tokens.refresh_token) {
        await storage.setSecret(spaceId, channel.id, slug, 'refreshToken', {
          value: tokens.refresh_token,
          // Refresh tokens typically don't expire, or expire much later
        });
      }

      // Redirect back to app
      const successUrl = new URL(`${redirectBase}/spaces/${spaceId}/channels/${channelId}`);
      successUrl.searchParams.set('app', slug);
      successUrl.searchParams.set('connected', 'true');

      return c.redirect(successUrl.toString());
    } catch (err) {
      console.error('[Apps] OAuth callback error:', err);

      const errorUrl = new URL(`${redirectBase}/oauth-error`);
      errorUrl.searchParams.set('error', 'token_exchange_failed');
      errorUrl.searchParams.set('description', err instanceof Error ? err.message : 'Unknown error');

      return c.redirect(errorUrl.toString());
    }
  });

  // ---------------------------------------------------------------------------
  // POST /auth/apps/:provider/disconnect - Clear tokens
  // ---------------------------------------------------------------------------
  app.post('/:provider/disconnect', async (c) => {
    const provider = c.req.param('provider');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = DisconnectBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { spaceId, channelId, slug } = parsed.data;

    // Verify provider exists
    const appDef = getAppDefinition(provider);
    if (!appDef) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    try {
      // Resolve channel
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: `Channel not found: ${channelId}` }, 404);
      }

      // Delete secrets — status automatically becomes "not connected"
      await storage.deleteSecret(channel.id, slug, 'accessToken');
      await storage.deleteSecret(channel.id, slug, 'refreshToken');

      return c.json({ disconnected: true });
    } catch (err) {
      console.error('[Apps] Disconnect error:', err);
      return c.json({ error: 'Failed to disconnect app' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /auth/apps/:provider/refresh - Refresh expired token
  // ---------------------------------------------------------------------------
  app.post('/:provider/refresh', async (c) => {
    const provider = c.req.param('provider');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'Invalid JSON body' }, 400);
    }

    const parsed = RefreshBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json(formatZodError(parsed.error), 400);
    }

    const { spaceId, channelId, slug } = parsed.data;

    // Verify provider exists
    const appDef = getAppDefinition(provider);
    if (!appDef) {
      return c.json({ error: `Unknown provider: ${provider}` }, 404);
    }

    try {
      // Resolve channel
      const channel = await storage.resolveChannel(spaceId, channelId);

      if (!channel) {
        return c.json({ error: `Channel not found: ${channelId}` }, 404);
      }

      // Get refresh token
      const refreshToken = await storage.getSecretValue(spaceId, channel.id, slug, 'refreshToken');
      if (!refreshToken) {
        return c.json({ error: 'No refresh token available' }, 400);
      }

      // Refresh the token
      const newTokens = await refreshAccessToken(provider, refreshToken);

      // Calculate new expiry
      const newExpiresAt = newTokens.expires_in
        ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
        : undefined;

      // Store new access token
      await storage.setSecret(spaceId, channel.id, slug, 'accessToken', {
        value: newTokens.access_token,
        expiresAt: newExpiresAt,
      });

      // Update refresh token if a new one was issued
      if (newTokens.refresh_token) {
        await storage.setSecret(spaceId, channel.id, slug, 'refreshToken', {
          value: newTokens.refresh_token,
        });
      }

      // Return metadata for the new token
      const metadata = await storage.getSecretMetadata(channel.id, slug, 'accessToken');

      return c.json({
        refreshed: true,
        accessToken: {
          setAt: metadata?.setAt,
          expiresAt: metadata?.expiresAt,
        },
      });
    } catch (err) {
      console.error('[Apps] Token refresh error:', err);
      return c.json({
        error: 'Failed to refresh token',
        message: err instanceof Error ? err.message : 'Unknown error',
      }, 500);
    }
  });

  return app;
}

// =============================================================================
// Token Refresh Helper (for MCP derivation)
// =============================================================================

/**
 * Get a valid access token, refreshing if needed.
 * Used by agent spawn to ensure tokens are valid before derivation.
 */
export async function getValidAccessToken(
  storage: Storage,
  spaceId: string,
  channelId: string,
  slug: string,
  provider: string
): Promise<string | null> {
  // Get metadata to check expiry
  const accessTokenMeta = await storage.getSecretMetadata(channelId, slug, 'accessToken');

  if (!accessTokenMeta) {
    return null; // Not connected
  }

  // Check if still valid (with 1 minute buffer)
  const bufferMs = 60 * 1000;
  const isValid = !accessTokenMeta.expiresAt ||
    new Date(accessTokenMeta.expiresAt).getTime() > Date.now() + bufferMs;

  if (isValid) {
    return await storage.getSecretValue(spaceId, channelId, slug, 'accessToken');
  }

  // Token expired — try to refresh
  const refreshToken = await storage.getSecretValue(spaceId, channelId, slug, 'refreshToken');
  if (!refreshToken) {
    return null; // No refresh token, can't recover
  }

  try {
    const newTokens = await refreshAccessToken(provider, refreshToken);

    const newExpiresAt = newTokens.expires_in
      ? new Date(Date.now() + newTokens.expires_in * 1000).toISOString()
      : undefined;

    await storage.setSecret(spaceId, channelId, slug, 'accessToken', {
      value: newTokens.access_token,
      expiresAt: newExpiresAt,
    });

    if (newTokens.refresh_token) {
      await storage.setSecret(spaceId, channelId, slug, 'refreshToken', {
        value: newTokens.refresh_token,
      });
    }

    return newTokens.access_token;
  } catch (err) {
    console.error(`[Apps] Failed to refresh token for ${provider}:`, err);
    return null;
  }
}
