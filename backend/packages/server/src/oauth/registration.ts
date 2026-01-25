/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591)
 *
 * Registers OAuth clients dynamically with authorization servers that support it.
 * Required for MCP servers that don't accept static client IDs.
 *
 * Client registrations are stored in memory with the idea that:
 * 1. They're long-lived (often don't expire)
 * 2. Re-registration is cheap if needed after restart
 * 3. Tokens are the critical thing to persist (which we do in artifact secrets)
 */

import { discoverOAuthMetadata } from './discovery.js';

/**
 * Client metadata for registration request (RFC 7591 Section 2)
 */
export interface ClientRegistrationRequest {
  /** Array of redirect URIs */
  redirect_uris: string[];
  /** Human-readable client name */
  client_name?: string;
  /** Token endpoint authentication method */
  token_endpoint_auth_method?: 'none' | 'client_secret_basic' | 'client_secret_post';
  /** Grant types this client will use */
  grant_types?: string[];
  /** Response types this client will use */
  response_types?: string[];
  /** URI for client's home page */
  client_uri?: string;
  /** Requested scope values */
  scope?: string;
}

/**
 * Client registration response (RFC 7591 Section 3.2.1)
 */
export interface ClientRegistrationResponse {
  /** Unique client identifier */
  client_id: string;
  /** Client secret (if issued) */
  client_secret?: string;
  /** Time at which the client_id was issued (Unix timestamp) */
  client_id_issued_at?: number;
  /** Time at which the client_secret expires (Unix timestamp, 0 = never) */
  client_secret_expires_at?: number;
  /** All other metadata echoed back */
  [key: string]: unknown;
}

/**
 * Stored client registration data
 */
export interface StoredClientRegistration {
  /** The registered client_id */
  clientId: string;
  /** The client_secret (if issued) */
  clientSecret?: string;
  /** When the registration was stored (ISO 8601) */
  registeredAt: string;
  /** When the client_secret expires (ISO 8601), if applicable */
  clientSecretExpiresAt?: string;
  /** The MCP server URL this registration is for */
  mcpUrl: string;
}

/**
 * Registration error
 */
export class ClientRegistrationError extends Error {
  constructor(
    message: string,
    public code: 'no_registration_endpoint' | 'registration_failed' | 'invalid_response' | 'network_error',
    public details?: string
  ) {
    super(message);
    this.name = 'ClientRegistrationError';
  }
}

/**
 * In-memory store for client registrations.
 * Key format: "channel:mcpSlug"
 */
const registrationCache = new Map<string, StoredClientRegistration>();

/**
 * Get cache key for a channel/MCP combination.
 */
function getCacheKey(channel: string, mcpSlug: string): string {
  return `${channel}:${mcpSlug}`;
}

/**
 * Get stored client registration for an MCP.
 *
 * @param channel - The channel containing the MCP artifact
 * @param mcpSlug - The system.mcp artifact slug
 * @returns The stored registration or null if not found
 */
export function getStoredRegistration(channel: string, mcpSlug: string): StoredClientRegistration | null {
  const key = getCacheKey(channel, mcpSlug);
  const stored = registrationCache.get(key);

  if (!stored) {
    return null;
  }

  // Check if secret has expired
  if (stored.clientSecretExpiresAt) {
    const expiresAt = new Date(stored.clientSecretExpiresAt).getTime();
    if (expiresAt > 0 && Date.now() > expiresAt) {
      // Secret expired, remove from cache
      registrationCache.delete(key);
      return null;
    }
  }

  return stored;
}

/**
 * Save client registration for an MCP.
 *
 * @param channel - The channel containing the MCP artifact
 * @param mcpSlug - The system.mcp artifact slug
 * @param registration - The registration response
 * @param mcpUrl - The MCP server URL
 */
export function saveRegistration(
  channel: string,
  mcpSlug: string,
  registration: ClientRegistrationResponse,
  mcpUrl: string
): void {
  const key = getCacheKey(channel, mcpSlug);

  const storedRegistration: StoredClientRegistration = {
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
    registeredAt: new Date().toISOString(),
    clientSecretExpiresAt: registration.client_secret_expires_at
      ? new Date(registration.client_secret_expires_at * 1000).toISOString()
      : undefined,
    mcpUrl,
  };

  registrationCache.set(key, storedRegistration);
}

