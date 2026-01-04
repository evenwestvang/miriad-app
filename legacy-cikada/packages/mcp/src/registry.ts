/**
 * MCP Registry
 *
 * Resolves MCP references to full configurations.
 * Handles channel-first lookup with #root fallback.
 */

import { resolveEnvVars } from "./env.js";
import type {
  McpReference,
  McpArtifact,
  McpStorage,
  ResolvedMcpConfig,
  SystemMcpProps,
} from "./types.js";

/** Root channel name for global MCP definitions */
const ROOT_CHANNEL = "root";

/**
 * Get an artifact with fallback to #root channel.
 * Looks in the specified channel first, then falls back to #root for system artifacts.
 *
 * @param storage - Storage adapter for artifact lookup
 * @param channel - Primary channel to search
 * @param slug - Artifact slug to find
 * @returns The artifact if found, null otherwise
 */
export async function getArtifactWithFallback(
  storage: McpStorage,
  channel: string,
  slug: string
): Promise<McpArtifact | null> {
  // First try the local channel
  const local = await storage.getArtifact(channel, slug);
  if (local) {
    return local;
  }

  // Fall back to #root for system artifacts
  if (channel !== ROOT_CHANNEL) {
    const root = await storage.getArtifact(ROOT_CHANNEL, slug);
    if (root) {
      return root;
    }
  }

  return null;
}

/**
 * Resolve a system.mcp artifact for an agent.
 * Looks in channel first, then falls back to #root.
 *
 * @param storage - Storage adapter for artifact lookup
 * @param channel - Channel to search (falls back to root)
 * @param mcpSlug - Slug of the system.mcp artifact
 * @returns The MCP artifact if found and valid type, null otherwise
 */
export async function resolveMcpForAgent(
  storage: McpStorage,
  channel: string,
  mcpSlug: string
): Promise<McpArtifact | null> {
  const artifact = await getArtifactWithFallback(storage, channel, mcpSlug);

  if (!artifact) {
    console.error(`[mcp] MCP not found: ${mcpSlug} (checked ${channel} and root)`);
    return null;
  }

  if (artifact.type !== "system.mcp") {
    console.error(`[mcp] Artifact ${mcpSlug} is not a system.mcp (type: ${artifact.type})`);
    return null;
  }

  return artifact;
}

/**
 * Build a ResolvedMcpConfig from a system.mcp artifact.
 * Extracts props and resolves environment variables.
 *
 * @param artifact - The system.mcp artifact
 * @returns Resolved config with env vars substituted
 */
export function buildResolvedConfig(artifact: McpArtifact): ResolvedMcpConfig {
  const props = (artifact.props || {}) as unknown as SystemMcpProps;
  const transport = props.transport ?? "stdio";

  const config: ResolvedMcpConfig = {
    slug: artifact.slug,
    transport,
  };

  if (transport === "stdio") {
    // stdio transport
    config.command = props.command;
    config.args = props.args;
    config.cwd = props.cwd;

    // Resolve env vars
    if (props.env) {
      config.env = resolveEnvVars(props.env);
    }
  } else if (transport === "http") {
    // http transport
    config.url = props.url;

    // Resolve headers
    if (props.headers) {
      config.headers = resolveEnvVars(props.headers);
    }
  }

  return config;
}

/**
 * Resolve all MCP configs for an agent.
 * Returns configs with env vars resolved to actual values.
 *
 * @param storage - Storage adapter for artifact lookup
 * @param channel - Channel to resolve MCPs for
 * @param mcpRefs - Array of MCP references to resolve
 * @returns Array of resolved configs (skips missing MCPs)
 */
export async function resolveMcpConfigs(
  storage: McpStorage,
  channel: string,
  mcpRefs: McpReference[]
): Promise<ResolvedMcpConfig[]> {
  const configs: ResolvedMcpConfig[] = [];

  for (const ref of mcpRefs) {
    const artifact = await resolveMcpForAgent(storage, channel, ref.slug);
    if (!artifact) {
      // Already logged in resolveMcpForAgent
      continue;
    }

    const config = buildResolvedConfig(artifact);
    configs.push(config);
  }

  return configs;
}
