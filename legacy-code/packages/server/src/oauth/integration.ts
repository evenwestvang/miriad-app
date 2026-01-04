/**
 * OAuth Integration with MCP Resolution
 *
 * Handles injecting OAuth tokens into MCP HTTP requests during agent spawn.
 */

import {
  getStoredToken,
  saveToken,
  isTokenExpired,
  tokenNeedsRefresh,
} from "./storage.js";
import { refreshAccessToken } from "./tokens.js";
import { resolveOAuthEndpoints } from "./discovery.js";
import type { OAuthConfig } from "../artifact-schemas.js";

/** Default client ID for OAuth */
const DEFAULT_CLIENT_ID = "cikada";

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
    const clientId = authConfig.clientId ?? DEFAULT_CLIENT_ID;

    const newTokens = await refreshAccessToken(
      endpoints.tokenEndpoint,
      storedToken.refreshToken,
      clientId
    );

    // Save refreshed tokens
    saveToken(channel, mcpSlug, newTokens, mcpUrl);
    console.log(`[oauth] Token refreshed for ${channel}/${mcpSlug}`);

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
 * MCP configuration with resolved values.
 */
export interface ResolvedMcpConfig {
  /** Server name for tool namespacing (e.g., 'filesystem' -> mcp__filesystem__read_file) */
  name: string;
  /** MCP server artifact slug (optional, for board-defined servers) */
  slug?: string;
  transport: "stdio" | "sse" | "http";
  // stdio fields
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  // sse/http fields
  url?: string;
  headers?: Record<string, string>;
  /** Whether this MCP uses OAuth (for logging/debugging) */
  usesOAuth?: boolean;
}

/**
 * MCP reference for resolution.
 */
export interface McpReference {
  slug: string;
}

/**
 * Function type for resolving MCP artifacts.
 */
export type McpArtifactResolver = (
  channel: string,
  slug: string
) => {
  props?: {
    transport?: "stdio" | "sse" | "http";
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    url?: string;
    headers?: Record<string, string>;
    auth?: OAuthConfig;
  };
} | null;

/**
 * Resolve MCP configs with OAuth token injection.
 *
 * This is an async function that handles OAuth token retrieval and refresh
 * for HTTP MCP servers.
 *
 * @param channel - The channel to resolve MCPs for
 * @param mcpRefs - Array of MCP references to resolve
 * @param resolveMcp - Function to resolve MCP artifact from slug
 * @returns Resolved configs with OAuth tokens injected
 */
export async function resolveMcpConfigsWithOAuth(
  channel: string,
  mcpRefs: McpReference[],
  resolveMcp: McpArtifactResolver
): Promise<ResolvedMcpConfig[]> {
  const configs: ResolvedMcpConfig[] = [];

  for (const ref of mcpRefs) {
    const artifact = resolveMcp(channel, ref.slug);
    if (!artifact) {
      console.error(
        `[oauth] MCP not found: ${ref.slug} (checked ${channel})`
      );
      continue;
    }

    const props = artifact.props;
    if (!props) {
      console.error(`[oauth] MCP ${ref.slug} has no props`);
      continue;
    }

    const transport = props.transport ?? "stdio";
    const auth = props.auth;

    // Use slug as name for tool namespacing
    const config: ResolvedMcpConfig = {
      name: ref.slug,
      slug: ref.slug,
      transport,
    };

    if (transport === "stdio") {
      // Stdio transport - resolve env vars
      config.command = props.command;
      config.args = props.args;
      config.cwd = props.cwd;
      if (props.env) {
        config.env = resolveEnvVars(props.env);
      }
    } else if (transport === "sse" || transport === "http") {
      // SSE and HTTP both use URL-based connections
      config.url = props.url;

      // Start with any static headers
      if (props.headers) {
        config.headers = resolveEnvVars(props.headers);
      }

      // Handle OAuth authentication
      if (auth?.type === "oauth" && config.url) {
        config.usesOAuth = true;

        const token = await getValidOAuthToken(
          channel,
          ref.slug,
          config.url,
          auth
        );

        if (token) {
          config.headers = {
            ...config.headers,
            Authorization: `Bearer ${token}`,
          };
          console.log(`[oauth] Injected OAuth token for ${ref.slug}`);
        } else {
          // No valid token - skip this MCP
          console.warn(
            `[oauth] Skipping MCP ${ref.slug} - no valid OAuth token`
          );
          continue;
        }
      }
    }

    configs.push(config);
  }

  return configs;
}

/**
 * Resolve ${VAR_NAME} references in env vars.
 */
function resolveEnvVars(obj: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const envValue = process.env[varName];
      if (envValue === undefined) {
        console.warn(
          `[oauth] Warning: env var ${varName} not found, leaving as ${match}`
        );
        return match;
      }
      return envValue;
    });
  }
  return result;
}

/**
 * Get authenticated headers for an MCP HTTP request.
 *
 * @param channel - The channel containing the MCP
 * @param mcpSlug - The MCP slug
 * @param mcpUrl - The MCP server URL
 * @param authConfig - OAuth configuration
 * @returns Headers with Authorization if token available
 */
export async function getAuthenticatedHeaders(
  channel: string,
  mcpSlug: string,
  mcpUrl: string,
  authConfig: OAuthConfig
): Promise<Record<string, string>> {
  const token = await getValidOAuthToken(channel, mcpSlug, mcpUrl, authConfig);

  if (token) {
    return { Authorization: `Bearer ${token}` };
  }

  return {};
}
