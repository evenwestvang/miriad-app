/**
 * Agent Provider Interface
 *
 * Defines the abstraction layer for coding agent providers (Claude, Codex, future engines).
 * Providers implement this interface to enable multi-engine support in PowPow.
 *
 * Key design decisions:
 * - `engine` is string (not enum) for future extensibility
 * - `reasoning` output type supports extended thinking (Codex)
 * - ProviderCapabilities flags for behavioral differences
 * - Message queue pattern for providers without mid-turn injection
 */

/**
 * Configuration for spawning an agent.
 * Provider-agnostic configuration passed to spawn().
 */
export interface AgentConfig {
  /** Model identifier (provider-specific, e.g., "claude-opus-4-5-20251101", "gpt-5.1-codex-max") */
  model?: string;

  /** Custom system prompt to append to the base prompt */
  systemPrompt?: string;

  /** Working directory for the agent */
  workdir: string;

  /** MCP server configuration */
  mcpServers?: Record<string, MCPServerConfig>;

  /** Permission mode for tool execution */
  permissions?: PermissionMode;

  /** Whether to attempt resuming an existing session */
  resume?: boolean;
}

/**
 * MCP server configuration.
 * Supports both STDIO (local subprocess) and HTTP/SSE (remote) transports.
 */
export interface MCPServerConfig {
  /** Transport type */
  type: "stdio" | "sse" | "http";

  /** For STDIO: command to spawn */
  command?: string;

  /** For STDIO: command arguments */
  args?: string[];

  /** For STDIO: environment variables (already resolved from ${VAR} references) */
  env?: Record<string, string>;

  /** For STDIO: working directory */
  cwd?: string;

  /** For HTTP/SSE: server URL */
  url?: string;

  /** Optional auth token environment variable */
  bearerTokenEnvVar?: string;

  /** Optional custom headers (already resolved from ${VAR} references) */
  headers?: Record<string, string>;
}

/** Permission mode for tool execution */
export type PermissionMode = "bypassPermissions" | "requirePermissions";

/**
 * Handle to a spawned agent.
 * Returned by spawn() and used for subsequent operations.
 */
export interface AgentHandle {
  /** Unique identifier for this agent instance */
  id: string;

  /** Channel the agent is participating in */
  channel: string;

  /** Agent's callsign/name */
  name: string;

  /** Engine type (e.g., "claude", "codex") - extensible string, not enum */
  engine: string;

  /** Session ID for this agent's conversation */
  sessionId?: string;
}

/**
 * Unified agent state machine.
 * All providers map their internal states to these values.
 *
 * State transitions:
 * starting -> idle <-> thinking <-> tool_running -> stopped
 *                                              |
 *                                              v
 *                                            error
 */
export type AgentState =
  | "starting"      // Agent is initializing
  | "idle"          // Waiting for input
  | "thinking"      // Processing/generating response
  | "tool_running"  // Executing a tool
  | "stopped"       // Gracefully terminated
  | "error";        // Error state

/**
 * Unified output format for agent events.
 * All providers map their events to this structure.
 */
export interface AgentOutput {
  /** Output type */
  type: AgentOutputType;

  /** ISO timestamp of the output */
  timestamp: string;

  /** Main content (text, error message, etc.) */
  content: string;

  /** For tool_call: name of the tool */
  toolName?: string;

  /** For tool_call: input parameters */
  toolInput?: unknown;

  /** For tool_result: result of the tool execution */
  toolResult?: unknown;

  /** For tool_call: execution time in seconds */
  elapsedTime?: number;

  /** Provider-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Output types for AgentOutput.
 *
 * Mapping from providers:
 * - text: agent response text (Claude: assistant+text, Codex: agent_message)
 * - tool_call: tool invocation (Claude: assistant+tool_use, Codex: command_execution/mcp_tool_call)
 * - tool_result: tool execution result
 * - error: error events (Claude: result+error, Codex: turn.failed)
 * - system: lifecycle events (init, turn complete, etc.)
 * - reasoning: extended thinking traces (Codex-specific, surfaced for transparency)
 */
export type AgentOutputType =
  | "text"
  | "tool_call"
  | "tool_result"
  | "error"
  | "system"
  | "reasoning";

/**
 * Provider capability flags.
 * Used to handle behavioral differences between providers.
 */
export interface ProviderCapabilities {
  /**
   * Whether the provider supports injecting messages while a turn is active.
   * - Claude: true (Pushable pattern allows mid-turn injection)
   * - Codex: false (messages queued until turn completes)
   */
  supportsMidTurnMessages: boolean;

