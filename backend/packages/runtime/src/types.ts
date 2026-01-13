/**
 * @cast/runtime - Agent runtime types
 *
 * Types shared across runtime implementations (Docker, Fly.io, etc.)
 * Aligned with container-spec-3 protocol v3.0
 */

// =============================================================================
// Agent Status
// =============================================================================

export type AgentStatus = 'offline' | 'activating' | 'online' | 'busy' | 'suspending' | 'error';

// =============================================================================
// Runtime Type
// =============================================================================

export type RuntimeType = 'docker' | 'fly' | 'local' | 'mock';

// =============================================================================
// Container Info
// =============================================================================

export interface ContainerInfo {
  /** Runtime-specific container identifier (Docker container ID, Fly machine ID) */
  containerId: string;
  /** Runtime type */
  runtime: RuntimeType;
}

// =============================================================================
// Agent Runtime State
// =============================================================================

export interface AgentRuntimeState {
  /** Agent identity in canonical format: {spaceId}:{channelId}:{callsign} */
  agentId: string;
  /** Container info (null if offline) */
  container: ContainerInfo | null;
  /** Port the container is listening on (for Docker) */
  port: number | null;
  /** Current agent status */
  status: AgentStatus;
  /** Callback URL where container is reachable (null if not online) */
  endpoint: string | null;
  /** Routing hints to echo as HTTP headers (null if not needed) */
  routeHints: Record<string, string> | null;
  /** Activation timestamp (ISO 8601), null if never activated */
  activatedAt: string | null;
  /** Last activity timestamp (ISO 8601) */
  lastActivity: string;
}

// =============================================================================
// Activate Options
// =============================================================================

export interface ActivateOptions {
  /** Agent identity in canonical format: {spaceId}:{channelId}:{callsign} */
  agentId: string;
  /** Auth token for container to use when calling back to API */
  authToken: string;
  /** System prompt for the agent */
  systemPrompt?: string;
  /** MCP server configurations to pass to container */
  mcpServers?: McpServerConfig[];
  /**
   * Tunnel hash for HTTP tunnel access.
   * Used as subdomain: {tunnelHash}.containers.domain.com
   */
  tunnelHash?: string;
  /**
   * Tunnel server URL for HTTP tunnel registration and access.
   * e.g., "https://tunnel.clanker.is"
   */
  tunnelServerUrl?: string;
}

// =============================================================================
// Agent Message
// =============================================================================

export interface AgentMessage {
  /** Message content */
  content: string;
  /** Optional system prompt override */
  systemPrompt?: string;
}

// =============================================================================
// MCP Server Config
// =============================================================================

export interface McpServerConfig {
  /** Server name for tool namespacing (e.g., 'filesystem' -> mcp__filesystem__read_file) */
  name: string;
  /** MCP server artifact slug (optional, for board-defined servers) */
  slug?: string;
  /** Transport type */
  transport: 'stdio' | 'sse' | 'http';
  /** Command to run (for stdio) */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** URL (for sse/http) */
  url?: string;
  /** HTTP headers */
  headers?: Record<string, string>;
}

// =============================================================================
// Agent Runtime Interface
// =============================================================================

/**
 * Agent runtime interface.
 * Implementations: DockerRuntime (local), FlyRuntime (Fly.io)
 */
export interface AgentRuntime {
  /**
   * Activate an agent by starting its container.
   * Idempotent: returns current state if already activating/online.
   * Fire-and-forget: returns immediately with 'activating' status.
   * Container calls /agents/checkin when ready.
   */
  activate(options: ActivateOptions): Promise<AgentRuntimeState>;

  /**
   * Send a message to an online agent's container.
   * Throws if agent is not online.
   */
  sendMessage(agentId: string, message: AgentMessage): Promise<void>;

  /**
   * Suspend an agent by stopping its container.
   * Idempotent: no-op if already offline/suspending.
   */
  suspend(agentId: string, reason?: string): Promise<void>;

  /**
   * Get current runtime state for an agent.
   * Returns null if agent has no runtime state (never activated in this runtime).
   */
  getState(agentId: string): AgentRuntimeState | null;

  /**
   * Check if an agent is currently online.
   */
  isOnline(agentId: string): boolean;

  /**
   * Get all currently online agents.
   */
  getAllOnline(): AgentRuntimeState[];

  /**
   * Graceful shutdown - suspend all agents.
   */
  shutdown(): Promise<void>;
}

// =============================================================================
// Runtime Events
// =============================================================================

export type RuntimeEvent =
  | { type: 'agent_activating'; agentId: string }
  | { type: 'agent_online'; agentId: string; endpoint: string }
  | { type: 'agent_offline'; agentId: string; reason: string }
  | { type: 'agent_error'; agentId: string; error: string };

export type RuntimeEventHandler = (event: RuntimeEvent) => void | Promise<void>;

// =============================================================================
// Identity Utilities
// =============================================================================

export interface AgentId {
  spaceId: string;
  channelId: string;
  callsign: string;
}

export function formatAgentId(id: AgentId): string {
  return `${id.spaceId}:${id.channelId}:${id.callsign}`;
}

export function parseAgentId(agentId: string): AgentId {
  const [spaceId, channelId, callsign] = agentId.split(':');
  if (!spaceId || !channelId || !callsign) {
    throw new Error(`Invalid agentId format: ${agentId}`);
  }
  return { spaceId, channelId, callsign };
}

export function validateAgentId(agentId: string): boolean {
  try {
    parseAgentId(agentId);
    return true;
  } catch {
    return false;
  }
}
