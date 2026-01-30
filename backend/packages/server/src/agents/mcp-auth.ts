/**
 * MCP Authentication Helpers
 *
 * Shared utilities for handling HTTP MCP headers and OAuth token injection.
 * Used by both invoker-adapter.ts and agent-manager.ts.
 */

/**
 * Normalize HTTP headers to use canonical header casing.
 * Specifically handles Authorization header case-insensitivity.
 *
 * HTTP headers are case-insensitive per RFC 7230, but some servers/clients
 * may behave differently with duplicate headers of different casing.
 * This ensures we always use the canonical "Authorization" form.
 *
 * @returns normalized headers with Authorization in canonical form
 */
export function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {};

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "authorization") {
      result["Authorization"] = value;
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Result of preparing headers for an HTTP MCP.
 */
export interface PrepareHttpMcpHeadersResult {
  /** The prepared headers (normalized, with OAuth token if applicable) */
  headers: Record<string, string>;
  /** Whether this MCP should be skipped (OAuth required but unavailable) */
  skip: boolean;
  /** Reason for skipping (for logging) */
  skipReason?: string;
  /** Whether OAuth token was injected */
  oauthInjected?: boolean;
}

/**
 * Options for prepareHttpMcpHeaders.
 */
export interface PrepareHttpMcpHeadersOptions {
  /** Headers configured by the user in props.headers */
  configuredHeaders?: Record<string, string>;
  /** Whether the MCP has explicit OAuth configuration (props.oauth) */
  hasOAuthConfig: boolean;
  /** Function to fetch a valid OAuth token (with auto-refresh) */
  getValidOAuthToken?: (
    spaceId: string,
    channelId: string,
    mcpSlug: string,
  ) => Promise<string | null>;
  /** Space ID for OAuth token lookup */
  spaceId?: string;
  /** Channel ID where the MCP artifact lives (for OAuth token lookup) */
  channelId: string;
  /** MCP artifact slug */
  mcpSlug: string;
}

/**
 * Prepare headers for an HTTP MCP, handling OAuth token injection.
 *
 * Flow:
 * 1. Merge and normalize configured headers (Authorization → canonical form)
 * 2. If Authorization header present, use it (user-configured takes precedent)
 * 3. If no Authorization header, try OAuth token injection
 * 4. If OAuth explicitly configured but no token available, signal to skip the MCP
 *
 * This ensures:
 * - User-supplied Authorization headers always take precedent
 * - OAuth tokens are injected when no auth header is present
 * - MCPs with explicit OAuth config but no valid token are skipped
 * - Header keys are normalized to prevent duplicates
 */
export async function prepareHttpMcpHeaders(
  options: PrepareHttpMcpHeadersOptions,
): Promise<PrepareHttpMcpHeadersResult> {
  const {
    configuredHeaders,
    hasOAuthConfig,
    getValidOAuthToken,
    spaceId,
    channelId,
    mcpSlug,
  } = options;

  // 1. Normalize configured headers (handles case-insensitive Authorization)
  const headers = normalizeHeaders(configuredHeaders);

  // 2. Check if user provided Authorization header (already normalized)
  // Use "in" operator to honor presence even if value is empty
  if ("Authorization" in headers) {
    // User-configured Authorization takes precedent over OAuth
    return { headers, skip: false };
  }

  // 3. No Authorization header - try OAuth injection
  if (getValidOAuthToken && spaceId) {
    const accessToken = await getValidOAuthToken(spaceId, channelId, mcpSlug);
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
      return { headers, skip: false, oauthInjected: true };
    }
    // OAuth fetch returned null - skip only if OAuth was explicitly configured
    if (hasOAuthConfig) {
      return {
        headers,
        skip: true,
        skipReason: "OAuth configured but no valid token",
      };
    }
  } else if (hasOAuthConfig) {
    // OAuth explicitly configured but no token fetcher available
    return {
      headers,
      skip: true,
      skipReason: "OAuth configured but token fetcher not available",
    };
  }

  // No OAuth config and no user-provided auth - proceed without auth
  return { headers, skip: false };
}
