/**
 * Sanity OAuth Authentication
 *
 * Implements Sanity OAuth flow for production authentication.
 * Uses Mellon-assigned client IDs (RFC 7591 Dynamic Client Registration) and PKCE.
 *
 * Mellon endpoints: https://mcp.sanity.io/{register,authorize,token}
 */

import crypto from 'crypto';
import { generatePKCE, generateState, type PKCEPair } from '../oauth/pkce.js';
import { exchangeCodeForTokens, type TokenData } from '../oauth/tokens.js';
import { getAuthStateStorage } from './auth-state-storage.js';
import { getOAuthClientStorage, type OAuthClientCredentials } from './oauth-client-storage.js';

// =============================================================================
// Constants
// =============================================================================

/** Default Sanity OAuth URL (production) */
const DEFAULT_SANITY_OAUTH_URL = 'https://mcp.sanity.io';

/** Pending state TTL in milliseconds (10 minutes) */
const PENDING_STATE_TTL_MS = 10 * 60 * 1000;

// =============================================================================
// Configurable OAuth URL
// =============================================================================

/** Current OAuth base URL (can be overridden for mock server) */
let oauthBaseUrl = process.env.SANITY_OAUTH_URL || DEFAULT_SANITY_OAUTH_URL;

/**
 * Set the OAuth base URL (for mock server support).
 * @param url - The base URL for OAuth endpoints (e.g., "http://localhost:3001/mock-oauth")
 */
export function setOAuthBaseUrl(url: string): void {
  oauthBaseUrl = url;
  console.log(`[SanityAuth] OAuth base URL set to: ${url}`);
}

/**
 * Get the current OAuth base URL.
 */
export function getOAuthBaseUrl(): string {
  return oauthBaseUrl;
}

/**
 * Reset OAuth base URL to default (for testing).
 */
export function resetOAuthBaseUrl(): void {
  oauthBaseUrl = DEFAULT_SANITY_OAUTH_URL;
}

/**
 * Get OAuth endpoint URLs based on current base URL.
 */
function getOAuthEndpoints() {
  return {
    authorize: `${oauthBaseUrl}/authorize`,
    token: `${oauthBaseUrl}/token`,
    register: `${oauthBaseUrl}/register`,
  };
}

// =============================================================================
// Types
// =============================================================================

/**
 * Sanity user info from the access token.
 */
export interface SanityUserInfo {
  /** Sanity user ID */
  userId: string;
  /** User's name (if available) */
  name?: string;
  /** User's email (if available) */
  email?: string;
}

/**
 * Pending Sanity auth state.
 */
export interface PendingSanityAuthState {
  /** Random state for CSRF protection */
  state: string;
  /** PKCE code_verifier for token exchange */
  codeVerifier: string;
  /** Redirect URI used in the authorization request */
  redirectUri: string;
  /** Client ID used in the authorization request */
  clientId: string;
  /** Timestamp when this state was created */
  createdAt: number;
  /** URL to redirect user back to after successful authentication */
  returnUrl?: string;
}

// =============================================================================
// State Management
// =============================================================================

// State is now managed via AuthStateStorage abstraction (see auth-state-storage.ts).
// This allows using in-memory storage for local dev or DynamoDB for AWS Lambda.

// =============================================================================
// Dynamic Client Registration
// =============================================================================

/**
 * Response from Mellon's /register endpoint (RFC 7591).
 */
interface MellonRegistrationResponse {
  client_id: string;
  client_name?: string;
  redirect_uris?: string[];
  token_endpoint_auth_method?: string;
  grant_types?: string[];
  response_types?: string[];
}

/**
 * Get or register an OAuth client with Sanity Mellon.
 *
 * Mellon assigns client_id during registration (RFC 7591) - we don't provide one.
 * We store the assigned client_id and reuse it for subsequent requests.
 *
 * @param redirectUri - The redirect URI for OAuth callbacks
 * @param clientName - Human-readable client name
 * @returns The client_id (from storage or newly registered)
 */
