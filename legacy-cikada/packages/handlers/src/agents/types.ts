/**
 * Agent Resolution Types
 *
 * Type definitions for resolving agent definitions and MCP server configurations
 * from system artifacts. These types are platform-agnostic.
 */

/**
 * Resolved agent definition from system.agent artifact
 */
export interface ResolvedAgentDefinition {
  slug: string;
  name: string;
  content: string; // System prompt
  engine?: string;
  model?: string;
  agentName?: string; // Fixed callsign
  mcp?: Array<{ slug: string }>; // MCP server references
}

/**
 * Resolved MCP server configuration
 */
export interface ResolvedMcpConfig {
  /** Server name for tool namespacing (e.g., 'filesystem' -> mcp__filesystem__read_file) */
  name: string;
  /** MCP server artifact slug (optional, for board-defined servers) */
  slug?: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  capabilities?: string;
}

/**
 * Minimal artifact interface for agent resolution.
 * This is the subset of artifact data needed by resolution functions.
 */
export interface ArtifactData {
  slug: string;
  type: string;
  title?: string;
  content: string;
  props?: Record<string, unknown>;
}

/**
 * Artifact reader interface - abstracts storage access.
 * Both sync (SQLite) and async (DynamoDB) implementations can satisfy this.
 */
export interface ArtifactReader {
  /**
   * Read an artifact by channel and slug.
   * Returns null/undefined if not found.
   */
  read(channelId: string, slug: string): ArtifactData | null | undefined | Promise<ArtifactData | null | undefined>;
}

/**
 * Props shape for system.agent artifacts
 */
export interface AgentProps {
  engine?: string;
  model?: string;
  agentName?: string;
  mcp?: Array<{ slug: string }>;
}

/**
 * Props shape for system.mcp artifacts
 */
export interface McpProps {
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  capabilities?: string;
}
