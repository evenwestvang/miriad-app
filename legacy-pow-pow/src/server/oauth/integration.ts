/**
 * OAuth Integration with MCP Resolution
 *
 * Handles injecting OAuth tokens into MCP HTTP requests during agent spawn.
 */

import { store, type ResolvedMcpConfig, type McpReference } from "../store.js";
import {
  getStoredToken,
  saveToken,
  isTokenExpired,
  tokenNeedsRefresh,
  type StoredToken,
} from "./storage.js";
import {
  refreshAccessToken,
  getValidAccessToken,
  selectAuthMethod,
  type TokenData,
} from "./tokens.js";
import { resolveOAuthEndpoints } from "./discovery.js";
import { getStoredRegistration } from "./registration.js";
import type { OAuthConfig } from "../../shared/artifact-schemas.js";

/** Default client ID for OAuth */
const DEFAULT_CLIENT_ID = "powpow";

/**
 * Get a valid OAuth token for an MCP, refreshing if necessary.
 *
 * @param channel - The channel containing the MCP
 * @param mcpSlug - The MCP slug
 * @param mcpUrl - The MCP server URL
 * @param authConfig - OAuth configuration from the artifact
 * @returns The access token, or null if not available
 */
export async function getValidOAuthToken(
  channel: string,
  mcpSlug: string,
  mcpUrl: string,
  authConfig: OAuthConfig
): Promise<string | null> {
  const storedToken = getStoredToken(channel, mcpSlug);

  if (!storedToken) {
    console.warn(
      `[oauth] No token stored for ${channel}/${mcpSlug} - user needs to connect`
    );
    return null;
  }

  // If token is valid and not expiring soon, return it
  if (!tokenNeedsRefresh(storedToken)) {
    return storedToken.accessToken;
  }

  // Token needs refresh
  if (!storedToken.refreshToken) {
    if (isTokenExpired(storedToken)) {
      console.warn(
        `[oauth] Token expired for ${channel}/${mcpSlug} and no refresh token - user needs to reconnect`
      );
      return null;
    }
    // Token is expiring but no refresh token - return it anyway, might still work
    console.warn(
      `[oauth] Token expiring soon for ${channel}/${mcpSlug} but no refresh token`
    );
    return storedToken.accessToken;
  }

  // Attempt refresh
  try {
    const endpoints = await resolveOAuthEndpoints(mcpUrl, authConfig);

    // Get client credentials (from config, stored token, or stored registration)
    let clientId = authConfig.clientId;
    let clientSecret: string | undefined;
    if (!clientId) {
      // First try to use clientId from the stored token (preserves origin-based ID)
      if (storedToken.clientId) {
        clientId = storedToken.clientId;
      } else {
        // Fall back to stored registration or default
        const registration = getStoredRegistration(channel, mcpSlug);
        if (registration) {
          clientId = registration.clientId;
          clientSecret = registration.clientSecret;
        } else {
          clientId = DEFAULT_CLIENT_ID;
        }
      }
    }

    // Select auth method based on server support
    const authMethod = selectAuthMethod(endpoints.tokenEndpointAuthMethods, !!clientSecret);

    const newTokens = await refreshAccessToken(
      endpoints.tokenEndpoint,
      storedToken.refreshToken,
      clientId,
      clientSecret,
      authMethod
    );

    // Save refreshed tokens (preserve clientId for future refreshes)
    saveToken(channel, mcpSlug, newTokens, mcpUrl, clientId);
    console.error(`[oauth] Token refreshed for ${channel}/${mcpSlug}`);

    return newTokens.accessToken;
  } catch (error) {
    console.error(
      `[oauth] Token refresh failed for ${channel}/${mcpSlug}:`,
      error
    );

    // If original token is expired, we can't use it
    if (isTokenExpired(storedToken)) {
      return null;
    }

    // Return expiring token as last resort
    return storedToken.accessToken;
  }
}

/**
 * Extended ResolvedMcpConfig with OAuth auth info.
 */
export interface ResolvedMcpConfigWithAuth extends ResolvedMcpConfig {
  /** Whether this MCP uses OAuth (for logging/debugging) */
  usesOAuth?: boolean;
}

