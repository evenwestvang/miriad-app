/**
 * MCP Config Converter
 *
 * Converts resolved MCP configs to Claude Code's expected format.
 */

import type {
  ResolvedMcpConfig,
  McpServerConfig,
  McpConfigFile,
} from "./types.js";

/**
 * Convert a ResolvedMcpConfig to Claude Code's McpServerConfig format.
 *
 * @param resolved - Resolved MCP config from the registry
 * @returns Config in Claude Code format
 */
export function convertToMcpServerConfig(resolved: ResolvedMcpConfig): McpServerConfig {
  if (resolved.transport === "stdio") {
    return {
      type: "stdio",
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd,
    };
  } else {
    return {
      type: "http",
      url: resolved.url,
      headers: resolved.headers,
    };
  }
}

/**
 * Build a full MCP config file from resolved configs.
 * Converts all resolved configs and combines into a single object.
 *
 * @param resolved - Array of resolved MCP configs
 * @param builtIn - Optional built-in MCP servers to include (e.g., cikada-tools)
 * @returns Complete MCP config file for Claude Code
 */
export function buildMcpConfigFile(
  resolved: ResolvedMcpConfig[],
  builtIn?: Record<string, McpServerConfig>
): McpConfigFile {
  const mcpServers: Record<string, McpServerConfig> = {};

  // Add built-in MCPs first
  if (builtIn) {
    Object.assign(mcpServers, builtIn);
  }

  // Add resolved external MCPs
  for (const config of resolved) {
    mcpServers[config.slug] = convertToMcpServerConfig(config);
  }

  return { mcpServers };
}

/**
 * Serialize MCP config to JSON string.
 * Convenience method for writing to file.
 *
 * @param config - MCP config file object
 * @returns Pretty-printed JSON string
 */
export function serializeMcpConfig(config: McpConfigFile): string {
  return JSON.stringify(config, null, 2);
}
