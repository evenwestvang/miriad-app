/**
 * @cast/runtime - Container orchestration types
 *
 * Types shared across orchestrator implementations (Docker, Fargate, etc.)
 */

// =============================================================================
// Container Status
// =============================================================================

export type ContainerStatus = 'starting' | 'running' | 'stopping' | 'stopped' | 'error';

// =============================================================================
// Container State
// =============================================================================

export interface ContainerState {
  /** Unique identifier for the agent thread (spaceId:channelId:callsign) */
  threadId: string;
  /** Docker/Fargate container ID */
  containerId: string;
  /** Port the container is listening on */
  port: number;
  /** Current container status */
  status: ContainerStatus;
  /** Last activity timestamp (ISO 8601) */
  lastActivity: string;
  /** Creation timestamp (ISO 8601) */
  createdAt: string;
}

// =============================================================================
// Spawn Options
// =============================================================================

export interface ContainerSpawnOptions {
  /** Space ID for workspace isolation */
  spaceId: string;
  /** Channel ID */
  channelId: string;
  /** Agent callsign */
  callsign: string;
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
// Orchestrator Interface
// =============================================================================

/**
 * Container orchestrator interface.
 * Implementations: DockerOrchestrator (local), FargateOrchestrator (AWS)
 */
export interface ContainerOrchestrator {
  /**
   * Spawn a new container for an agent.
   * Returns the container state once ready.
   */
  spawn(options: ContainerSpawnOptions): Promise<ContainerState>;

  /**
   * Send a message to a running container.
   * Throws if container is not running.
   */
  sendMessage(threadId: string, content: string, systemPrompt?: string): Promise<void>;

  /**
   * Stop a container.
   */
  stop(threadId: string, reason?: string): Promise<void>;

  /**
   * Get container status for a thread.
   * Returns null if no container exists.
   */
  getStatus(threadId: string): ContainerState | null;

  /**
   * Check if a container is running.
   */
  isRunning(threadId: string): boolean;

  /**
   * Get all running containers.
   */
  getAllRunning(): ContainerState[];

  /**
   * Graceful shutdown - stop all containers.
   */
  shutdown(): Promise<void>;
}

// =============================================================================
// Orchestrator Events
// =============================================================================

export type OrchestratorEvent =
  | { type: 'container_starting'; threadId: string }
  | { type: 'container_ready'; threadId: string; port: number }
  | { type: 'container_stopped'; threadId: string; reason: string }
  | { type: 'container_error'; threadId: string; error: string };

export type OrchestratorEventHandler = (event: OrchestratorEvent) => void | Promise<void>;
