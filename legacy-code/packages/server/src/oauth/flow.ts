/**
 * OAuth 2.1 Authorization Flow
 *
 * Handles the authorization code flow with PKCE:
 * 1. Build authorization URL with PKCE challenge
 * 2. Handle callback with authorization code
 * 3. Track pending authorization states
 */

import { generatePKCE, generateState, type PKCEPair } from "./pkce.js";
import {
  resolveOAuthEndpoints,
  type ResolvedOAuthEndpoints,
  type OAuthConfig,
} from "./discovery.js";
import { getOrRegisterClient } from "./registration.js";

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
  channel: string;

  /** The MCP server URL */
  mcpUrl: string;

  /** Resolved OAuth endpoints */
  endpoints: ResolvedOAuthEndpoints;

  /** Timestamp when this state was created */
  createdAt: number;

  /** Redirect URI used in the authorization request */
  redirectUri: string;

  /** Client ID used in the authorization request */
  clientId: string;
}

/**
 * In-memory store for pending authorization states.
 * Key is the state parameter.
 */
const pendingAuthStates = new Map<string, PendingAuthState>();

/** Pending state TTL in milliseconds (10 minutes) */
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Clean up expired pending states.
 */
function cleanupExpiredStates(): void {
  const now = Date.now();
  for (const [state, pending] of pendingAuthStates) {
    if (now - pending.createdAt > PENDING_STATE_TTL_MS) {
      pendingAuthStates.delete(state);
    }
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupExpiredStates, 5 * 60 * 1000);

/**
 * Default client ID for OAuth flows.
 * Used as fallback when server doesn't support dynamic registration.
 */
const DEFAULT_CLIENT_ID = "cikada";

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
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state: state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.codeChallengeMethod,
  });

  // Add scopes if specified
  if (scopes.length > 0) {
    params.set("scope", scopes.join(" "));
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
  channel: string;

  /** The MCP server URL (from system.mcp props) */
  mcpUrl: string;

  /** OAuth config from system.mcp props */
  authConfig?: OAuthConfig;

  /** Base URL for building the redirect URI */
  baseUrl: string;
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
export async function startOAuthFlow(
  params: StartOAuthFlowParams
): Promise<StartOAuthFlowResult> {
  const { mcpSlug, channel, mcpUrl, authConfig, baseUrl } = params;

  // Resolve OAuth endpoints
  const endpoints = await resolveOAuthEndpoints(mcpUrl, authConfig);

  // Build redirect URI (needed for registration and auth)
  const redirectUri = `${baseUrl}/api/oauth/callback`;

  // Get or register client (supports RFC 7591 dynamic registration)
  let clientId: string;
  try {
    const clientInfo = await getOrRegisterClient(
      channel,
      mcpSlug,
      mcpUrl,
      redirectUri,
      authConfig?.clientId // Use configured client_id if provided
    );
    clientId = clientInfo.clientId;
  } catch (error) {
    // Fall back to default client ID if registration fails or not supported
    console.warn(
      `[oauth] Dynamic client registration failed for ${mcpSlug}, using default client ID:`,
      error instanceof Error ? error.message : "Unknown error"
    );
    clientId = authConfig?.clientId || DEFAULT_CLIENT_ID;
  }

  // Generate PKCE and state
  const pkce = generatePKCE();
  const state = generateState();

  // Store pending state
  const pendingState: PendingAuthState = {
    state,
    codeVerifier: pkce.codeVerifier,
    mcpSlug,
    channel,
    mcpUrl,
    endpoints,
    createdAt: Date.now(),
    redirectUri,
    clientId,
  };
  pendingAuthStates.set(state, pendingState);

  // Build authorization URL
  const authorizationUrl = buildAuthorizationUrl(
    endpoints,
    pkce,
    state,
    redirectUri,
    clientId,
    endpoints.scopes
  );

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
      | "missing_state"
      | "invalid_state"
      | "expired_state"
      | "access_denied"
      | "server_error"
      | "missing_code"
  ) {
    super(message);
    this.name = "OAuthCallbackError";
  }
}

/**
 * Validate an OAuth callback and retrieve the pending state.
 *
 * @param params - Callback parameters from query string
 * @returns The validated callback with code and pending state
 * @throws OAuthCallbackError if validation fails
 */
export function validateCallback(
  params: OAuthCallbackParams
): ValidatedCallback {
  const { code, state, error, error_description } = params;

  // Check for error response
  if (error) {
    if (error === "access_denied") {
      throw new OAuthCallbackError(
        error_description ?? "User denied authorization",
        "access_denied"
      );
    }
    throw new OAuthCallbackError(
      error_description ?? `OAuth error: ${error}`,
      "server_error"
    );
  }

  // Validate state
  if (!state) {
    throw new OAuthCallbackError("Missing state parameter", "missing_state");
  }

  const pendingState = pendingAuthStates.get(state);
  if (!pendingState) {
    throw new OAuthCallbackError(
      "Invalid or expired state parameter",
      "invalid_state"
    );
  }

  // Check expiry
  if (Date.now() - pendingState.createdAt > PENDING_STATE_TTL_MS) {
    pendingAuthStates.delete(state);
    throw new OAuthCallbackError(
      "Authorization request expired",
      "expired_state"
    );
  }

  // Validate code
  if (!code) {
    throw new OAuthCallbackError(
      "Missing authorization code",
      "missing_code"
    );
  }

  // Remove pending state (one-time use)
  pendingAuthStates.delete(state);

  return { code, pendingState };
}

/**
 * Get a pending auth state by state parameter.
 * Does not remove the state (use validateCallback for that).
 *
 * @param state - The state parameter
 * @returns The pending state or undefined
 */
export function getPendingState(state: string): PendingAuthState | undefined {
  return pendingAuthStates.get(state);
}

/**
 * Clear all pending auth states (for testing).
 */
export function clearPendingStates(): void {
  pendingAuthStates.clear();
}

/**
 * Get count of pending auth states (for monitoring).
 */
export function getPendingStateCount(): number {
  return pendingAuthStates.size;
}
