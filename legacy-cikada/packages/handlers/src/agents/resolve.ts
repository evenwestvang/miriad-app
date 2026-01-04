/**
 * Agent Resolution Functions
 *
 * Platform-agnostic functions for resolving agent definitions and MCP server
 * configurations from system artifacts.
 *
 * Resolution order:
 * 1. Channel-local artifacts (channel-specific overrides)
 * 2. Root channel artifacts (space-wide defaults)
 */

import type {
  ArtifactReader,
  ArtifactData,
  ResolvedAgentDefinition,
  ResolvedMcpConfig,
  AgentProps,
  McpProps,
} from './types.js';

// =============================================================================
// Environment Variable Resolution
// =============================================================================

/**
 * Default values for common env vars.
 * Can be overridden via options or process.env.
 */
const ENV_DEFAULTS: Record<string, string> = {
  CIKADA_API_URL: 'http://localhost:3001',
};

export interface EnvResolverOptions {
  /** Additional env var defaults (merged with built-in defaults) */
  envDefaults?: Record<string, string>;
  /** Custom env var lookup (defaults to process.env) */
  getEnv?: (name: string) => string | undefined;
}

/**
 * Resolve environment variable placeholders in a value.
 * Supports ${VAR_NAME} syntax. Falls back to defaults for known vars.
 */
export function resolveEnvVars(value: string, options?: EnvResolverOptions): string {
  const defaults = { ...ENV_DEFAULTS, ...options?.envDefaults };
  const getEnv = options?.getEnv ?? ((name: string) => process.env[name]);

  return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
    return getEnv(varName) || defaults[varName] || match;
  });
}

/**
 * Resolve environment variable placeholders in a record.
 */
export function resolveEnvVarsInRecord(
  record: Record<string, string>,
  options?: EnvResolverOptions
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = resolveEnvVars(value, options);
  }
  return result;
}

/**
 * Resolve channel and env placeholders in a URL.
 * Supports ${ENV_VAR} for environment variables and {channelId} for the current channel.
 */
export function resolveUrlPlaceholders(
  url: string,
  channelId: string,
  options?: EnvResolverOptions
): string {
  return resolveEnvVars(url, options).replace(/\{channelId\}/g, channelId);
}

// =============================================================================
// Agent Definition Resolution
// =============================================================================

export interface ResolveAgentOptions extends EnvResolverOptions {
  /** Root channel ID for fallback lookups */
  rootChannelId?: string;
}

/**
 * Helper to await a potentially async artifact read
 */
async function readArtifact(
  reader: ArtifactReader,
  channelId: string,
  slug: string
): Promise<ArtifactData | null | undefined> {
  const result = reader.read(channelId, slug);
  return result instanceof Promise ? await result : result;
}

/**
 * Resolve an agent definition by slug.
 * Looks first in the specified channel, then falls back to the root channel.
 *
 * @param reader The artifact reader instance
 * @param channelId The channel to check first
 * @param agentSlug The agent definition slug
 * @param options Resolution options including rootChannelId for fallback
 * @returns The resolved agent definition, or undefined if not found
 */
export async function resolveAgentDefinition(
  reader: ArtifactReader,
  channelId: string,
  agentSlug: string,
  options?: ResolveAgentOptions
): Promise<ResolvedAgentDefinition | undefined> {
  // Try channel-local first
  let artifact = await readArtifact(reader, channelId, agentSlug);

  // Fall back to root channel if not found or wrong type
  if (!artifact || artifact.type !== 'system.agent') {
    if (options?.rootChannelId) {
      artifact = await readArtifact(reader, options.rootChannelId, agentSlug);
    }
  }

  // If still not found or wrong type, return undefined
  if (!artifact || artifact.type !== 'system.agent') {
    return undefined;
  }

  // Extract props
  const props = artifact.props as AgentProps | undefined;

  return {
    slug: artifact.slug,
    name: artifact.title || artifact.slug,
    content: artifact.content,
    engine: props?.engine,
    model: props?.model,
    agentName: props?.agentName,
    mcp: props?.mcp,
  };
}

// =============================================================================
// MCP Server Configuration Resolution
// =============================================================================

/**
 * Resolve an MCP server configuration by slug.
 * Looks first in the specified channel, then falls back to the root channel.
 *
 * @param reader The artifact reader instance
 * @param channelId The channel to check first (also used for URL placeholder resolution)
 * @param mcpSlug The MCP server artifact slug
 * @param options Resolution options including rootChannelId for fallback
 * @returns The resolved MCP config, or undefined if not found
 */
export async function resolveMcpConfig(
  reader: ArtifactReader,
  channelId: string,
  mcpSlug: string,
  options?: ResolveAgentOptions
): Promise<ResolvedMcpConfig | undefined> {
  // Try channel-local first
  let artifact = await readArtifact(reader, channelId, mcpSlug);

  // Fall back to root channel if not found or wrong type
  if (!artifact || artifact.type !== 'system.mcp') {
    if (options?.rootChannelId) {
      artifact = await readArtifact(reader, options.rootChannelId, mcpSlug);
    }
  }

  // If still not found or wrong type, return undefined
  if (!artifact || artifact.type !== 'system.mcp') {
    return undefined;
  }

  // Extract props
  const props = artifact.props as McpProps | undefined;

  if (!props) {
    return undefined;
  }

  // Build resolved config with env var substitution
  // Use slug as the name for tool namespacing (e.g., 'cikada-mcp' -> mcp__cikada-mcp__send_message)
  const resolved: ResolvedMcpConfig = {
    name: artifact.slug,
    slug: artifact.slug,
    transport: props.transport,
    capabilities: props.capabilities,
  };

  if (props.transport === 'stdio') {
    if (props.command) resolved.command = props.command;
    if (props.args) resolved.args = props.args;
    if (props.env) resolved.env = resolveEnvVarsInRecord(props.env, options);
    if (props.cwd) resolved.cwd = props.cwd;
  } else if (props.transport === 'sse' || props.transport === 'http') {
    // SSE and HTTP both use URL-based connections
    // Supports {channelId} placeholder for per-channel MCP endpoints
    if (props.url) resolved.url = resolveUrlPlaceholders(props.url, channelId, options);
    if (props.headers) resolved.headers = resolveEnvVarsInRecord(props.headers, options);
  }

  return resolved;
}

/**
 * Resolve all MCP server configurations for an agent.
 *
 * @param reader The artifact reader instance
 * @param channelId The channel context
 * @param mcpRefs Array of MCP references from system.agent props
 * @param options Resolution options including rootChannelId for fallback
 * @returns Array of resolved MCP configs
 */
export async function resolveMcpConfigs(
  reader: ArtifactReader,
  channelId: string,
  mcpRefs: Array<{ slug: string }>,
  options?: ResolveAgentOptions
): Promise<ResolvedMcpConfig[]> {
  const resolved: ResolvedMcpConfig[] = [];

  for (const ref of mcpRefs) {
    const config = await resolveMcpConfig(reader, channelId, ref.slug, options);
    if (config) {
      resolved.push(config);
    }
  }

  return resolved;
}
