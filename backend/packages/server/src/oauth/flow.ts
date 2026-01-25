/**
 * OAuth 2.1 Authorization Flow
 *
 * Handles the authorization code flow with PKCE:
 * 1. Build authorization URL with PKCE challenge
 * 2. Handle callback with authorization code
 * 3. Track pending authorization states
 */

import { generatePKCE, generateState, type PKCEPair } from './pkce.js';
import { resolveOAuthEndpoints, type ResolvedOAuthEndpoints } from './discovery.js';
import { getOrRegisterClient } from './registration.js';
import type { OAuthConfig } from './types.js';

/**
 * Pending authorization state.
 * Stored between authorization request and callback.
 */
export interface PendingAuthState {
  /** Random state for CSRF protection */
  state: string;

  /** PKCE code_verifier for token exchange */
  codeVerifier: string;

  /** The system.mcp slug this auth is for */
  mcpSlug: string;

  /** The channel containing the system.mcp artifact */
  channelId: string;

  /** The space ID */
  spaceId: string;

  /** The MCP server URL */
  mcpUrl: string;

  /** Timestamp when this state was created */
  createdAt: number;

  /** Redirect URI used in the authorization request */
  redirectUri: string;

  /** Client ID used in the authorization request */
  clientId: string;

  /** Client secret for confidential clients (optional) */
  clientSecret?: string;

  /** Token endpoint URL */
  tokenEndpoint: string;
}

/**
 * Build the authorization URL for the OAuth flow.
 *
 * @param endpoints - Resolved OAuth endpoints
 * @param pkce - PKCE pair with code_challenge
 * @param state - Random state for CSRF protection
 * @param redirectUri - URI to redirect back to after authorization
 * @param clientId - OAuth client ID
 * @param scopes - OAuth scopes to request
 * @returns The full authorization URL
 */
export function buildAuthorizationUrl(
  endpoints: ResolvedOAuthEndpoints,
  pkce: PKCEPair,
  state: string,
  redirectUri: string,
  clientId: string,
  scopes: string[] = []
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state: state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.codeChallengeMethod,
  });

  // Add scopes if specified
  if (scopes.length > 0) {
    params.set('scope', scopes.join(' '));
  }

  return `${endpoints.authorizationEndpoint}?${params.toString()}`;
}

/**
 * Parameters for starting an OAuth flow.
 */
export interface StartOAuthFlowParams {
  /** The system.mcp artifact slug */
  mcpSlug: string;

  /** The channel containing the system.mcp artifact */
  channelId: string;

  /** The space ID */
  spaceId: string;

  /** The MCP server URL (from system.mcp props) */
  mcpUrl: string;

  /** OAuth config from system.mcp props */
  authConfig?: OAuthConfig;

  /** The redirect URI for OAuth callbacks */
  redirectUri: string;

  /** The pending states map to store the state in */
  pendingStates: Map<string, PendingAuthState>;
}

/**
 * Result of starting an OAuth flow.
 */
export interface StartOAuthFlowResult {
  /** The authorization URL to redirect the user to */
  authorizationUrl: string;

  /** The state parameter for verification */
  state: string;
}

/**
 * Start an OAuth authorization flow.
 *
 * 1. Discover OAuth endpoints (or use manual overrides)
 * 2. Get or register client (RFC 7591 dynamic registration)
 * 3. Generate PKCE pair and state
 * 4. Store pending state
 * 5. Return authorization URL
 *
 * @param params - Flow parameters
 * @returns The authorization URL and state
 */
