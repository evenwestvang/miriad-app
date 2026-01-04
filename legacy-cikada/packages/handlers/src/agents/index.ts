/**
 * Agent Resolution Module
 *
 * Exports functions for resolving agent definitions and MCP server configurations
 * from system artifacts. Platform-agnostic - works with any storage backend.
 */

export type {
  ResolvedAgentDefinition,
  ResolvedMcpConfig,
  ArtifactData,
  ArtifactReader,
  AgentProps,
  McpProps,
} from './types.js';

export {
  resolveAgentDefinition,
  resolveMcpConfig,
  resolveMcpConfigs,
  resolveEnvVars,
  resolveEnvVarsInRecord,
  resolveUrlPlaceholders,
  type ResolveAgentOptions,
  type EnvResolverOptions,
} from './resolve.js';
