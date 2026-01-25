/**
 * OAuth 2.1 metadata discovery (RFC 8414)
 *
 * Discovers OAuth server endpoints using the .well-known/oauth-authorization-server
 * endpoint, with fallback to default paths.
 */

import type { OAuthConfig } from './types.js';

/**
 * OAuth Authorization Server Metadata (RFC 8414)
 * https://datatracker.ietf.org/doc/html/rfc8414
 */
export interface OAuthServerMetadata {
  /** URL of the authorization server's authorization endpoint */
  authorization_endpoint: string;

  /** URL of the authorization server's token endpoint */
  token_endpoint: string;

  /** URL of the authorization server's dynamic client registration endpoint */
  registration_endpoint?: string;

  /** JSON array containing a list of the OAuth 2.0 scope values */
  scopes_supported?: string[];

  /** JSON array containing a list of the OAuth 2.0 response_type values */
  response_types_supported?: string[];

  /** JSON array containing a list of the OAuth 2.0 grant_type values */
  grant_types_supported?: string[];

  /** JSON array containing a list of client authentication methods */
  token_endpoint_auth_methods_supported?: string[];

  /** JSON array containing a list of PKCE code challenge methods */
  code_challenge_methods_supported?: string[];

  /** URL of the authorization server's revocation endpoint */
  revocation_endpoint?: string;

  /** Issuer identifier */
  issuer?: string;
}

/**
 * Resolved OAuth endpoints ready for use in the OAuth flow.
 */
export interface ResolvedOAuthEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  scopes: string[];
  codeChallengeMethodsSupported: string[];
  /** Supported token endpoint auth methods (e.g., "client_secret_basic", "client_secret_post") */
  tokenEndpointAuthMethods: string[];
}

/**
 * Cache for discovered OAuth metadata to avoid repeated requests.
 * Key is the MCP server URL origin.
 */
const metadataCache = new Map<string, { metadata: OAuthServerMetadata; timestamp: number }>();

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Discover OAuth server metadata for an MCP server URL.
 *
 * 1. First checks for cached metadata
 * 2. Tries .well-known/oauth-authorization-server endpoint
 * 3. Falls back to default /authorize and /token paths
 *
 * @param mcpUrl - The MCP server URL
 * @returns OAuth server metadata
 */
export async function discoverOAuthMetadata(mcpUrl: string): Promise<OAuthServerMetadata> {
  // Extract origin from URL
  const baseUrl = new URL(mcpUrl);
  const origin = baseUrl.origin;

  // Check cache
  const cached = metadataCache.get(origin);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.metadata;
  }

  // Try .well-known endpoint
  const wellKnownUrl = `${origin}/.well-known/oauth-authorization-server`;

  try {
    const response = await fetch(wellKnownUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'MCP-Protocol-Version': '2025-03-26',
      },
    });

    if (response.ok) {
      const metadata = (await response.json()) as OAuthServerMetadata;

      // Validate required fields
      if (metadata.authorization_endpoint && metadata.token_endpoint) {
        // Cache successful discovery
        metadataCache.set(origin, { metadata, timestamp: Date.now() });
        return metadata;
      }
    }
  } catch (error) {
    // Discovery failed - fall through to defaults
    console.warn(
      `OAuth discovery failed for ${origin}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  // Fallback to default paths
  const defaultMetadata: OAuthServerMetadata = {
    authorization_endpoint: `${origin}/authorize`,
    token_endpoint: `${origin}/token`,
    code_challenge_methods_supported: ['S256'], // PKCE required by OAuth 2.1
  };

  // Cache default metadata
  metadataCache.set(origin, { metadata: defaultMetadata, timestamp: Date.now() });
  return defaultMetadata;
}

/**
 * Resolve OAuth endpoints for an MCP server, applying any manual overrides
 * from the auth config.
 *
 * @param mcpUrl - The MCP server URL
 * @param authConfig - Optional OAuth config with manual endpoint overrides
 * @returns Resolved OAuth endpoints ready for use
 */
export async function resolveOAuthEndpoints(
  mcpUrl: string,
  authConfig?: OAuthConfig
): Promise<ResolvedOAuthEndpoints> {
  // If both endpoints are manually specified, skip discovery
  if (authConfig?.authorizationEndpoint && authConfig?.tokenEndpoint) {
    return {
      authorizationEndpoint: authConfig.authorizationEndpoint,
      tokenEndpoint: authConfig.tokenEndpoint,
      scopes: authConfig?.scopes ?? [],
      codeChallengeMethodsSupported: ['S256'], // Always assume S256 for manual config
      tokenEndpointAuthMethods: ['client_secret_post', 'client_secret_basic'], // Assume both for manual config
    };
  }

  // Discover metadata
  const metadata = await discoverOAuthMetadata(mcpUrl);

  // Apply manual overrides if specified
  return {
    authorizationEndpoint: authConfig?.authorizationEndpoint ?? metadata.authorization_endpoint,
    tokenEndpoint: authConfig?.tokenEndpoint ?? metadata.token_endpoint,
    scopes: authConfig?.scopes ?? metadata.scopes_supported ?? [],
    codeChallengeMethodsSupported: metadata.code_challenge_methods_supported ?? ['S256'],
    tokenEndpointAuthMethods: metadata.token_endpoint_auth_methods_supported ?? ['client_secret_post'],
  };
}

/**
 * Clear the metadata cache for a specific origin or all entries.
 *
 * @param origin - Optional origin to clear. If not specified, clears all.
 */
export function clearMetadataCache(origin?: string): void {
  if (origin) {
    metadataCache.delete(origin);
  } else {
    metadataCache.clear();
  }
}

/**
 * Check if a server supports PKCE (required by OAuth 2.1 and MCP spec).
 *
 * @param metadata - OAuth server metadata
 * @returns true if S256 code challenge method is supported
 */
export function supportsPKCE(metadata: OAuthServerMetadata): boolean {
  const methods = metadata.code_challenge_methods_supported ?? [];
  // S256 is required by OAuth 2.1. Plain is allowed but not recommended.
  return methods.length === 0 || methods.includes('S256');
}