/**
 * Resolve MCP configs with OAuth token injection.
 *
 * This is an async version of store.resolveMcpConfigs that handles
 * OAuth token retrieval and refresh.
 *
 * @param channel - The channel to resolve MCPs for
 * @param mcpRefs - Array of MCP references to resolve
 * @returns Resolved configs with OAuth tokens injected
 */
export async function resolveMcpConfigsWithOAuth(
  channel: string,
  mcpRefs: McpReference[]
): Promise<ResolvedMcpConfigWithAuth[]> {
  console.error(`[oauth] resolveMcpConfigsWithOAuth called: channel=${channel}, mcpRefs=${JSON.stringify(mcpRefs)}`);
  const configs: ResolvedMcpConfigWithAuth[] = [];

  for (const ref of mcpRefs) {
    console.error(`[oauth] Resolving MCP: ${ref.slug} for channel ${channel}`);
    const resolved = store.resolveMcpForAgent(channel, ref.slug);
    if (!resolved) {
      console.error(
        `[powpow] MCP not found: ${ref.slug} (checked ${channel} and root)`
      );
      continue;
    }

    const { artifact, sourceChannel } = resolved;
    console.error(`[oauth] Found MCP artifact: slug=${artifact.slug}, type=${artifact.type}, sourceChannel=${sourceChannel}`);

    const props = artifact.props as Record<string, unknown>;
    const transport = props.transport as "stdio" | "http";
    const auth = props.auth as OAuthConfig | undefined;
    console.error(`[oauth] MCP props: transport=${transport}, auth=${JSON.stringify(auth)}, url=${props.url}`);

    const config: ResolvedMcpConfigWithAuth = {
      slug: ref.slug,
      transport,
    };

    if (transport === "stdio") {
      // Stdio transport - resolve env vars
      config.command = props.command as string | undefined;
      config.args = props.args as string[] | undefined;
      config.cwd = props.cwd as string | undefined;
      const env = props.env as Record<string, string> | undefined;
      if (env) {
        config.env = resolveEnvVars(env);
      }
    } else if (transport === "http") {
      config.url = props.url as string | undefined;

      // Start with any static headers
      const headers = props.headers as Record<string, string> | undefined;
      if (headers) {
        config.headers = resolveEnvVars(headers);
      }

      // Handle OAuth authentication
      // IMPORTANT: Use sourceChannel for token lookup - tokens are stored where the MCP lives,
      // not where the agent spawns. MCP in #root means tokens are in ~/.cast/oauth-tokens/root/
      if (auth?.type === "oauth" && config.url) {
        config.usesOAuth = true;
        console.error(`[oauth] Looking up OAuth token for ${ref.slug} in channel ${sourceChannel} (MCP source, not agent channel ${channel})`);

        const token = await getValidOAuthToken(
          sourceChannel,  // Use MCP's source channel, not agent's channel
          ref.slug,
          config.url,
          auth
        );

        if (token) {
          config.headers = {
            ...config.headers,
            Authorization: `Bearer ${token}`,
          };
          console.error(
            `[oauth] Injected OAuth token for ${ref.slug} (from ${sourceChannel})`
          );
        } else {
          // No valid token - skip this MCP
          console.warn(
            `[oauth] Skipping MCP ${ref.slug} - no valid OAuth token in ${sourceChannel}`
          );
          continue;
        }
      }
    }

    configs.push(config);
    console.error(`[oauth] Added MCP config: ${ref.slug}, transport=${config.transport}, hasHeaders=${!!config.headers}`);
  }

  console.error(`[oauth] resolveMcpConfigsWithOAuth returning ${configs.length} configs`);
  return configs;
}

/**
 * Resolve ${VAR_NAME} references in env vars.
 * Duplicated from store.ts to keep this module self-contained.
 */
function resolveEnvVars(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        console.error(
          `[powpow] Warning: env var ${varName} not found, leaving as ${match}`
        );
        return match;
      }
      return envValue;
    });
  }
  return result;
}
