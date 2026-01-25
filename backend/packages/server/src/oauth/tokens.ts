/**
 * OAuth Token Exchange and Refresh
 *
 * Handles token operations:
 * - Exchange authorization code for access/refresh tokens
 * - Refresh expired access tokens
 * - Token validation and expiry checking
 */

/**
 * OAuth token response from the authorization server.
 */
export interface TokenResponse {
  /** The access token */
  access_token: string;

  /** Token type (usually "Bearer") */
  token_type: string;

  /** Lifetime of the access token in seconds */
  expires_in?: number;

  /** Refresh token for obtaining new access tokens */
  refresh_token?: string;

  /** Space-separated list of granted scopes */
  scope?: string;
}

/**
 * Normalized token data for storage and use.
 */
export interface TokenData {
  /** The access token */
  accessToken: string;

  /** Refresh token for obtaining new access tokens */
  refreshToken?: string;

  /** When the access token expires (ISO 8601) */
  expiresAt?: string;

  /** Granted scopes */
  scopes?: string[];

  /** Token type (usually "Bearer") */
  tokenType: string;
}

/**
 * OAuth token error response.
 */
export interface TokenErrorResponse {
  error: string;
  error_description?: string;
  error_uri?: string;
}

/**
 * Error thrown when token operations fail.
 */
export class OAuthTokenError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: TokenErrorResponse
  ) {
    super(message);
    this.name = 'OAuthTokenError';
  }
}

/** Time buffer before expiry to trigger refresh (5 minutes) */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

/** Supported client authentication methods for the token endpoint */
export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

/**
 * Determine the best auth method to use based on server support.
 * Prefers client_secret_basic if supported, falls back to client_secret_post.
 */
export function selectAuthMethod(
  supportedMethods: string[],
  hasClientSecret: boolean
): TokenEndpointAuthMethod {
  if (!hasClientSecret) {
    return 'none';
  }
  // Prefer client_secret_basic if server supports it (more secure - credentials not in body)
  if (supportedMethods.includes('client_secret_basic')) {
    return 'client_secret_basic';
  }
  // Fall back to client_secret_post
  if (supportedMethods.includes('client_secret_post')) {
    return 'client_secret_post';
  }
  // Default to post if server doesn't specify
  return 'client_secret_post';
}

/**
 * Build headers for token endpoint request based on auth method.
 */
function buildTokenRequestHeaders(
  authMethod: TokenEndpointAuthMethod,
  clientId: string,
  clientSecret?: string
): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  if (authMethod === 'client_secret_basic' && clientSecret) {
    // RFC 6749: client_id:client_secret base64 encoded in Authorization header
    const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    headers['Authorization'] = `Basic ${credentials}`;
  }

  return headers;
}

/**
 * Exchange an authorization code for tokens.
 *
 * @param tokenEndpoint - The token endpoint URL
 * @param code - The authorization code from the callback
 * @param codeVerifier - The PKCE code_verifier
 * @param redirectUri - The redirect URI used in the authorization request
 * @param clientId - The OAuth client ID
 * @param clientSecret - The OAuth client secret (for confidential clients)
 * @param authMethod - The authentication method to use (default: client_secret_post)
 * @returns Token data
 */
export async function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
  clientId: string,
  clientSecret?: string,
  authMethod: TokenEndpointAuthMethod = 'client_secret_post'
): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });

  // Add client_secret in body for client_secret_post method
  if (authMethod === 'client_secret_post' && clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const headers = buildTokenRequestHeaders(authMethod, clientId, clientSecret);

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    let errorData: TokenErrorResponse | undefined;
    try {
      errorData = (await response.json()) as TokenErrorResponse;
    } catch {
      // Response wasn't JSON
    }

    throw new OAuthTokenError(
      errorData?.error_description ?? `Token exchange failed: ${response.status}`,
      errorData?.error ?? 'token_exchange_failed',
      errorData
    );
  }

  const tokenResponse = (await response.json()) as TokenResponse;
  return normalizeTokenResponse(tokenResponse);
}

/**
 * Refresh an access token using a refresh token.
 *
 * @param tokenEndpoint - The token endpoint URL
 * @param refreshToken - The refresh token
 * @param clientId - The OAuth client ID
 * @param clientSecret - The OAuth client secret (for confidential clients)
 * @param authMethod - The authentication method to use (default: client_secret_post)
 * @returns New token data
 */