/**
 * Delete stored client registration for an MCP.
 *
 * @param channel - The channel containing the MCP artifact
 * @param mcpSlug - The system.mcp artifact slug
 */
export function deleteRegistration(channel: string, mcpSlug: string): void {
  const key = getCacheKey(channel, mcpSlug);
  registrationCache.delete(key);
}

/**
 * Register a new OAuth client with the authorization server.
 *
 * @param registrationEndpoint - The dynamic client registration endpoint
 * @param redirectUri - The redirect URI for this client
 * @param clientName - Human-readable client name
 * @returns The registration response with client_id
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  clientName: string = 'Cast'
): Promise<ClientRegistrationResponse> {
  const requestBody: ClientRegistrationRequest = {
    redirect_uris: [redirectUri],
    client_name: clientName,
    token_endpoint_auth_method: 'none', // Public client (no secret required)
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
  };

  try {
    const response = await fetch(registrationEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'MCP-Protocol-Version': '2025-03-26',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      let errorDetails: string | undefined;
      try {
        const errorBody = await response.json() as { error_description?: string; error?: string };
        errorDetails = errorBody.error_description || errorBody.error || JSON.stringify(errorBody);
      } catch {
        errorDetails = await response.text();
      }

      throw new ClientRegistrationError(
        `Client registration failed: ${response.status} ${response.statusText}`,
        'registration_failed',
        errorDetails
      );
    }

    const result = (await response.json()) as ClientRegistrationResponse;

    if (!result.client_id) {
      throw new ClientRegistrationError('Registration response missing client_id', 'invalid_response');
    }

    return result;
  } catch (error) {
    if (error instanceof ClientRegistrationError) {
      throw error;
    }

    throw new ClientRegistrationError(
      `Network error during client registration: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'network_error'
    );
  }
}

/**
 * Get or register a client for an MCP server.
 *
 * 1. Check for stored registration (in-memory cache)
 * 2. If none, check if server supports dynamic registration
 * 3. If supported, register and store the result
 * 4. Return the client_id (and secret if provided)
 *
 * @param channel - The channel containing the MCP artifact
 * @param mcpSlug - The system.mcp artifact slug
 * @param mcpUrl - The MCP server URL
 * @param redirectUri - The redirect URI for OAuth callbacks
 * @param configuredClientId - Client ID from config (optional override)
 * @returns Object with clientId and optional clientSecret
 */
export async function getOrRegisterClient(
  channel: string,
  mcpSlug: string,
  mcpUrl: string,
  redirectUri: string,
  configuredClientId?: string
): Promise<{ clientId: string; clientSecret?: string }> {
  // If a client ID is explicitly configured, use it (no registration needed)
  if (configuredClientId) {
    return { clientId: configuredClientId };
  }

  // Check for stored registration
  const stored = getStoredRegistration(channel, mcpSlug);
  if (stored) {
    return { clientId: stored.clientId, clientSecret: stored.clientSecret };
  }

  // Discover OAuth metadata to find registration endpoint
  const metadata = await discoverOAuthMetadata(mcpUrl);

  if (!metadata.registration_endpoint) {
    throw new ClientRegistrationError(
      `Server at ${mcpUrl} does not support dynamic client registration`,
      'no_registration_endpoint'
    );
  }

  // Register new client
  console.log(`[oauth] Registering client for ${mcpSlug} at ${metadata.registration_endpoint}`);
  const registration = await registerClient(metadata.registration_endpoint, redirectUri, 'Cast');

  // Store registration in memory
  saveRegistration(channel, mcpSlug, registration, mcpUrl);

  return {
    clientId: registration.client_id,
    clientSecret: registration.client_secret,
  };
}

/**
 * Clear all stored registrations (for testing).
 */
export function clearRegistrationCache(): void {
  registrationCache.clear();
}