export async function getOrRegisterClient(
  redirectUri: string,
  clientName: string = 'Cikada'
): Promise<string> {
  const storage = getOAuthClientStorage();

  // Check if we already have credentials for this redirect URI
  const existing = await storage.get(redirectUri);
  if (existing) {
    console.log(`[SanityAuth] Using cached client_id: ${existing.clientId}`);
    return existing.clientId;
  }

  // Register new client with Mellon
  const endpoints = getOAuthEndpoints();
  console.log(`[SanityAuth] Registering new client for: ${redirectUri}`);

  const response = await fetch(endpoints.register, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_name: clientName,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: 'none', // Public client
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[SanityAuth] Client registration failed: ${response.status} ${errorText}`);
    throw new Error(`Client registration failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as MellonRegistrationResponse;

  if (!data.client_id) {
    throw new Error('Mellon registration response missing client_id');
  }

  // Store the credentials
  const credentials: OAuthClientCredentials = {
    clientId: data.client_id,
    redirectUri,
    clientName,
    registeredAt: Date.now(),
  };
  await storage.save(redirectUri, credentials);

  console.log(`[SanityAuth] Client registered with Mellon: ${data.client_id}`);
  return data.client_id;
}

// =============================================================================
// OAuth Flow
// =============================================================================

/**
 * Start the Sanity OAuth login flow.
 *
 * @param baseUrl - Base URL of this server (e.g., "http://localhost:3001")
 * @param returnUrl - URL to redirect user back to after authentication (optional)
 * @returns Object with authorization URL to redirect user to
 */
export async function startSanityAuthFlow(baseUrl: string, returnUrl?: string): Promise<{
  authorizationUrl: string;
  state: string;
}> {
  const redirectUri = `${baseUrl}/auth/sanity/callback`;

  // Get or register client with Mellon (client_id is assigned by Mellon, not us)
  const clientId = await getOrRegisterClient(redirectUri);

  // Generate PKCE and state
  const pkce = generatePKCE();
  const state = generateState();

  // Store pending state via storage abstraction
  const pendingState: PendingSanityAuthState = {
    state,
    codeVerifier: pkce.codeVerifier,
    redirectUri,
    clientId,
    createdAt: Date.now(),
    returnUrl,
  };
  await getAuthStateStorage().save(state, pendingState, PENDING_STATE_TTL_MS);

  // Build authorization URL
  const endpoints = getOAuthEndpoints();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: pkce.codeChallengeMethod,
  });

  const authorizationUrl = `${endpoints.authorize}?${params.toString()}`;

  return { authorizationUrl, state };
}

/**
 * Handle the Sanity OAuth callback.
 *
 * @param code - Authorization code from callback
 * @param state - State parameter for verification
 * @returns Token data with access token, user info, and optional return URL
 */
export async function handleSanityAuthCallback(
  code: string,
  state: string
): Promise<{ tokens: TokenData; userInfo: SanityUserInfo; returnUrl?: string }> {
  // Validate and retrieve state (one-time use - automatically deleted)
  const pendingState = await getAuthStateStorage().getAndDelete(state);
  if (!pendingState) {
    throw new Error('Invalid or expired state parameter');
  }

  // Double-check expiry (storage TTL handles this, but be safe)
  if (Date.now() - pendingState.createdAt > PENDING_STATE_TTL_MS) {
    throw new Error('Authorization request expired');
  }

  // Exchange code for tokens
  const endpoints = getOAuthEndpoints();
  const tokens = await exchangeCodeForTokens(
    endpoints.token,
    code,
    pendingState.codeVerifier,
    pendingState.redirectUri,
    pendingState.clientId
  );

  // Extract user info from access token
  const userInfo = extractUserInfo(tokens.accessToken);

  return { tokens, userInfo, returnUrl: pendingState.returnUrl };
}

/**
 * Extract user info from a Sanity access token (JWT).
 *
 * @param accessToken - The access token JWT
 * @returns Extracted user info
 */
export function extractUserInfo(accessToken: string): SanityUserInfo {
  try {
    // JWT is base64url encoded: header.payload.signature
    const parts = accessToken.split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT format');
    }

    // Decode payload (middle part)
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8')
    );

    // Extract user ID from 'sub' claim
    const userId = payload.sub;
    if (!userId) {
      throw new Error('Missing sub claim in token');
    }

    return {
      userId,
      name: payload.name,
      email: payload.email,
    };
  } catch (error) {
    console.error('[SanityAuth] Failed to extract user info from token:', error);
    throw new Error('Failed to extract user info from access token');
  }
}

/**
 * Clear all pending Sanity auth states (for testing).
 */
export async function clearPendingSanityAuthStates(): Promise<void> {
  await getAuthStateStorage().clear();
}

/**
 * Get count of pending Sanity auth states (for monitoring).
 */
export async function getPendingSanityAuthStateCount(): Promise<number> {
  return getAuthStateStorage().count();
}