export async function refreshAccessToken(
  tokenEndpoint: string,
  refreshToken: string,
  clientId: string,
  clientSecret?: string,
  authMethod: TokenEndpointAuthMethod = 'client_secret_post'
): Promise<TokenData> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });

  // Add client_secret in body for client_secret_post method
  if (authMethod === 'client_secret_post' && clientSecret) {
    body.set('client_secret', clientSecret);
  }

  const headers = buildTokenRequestHeaders(authMethod, clientId, clientSecret);

  const response = await fetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (!response.ok) {
    let errorData: TokenErrorResponse | undefined;
    try {
      errorData = (await response.json()) as TokenErrorResponse;
    } catch {
      // Response wasn't JSON
    }

    throw new OAuthTokenError(
      errorData?.error_description ?? `Token refresh failed: ${response.status}`,
      errorData?.error ?? 'refresh_failed',
      errorData
    );
  }

  const tokenResponse = (await response.json()) as TokenResponse;

  // Some servers don't return a new refresh token - preserve the old one
  const normalized = normalizeTokenResponse(tokenResponse);
  if (!normalized.refreshToken) {
    normalized.refreshToken = refreshToken;
  }

  return normalized;
}

/**
 * Normalize a token response into our internal format.
 */
function normalizeTokenResponse(response: TokenResponse): TokenData {
  let expiresAt: string | undefined;
  if (response.expires_in) {
    expiresAt = new Date(Date.now() + response.expires_in * 1000).toISOString();
  }

  return {
    accessToken: response.access_token,
    refreshToken: response.refresh_token,
    expiresAt,
    scopes: response.scope?.split(' ').filter(Boolean),
    tokenType: response.token_type || 'Bearer',
  };
}

/**
 * Check if a token is expired or will expire soon.
 *
 * @param expiresAt - The expiry time (ISO 8601) or undefined if no expiry
 * @param bufferMs - Time buffer before expiry to consider as "expiring soon"
 * @returns "valid", "expiring", or "expired"
 */
export function checkTokenExpiry(
  expiresAt: string | undefined,
  bufferMs: number = REFRESH_BUFFER_MS
): 'valid' | 'expiring' | 'expired' {
  if (!expiresAt) {
    // No expiry set - assume valid
    return 'valid';
  }

  const expiry = new Date(expiresAt).getTime();
  const now = Date.now();

  if (expiry <= now) {
    return 'expired';
  }

  if (expiry <= now + bufferMs) {
    return 'expiring';
  }

  return 'valid';
}

/**
 * Check if a token needs refresh (expired or expiring soon).
 *
 * @param expiresAt - The expiry time (ISO 8601) or undefined
 * @returns true if the token should be refreshed
 */
export function needsRefresh(expiresAt: string | undefined): boolean {
  const status = checkTokenExpiry(expiresAt);
  return status === 'expired' || status === 'expiring';
}

/**
 * Get a valid access token, refreshing if necessary.
 *
 * This is the main entry point for getting a token to use in requests.
 * It handles automatic refresh when tokens are expired or expiring soon.
 *
 * @param tokenData - Current token data
 * @param tokenEndpoint - The token endpoint URL for refresh
 * @param clientId - The OAuth client ID
 * @param clientSecret - The OAuth client secret (for confidential clients)
 * @param onTokenRefreshed - Callback when tokens are refreshed (for storage)
 * @returns The access token to use
 */
export async function getValidAccessToken(
  tokenData: TokenData,
  tokenEndpoint: string,
  clientId: string,
  clientSecret?: string,
  onTokenRefreshed?: (newTokens: TokenData) => void | Promise<void>
): Promise<string> {
  const expiryStatus = checkTokenExpiry(tokenData.expiresAt);

  // Token is valid - return it
  if (expiryStatus === 'valid') {
    return tokenData.accessToken;
  }

  // Token is expired or expiring - try to refresh
  if (!tokenData.refreshToken) {
    if (expiryStatus === 'expired') {
      throw new OAuthTokenError('Access token expired and no refresh token available', 'token_expired');
    }
    // Expiring but no refresh token - return current token, it might still work
    return tokenData.accessToken;
  }

  // Refresh the token
  const newTokens = await refreshAccessToken(tokenEndpoint, tokenData.refreshToken, clientId, clientSecret);

  // Notify caller of new tokens
  if (onTokenRefreshed) {
    await onTokenRefreshed(newTokens);
  }

  return newTokens.accessToken;
}

/**
 * Build an Authorization header value from token data.
 *
 * @param tokenData - The token data
 * @returns The Authorization header value (e.g., "Bearer abc123")
 */
export function buildAuthorizationHeader(tokenData: TokenData): string {
  return `${tokenData.tokenType} ${tokenData.accessToken}`;
}
