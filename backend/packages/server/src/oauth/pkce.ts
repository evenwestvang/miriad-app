/**
 * PKCE (Proof Key for Code Exchange) implementation
 *
 * Required by OAuth 2.1 and the MCP specification for all clients.
 * Uses S256 code challenge method (SHA-256 hash of code_verifier).
 *
 * @see https://datatracker.ietf.org/doc/html/rfc7636
 */

import * as crypto from 'crypto';

/**
 * PKCE code challenge methods.
 * S256 is required by OAuth 2.1; plain is deprecated.
 */
export type CodeChallengeMethod = 'S256' | 'plain';

/**
 * PKCE pair containing the verifier and its challenge.
 */
export interface PKCEPair {
  /** The code_verifier - a cryptographically random string (43-128 chars) */
  codeVerifier: string;

  /** The code_challenge - derived from code_verifier using the challenge method */
  codeChallenge: string;

  /** The code_challenge_method - always S256 for OAuth 2.1 compliance */
  codeChallengeMethod: 'S256';
}

/**
 * Generate a cryptographically secure code_verifier.
 *
 * Per RFC 7636, the code_verifier must be:
 * - Between 43 and 128 characters
 * - Using only unreserved URI characters: [A-Z] / [a-z] / [0-9] / "-" / "." / "_" / "~"
 *
 * We use 32 random bytes encoded as base64url, which produces 43 characters.
 *
 * @returns A cryptographically random code_verifier string
 */
export function generateCodeVerifier(): string {
  // 32 bytes = 256 bits of entropy, encoded as base64url = 43 characters
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Generate a code_challenge from a code_verifier using S256 method.
 *
 * S256: BASE64URL(SHA256(code_verifier))
 *
 * @param verifier - The code_verifier string
 * @returns The code_challenge string
 */
export function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

/**
 * Generate a complete PKCE pair for an OAuth authorization request.
 *
 * The code_verifier should be stored securely during the authorization flow
 * and used during token exchange. Never transmit the code_verifier to the
 * authorization server until the token exchange step.
 *
 * @returns A PKCEPair with code_verifier, code_challenge, and method
 *
 * @example
 * ```typescript
 * const pkce = generatePKCE();
 *
 * // Authorization request includes code_challenge
 * const authUrl = new URL(authorizationEndpoint);
 * authUrl.searchParams.set('code_challenge', pkce.codeChallenge);
 * authUrl.searchParams.set('code_challenge_method', pkce.codeChallengeMethod);
 *
 * // Store code_verifier for token exchange
 * await storePendingAuth(state, pkce.codeVerifier);
 *
 * // Token exchange includes code_verifier
 * const tokenParams = new URLSearchParams({
 *   code_verifier: pkce.codeVerifier,
 *   // ... other params
 * });
 * ```
 */
export function generatePKCE(): PKCEPair {
  const codeVerifier = generateCodeVerifier();
  return {
    codeVerifier,
    codeChallenge: generateCodeChallenge(codeVerifier),
    codeChallengeMethod: 'S256',
  };
}

/**
 * Verify that a code_verifier matches a code_challenge.
 *
 * This is primarily for testing, as the authorization server
 * performs this verification during token exchange.
 *
 * @param verifier - The code_verifier to verify
 * @param challenge - The code_challenge to verify against
 * @param method - The code_challenge_method (default: S256)
 * @returns true if the verifier matches the challenge
 */
export function verifyPKCE(verifier: string, challenge: string, method: CodeChallengeMethod = 'S256'): boolean {
  if (method === 'S256') {
    return generateCodeChallenge(verifier) === challenge;
  } else if (method === 'plain') {
    // Plain method (deprecated, not recommended)
    return verifier === challenge;
  }
  return false;
}

/**
 * Generate a cryptographically secure state parameter.
 *
 * The state parameter is used to prevent CSRF attacks and to maintain
 * state between the authorization request and callback.
 *
 * @returns A cryptographically random state string
 */
export function generateState(): string {
  return crypto.randomBytes(16).toString('base64url');
}