  /**
   * Whether the provider supports interrupting/cancelling an active turn.
   * - Claude: true
   * - Codex: true (via thread.cancel())
   */
  supportsInterruption: boolean;

  /**
   * Whether the provider exposes reasoning/thinking traces.
   * - Claude: false (extended thinking not exposed in SDK)
   * - Codex: true (reasoning events)
   */
  exposesReasoning: boolean;

  /**
   * Whether the provider supports session resume.
   * - Claude: true (via .claude folder)
   * - Codex: true (via ~/.codex/sessions)
   */
  supportsSessionResume: boolean;
}

/**
 * Callback for agent output events.
 */
export type OutputCallback = (output: AgentOutput) => void;

/**
 * Callback for agent state changes.
 */
export type StateChangeCallback = (state: AgentState, previousState?: AgentState) => void;

/**
 * Main provider interface.
 * Implementations wrap provider-specific SDKs (claude-agent-sdk, codex-sdk).
 *
 * Lifecycle:
 * 1. spawn() creates a new agent or resumes an existing session
 * 2. sendMessage() sends user messages (may queue if mid-turn)
 * 3. onOutput()/onStateChange() register callbacks for events
 * 4. kick() terminates the agent
 *
 * Session management:
 * - canResume() checks if a previous session exists
 * - Providers handle session persistence internally
 */
export interface CodingAgentProvider {
  /** Provider name (e.g., "claude", "codex") - extensible */
  readonly name: string;

  /** Provider capabilities for handling behavioral differences */
  readonly capabilities: ProviderCapabilities;

  /**
   * Spawn a new agent or resume an existing session.
   *
   * @param channel - Channel the agent will participate in
   * @param name - Agent's callsign
   * @param config - Spawn configuration
   * @returns Handle to the spawned agent
   */
  spawn(channel: string, name: string, config: AgentConfig): Promise<AgentHandle>;

  /**
   * Send a message to the agent.
   *
   * If the provider doesn't support mid-turn messages (capabilities.supportsMidTurnMessages === false)
   * and a turn is active, the message will be queued and delivered when the turn completes.
   *
   * @param handle - Agent handle from spawn()
   * @param content - Message content
   */
  sendMessage(handle: AgentHandle, content: string): Promise<void>;

  /**
   * Terminate the agent.
   *
   * @param handle - Agent handle from spawn()
   */
  kick(handle: AgentHandle): Promise<void>;

  /**
   * Get the count of messages waiting to be delivered.
   * Only relevant for providers without mid-turn message support.
   *
   * @param handle - Agent handle from spawn()
   * @returns Number of queued messages
   */
  getPendingMessageCount(handle: AgentHandle): number;

  /**
   * Register a callback for agent output events.
   *
   * @param handle - Agent handle from spawn()
   * @param callback - Function called for each output event
   */
  onOutput(handle: AgentHandle, callback: OutputCallback): void;

  /**
   * Register a callback for agent state changes.
   *
   * @param handle - Agent handle from spawn()
   * @param callback - Function called on state transitions
   */
  onStateChange(handle: AgentHandle, callback: StateChangeCallback): void;

  /**
   * Check if a previous session can be resumed.
   *
   * @param channel - Channel name
   * @param name - Agent name
   * @returns True if a resumable session exists
   */
  canResume(channel: string, name: string): Promise<boolean>;

  /**
   * Get the current state of an agent.
   *
   * @param handle - Agent handle from spawn()
   * @returns Current agent state
   */
  getState(handle: AgentHandle): AgentState;

  /**
   * Get the agent's working directory.
   *
   * @param handle - Agent handle from spawn()
   * @returns Working directory path
   */
  getWorkdir(handle: AgentHandle): string;
}

/**
 * Error thrown by providers with normalized structure.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    /** Error code for categorization */
    public readonly code: ProviderErrorCode,
    /** Whether the operation can be retried */
    public readonly retryable: boolean,
    /** Provider that threw the error */
    public readonly provider: string,
    /** Original error for debugging */
    public readonly cause?: unknown
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/**
 * Normalized error codes across providers.
 */
export type ProviderErrorCode =
  | "rate_limit"      // Rate limit exceeded (usually retryable)
  | "auth_error"      // Authentication failed (not retryable)
  | "timeout"         // Operation timed out (may be retryable)
  | "network_error"   // Network connectivity issue (may be retryable)
  | "invalid_config"  // Invalid configuration (not retryable)
  | "session_error"   // Session management error
  | "tool_error"      // Tool execution error
  | "unknown";        // Uncategorized error