export async function startOAuthFlow(params: StartOAuthFlowParams): Promise<StartOAuthFlowResult> {
  const { mcpSlug, channelId, spaceId, mcpUrl, authConfig, redirectUri, pendingStates } = params;

  // Resolve OAuth endpoints
  const endpoints = await resolveOAuthEndpoints(mcpUrl, authConfig);

  // Get or register client (supports RFC 7591 dynamic registration)
  let clientId: string;
  let clientSecret: string | undefined;
  try {
    const clientInfo = await getOrRegisterClient(
      channelId,
      mcpSlug,
      mcpUrl,
      redirectUri,
      authConfig?.clientId // Use configured client_id if provided
    );
    clientId = clientInfo.clientId;
    clientSecret = clientInfo.clientSecret;
    console.log(`[oauth] Using client ID: ${clientId} for ${mcpSlug}`);
  } catch (error) {
    // Don't fall back to a made-up client ID - that won't work
    // If dynamic registration fails and no clientId is configured, we must fail
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[oauth] Client registration failed for ${mcpSlug}: ${errorMsg}`);
    console.error(
      `[oauth] Configure a clientId in the system.mcp artifact's auth config, or ensure the server supports RFC 7591 dynamic registration`
    );
    throw new Error(`OAuth client registration failed: ${errorMsg}. Configure clientId manually in system.mcp auth settings.`);
  }

  // Generate PKCE and state
  const pkce = generatePKCE();
  const state = generateState();

  // Store pending state in the provided map
  const pendingState: PendingAuthState = {
    state,
    codeVerifier: pkce.codeVerifier,
    mcpSlug,
    channelId,
    spaceId,
    mcpUrl,
    createdAt: Date.now(),
    redirectUri,
    clientId,
    clientSecret,
    tokenEndpoint: endpoints.tokenEndpoint,
  };
  pendingStates.set(state, pendingState);

  // Build authorization URL
  const authorizationUrl = buildAuthorizationUrl(endpoints, pkce, state, redirectUri, clientId, endpoints.scopes);

  return { authorizationUrl, state };
}

/**
 * Callback parameters from the authorization server.
 */
export interface OAuthCallbackParams {
  /** Authorization code (on success) */
  code?: string;

  /** State parameter for verification */
  state?: string;

  /** Error code (on failure) */
  error?: string;

  /** Error description (on failure) */
  error_description?: string;
}

/**
 * Result of validating an OAuth callback.
 */
export interface ValidatedCallback {
  /** The authorization code */
  code: string;

  /** The pending state that was validated */
  pendingState: PendingAuthState;
}

/**
 * OAuth callback validation error.
 */
export class OAuthCallbackError extends Error {
  constructor(
    message: string,
    public code:
      | 'missing_state'
      | 'invalid_state'
      | 'expired_state'
      | 'access_denied'
      | 'server_error'
      | 'missing_code'
  ) {
    super(message);
    this.name = 'OAuthCallbackError';
  }
}

/** Pending state TTL in milliseconds (10 minutes) */
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Validate an OAuth callback and retrieve the pending state.
 *
 * @param params - Callback parameters from query string
 * @param pendingStates - Map of pending authorization states
 * @returns The validated callback with code and pending state
 * @throws OAuthCallbackError if validation fails
 */
export function validateCallback(
  params: OAuthCallbackParams,
  pendingStates: Map<string, PendingAuthState>
): ValidatedCallback {
  const { code, state, error, error_description } = params;

  // Check for error response
  if (error) {
    if (error === 'access_denied') {
      throw new OAuthCallbackError(error_description ?? 'User denied authorization', 'access_denied');
    }
    throw new OAuthCallbackError(error_description ?? `OAuth error: ${error}`, 'server_error');
  }

  // Validate state
  if (!state) {
    throw new OAuthCallbackError('Missing state parameter', 'missing_state');
  }

  const pendingState = pendingStates.get(state);
  if (!pendingState) {
    throw new OAuthCallbackError('Invalid or expired state parameter', 'invalid_state');
  }

  // Check expiry
  if (Date.now() - pendingState.createdAt > PENDING_STATE_TTL_MS) {
    pendingStates.delete(state);
    throw new OAuthCallbackError('Authorization request expired', 'expired_state');
  }

  // Validate code
  if (!code) {
    throw new OAuthCallbackError('Missing authorization code', 'missing_code');
  }

  // Remove pending state (one-time use)
  pendingStates.delete(state);

  return { code, pendingState };
}

/**
 * Get a pending auth state by state parameter.
 * Does not remove the state (use validateCallback for that).
 *
 * @param state - The state parameter
 * @param pendingStates - Map of pending authorization states
 * @returns The pending state or undefined
 */
export function getPendingState(
  state: string,
  pendingStates: Map<string, PendingAuthState>
): PendingAuthState | undefined {
  return pendingStates.get(state);
}

/**
 * Clean up expired pending states.
 *
 * @param pendingStates - Map of pending authorization states
 */
export function cleanupExpiredStates(pendingStates: Map<string, PendingAuthState>): void {
  const now = Date.now();
  for (const [state, pending] of pendingStates) {
    if (now - pending.createdAt > PENDING_STATE_TTL_MS) {
      pendingStates.delete(state);
    }
  }
}

