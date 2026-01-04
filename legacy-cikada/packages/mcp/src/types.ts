/**
 * MCP Configuration Types
 *
 * Types for MCP server configuration, references, and resolution.
 */

// =============================================================================
// MCP Reference (stored in system.agent props.mcp)
// =============================================================================

/**
 * Reference to a system.mcp artifact.
 * Used in system.agent props.mcp array to declare which MCPs an agent can use.
 */
export interface McpReference {
  /** Slug of the system.mcp artifact */
  slug: string;
}

// =============================================================================
// System MCP Artifact Props
// =============================================================================

/**
 * OAuth configuration for HTTP transport MCPs.
 */
export interface OAuthConfig {
  type: "oauth";
  /** Authorization endpoint URL (auto-discovered if not set) */
  authorizationEndpoint?: string;
  /** Token endpoint URL (auto-discovered if not set) */
  tokenEndpoint?: string;
  /** OAuth client ID (uses default if not set) */
  clientId?: string;
  /** OAuth scopes to request */
  scopes?: string[];
}

/**
 * Props schema for system.mcp artifacts.
 * Defines how an MCP server is configured and launched.
 */
export interface SystemMcpProps {
  /** Transport type for the MCP server */
  transport: "stdio" | "http";

  /** Human-readable description of what this MCP server provides */
  capabilities?: string;

  // stdio transport options
  /** Command to execute for stdio transport (e.g., 'npx', 'node') */
  command?: string;
  /** Arguments to pass to the command */
  args?: string[];
  /** Environment variables. Use ${VAR_NAME} syntax to reference server env vars */
  env?: Record<string, string>;
  /** Working directory for the command */
  cwd?: string;

  // http transport options
  /** URL for HTTP transport MCP server */
  url?: string;
  /** HTTP headers. Use ${VAR_NAME} syntax to reference server env vars */
  headers?: Record<string, string>;
  /** OAuth 2.1 authentication config (HTTP transport only) */
  auth?: OAuthConfig;
}

// =============================================================================
// Resolved MCP Config (ready to pass to engine)
// =============================================================================

/**
 * Resolved MCP server configuration.
 * This is the output of the resolution process, with:
 * - Artifact props extracted
 * - Environment variables resolved
 * - Ready to convert to engine-specific format
 */
export interface ResolvedMcpConfig {
  /** The MCP artifact slug */
  slug: string;
  /** Transport type */
  transport: "stdio" | "http";

  // stdio transport (resolved)
  /** Command to execute */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables with ${VAR} resolved to actual values */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;

  // http transport (resolved)
  /** Server URL */
  url?: string;
  /** HTTP headers with ${VAR} resolved to actual values */
  headers?: Record<string, string>;
}

// =============================================================================
// Claude Code MCP Server Config Format
// =============================================================================

/**
 * MCP server config format expected by Claude Code.
 * This is the final output format for the mcpServers JSON config.
 */
export interface McpServerConfig {
  type: "stdio" | "http";

  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;

  // http
  url?: string;
  headers?: Record<string, string>;
}

/**
 * Full MCP configuration object for Claude Code.
 */
export interface McpConfigFile {
  mcpServers: Record<string, McpServerConfig>;
}

// =============================================================================
// Artifact Interface (minimal for MCP resolution)
// =============================================================================

/**
 * Minimal artifact interface for MCP resolution.
 * This avoids coupling to the full storage artifact type.
 */
export interface McpArtifact {
  slug: string;
  type: string;
  props?: Record<string, unknown>;
}

/**
 * Storage interface for MCP resolution.
 * Requires only the artifact lookup methods needed for resolution.
 */
export interface McpStorage {
  /**
   * Get an artifact by channel and slug.
   */
  getArtifact(channel: string, slug: string): McpArtifact | null | Promise<McpArtifact | null>;
}
