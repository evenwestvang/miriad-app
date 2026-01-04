/**
 * @cikada/mcp
 *
 * MCP tool configuration, resolution, and registry for Cikada agents.
 *
 * Usage:
 * ```typescript
 * import { resolveMcpConfigs, buildMcpConfigFile } from '@cikada/mcp';
 *
 * // Resolve MCP references from agent props
 * const resolved = await resolveMcpConfigs(storage, channel, mcpRefs);
 *
 * // Build config file for Claude Code
 * const config = buildMcpConfigFile(resolved, { 'cikada-tools': {...} });
 * ```
 */

// Types
export type {
  McpReference,
  OAuthConfig,
  SystemMcpProps,
  ResolvedMcpConfig,
  McpServerConfig,
  McpConfigFile,
  McpArtifact,
  McpStorage,
} from "./types.js";

// Environment variable resolution
export {
  resolveEnvVars,
  resolveEnvVarString,
  hasEnvVarRefs,
  extractEnvVarNames,
} from "./env.js";

// Registry (artifact lookup and resolution)
export {
  getArtifactWithFallback,
  resolveMcpForAgent,
  resolveMcpConfigs,
  buildResolvedConfig,
} from "./registry.js";

// Converter (to Claude Code format)
export {
  convertToMcpServerConfig,
  buildMcpConfigFile,
  serializeMcpConfig,
} from "./converter.js";
