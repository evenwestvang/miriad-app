/**
 * Local Runtime for user's machine
 *
 * Implements AgentRuntime interface for agents running on user's local machine
 * via WebSocket. Unlike DockerRuntime which manages containers directly, LocalRuntime
 * sends commands to a connected local runtime process that manages the agents.
 *
 * Key differences from DockerRuntime:
 * - Uses AgentStateManager for shared state tracking
 * - Routes commands via RuntimeConnectionManager (WS)
 * - Fire-and-forget activate (state transitions via WS messages)
 * - No idle timer management (delegated to local runtime)
 */

import type {
  AgentRuntime,
  ActivateOptions,
  AgentRuntimeState,
  AgentMessage,
  RuntimeEventHandler,
} from './types.js';
import { parseAgentId } from './types.js';
import type { AgentStateManager } from './state.js';
import { generateMessageId } from '@cast/core';

// =============================================================================
// Types
// =============================================================================

/**
 * RuntimeConnectionManager interface (from @cast/server)
 * We define the interface here to avoid circular dependency
 */
export interface RuntimeConnectionManager {
  sendCommand(runtimeId: string, command: BackendToRuntimeMessage): boolean;
  isRuntimeOnline(runtimeId: string): boolean;
}

/**
 * Protocol messages sent to the local runtime
 */
interface ActivateAgentMessage {
  type: 'activate';
  agentId: string;
  systemPrompt: string;
  mcpServers?: McpServerConfig[];
  workspacePath: string;
}

interface DeliverMessageMessage {
  type: 'message';
  agentId: string;
  messageId: string;
  content: string;
  sender: string;
  systemPrompt?: string;
}

interface SuspendAgentMessage {
  type: 'suspend';
  agentId: string;
  reason?: string;
}

type BackendToRuntimeMessage =
  | ActivateAgentMessage
  | DeliverMessageMessage
  | SuspendAgentMessage
  | { type: 'ping'; timestamp: string }
  | { type: 'runtime_connected'; runtimeId: string; protocolVersion: string };

interface McpServerConfig {
  name: string;
  slug?: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

// =============================================================================
// Configuration
// =============================================================================

export interface LocalRuntimeConfig {
  /** Runtime ID (stable identifier from DB) */
  runtimeId: string;
  /** Space this runtime belongs to */
  spaceId: string;
  /** Connection manager for WS transport */
  connectionManager: RuntimeConnectionManager;
  /** State manager for agent state tracking */
  stateManager: AgentStateManager;
  /** Base path for agent workspaces */
  workspaceBasePath?: string;
  /** Event handler for status updates */
  onEvent?: RuntimeEventHandler;
}

// =============================================================================
// Local Runtime
// =============================================================================

export class LocalRuntime implements AgentRuntime {
  readonly runtimeId: string;

  private readonly spaceId: string;
  private readonly connectionManager: RuntimeConnectionManager;
  private readonly stateManager: AgentStateManager;
  private readonly workspaceBasePath: string;
  private readonly onEvent?: RuntimeEventHandler;

  constructor(config: LocalRuntimeConfig) {
    this.runtimeId = config.runtimeId;
    this.spaceId = config.spaceId;
    this.connectionManager = config.connectionManager;
    this.stateManager = config.stateManager;
    this.workspaceBasePath = config.workspaceBasePath ?? '/tmp/cast-agents';
    this.onEvent = config.onEvent;

    console.log(`[LocalRuntime] Initialized: ${this.runtimeId}`);
  }

  // ---------------------------------------------------------------------------
  // AgentRuntime Implementation
  // ---------------------------------------------------------------------------

  /**
   * Activate an agent on this local runtime.
   *
   * Fire-and-forget: sends WS command and returns immediately with 'activating' state.
   * State transitions to 'online' when agent_checkin is received via WS.
   */
  async activate(options: ActivateOptions): Promise<AgentRuntimeState> {
    const { agentId, systemPrompt, mcpServers } = options;

    console.log(`[LocalRuntime] Activating agent: ${agentId}`);

    // Check if already active (idempotent)
    const existing = this.stateManager.getState(agentId);
    if (existing && (existing.status === 'online' || existing.status === 'busy' || existing.status === 'activating')) {
      console.log(`[LocalRuntime] Agent already ${existing.status}`);
      return existing;
    }

    // Verify runtime is connected
    if (!this.connectionManager.isRuntimeOnline(this.runtimeId)) {
      throw new Error(`Runtime ${this.runtimeId} is not connected`);
    }

    // Emit activating event
    await this.emit({ type: 'agent_activating', agentId });

    // Compute workspace path
    const workspacePath = this.computeWorkspacePath(agentId);

    // Send activate command via WS
    const sent = this.connectionManager.sendCommand(this.runtimeId, {
      type: 'activate',
      agentId,
      systemPrompt: systemPrompt ?? '',
      mcpServers,
      workspacePath,
    });

    if (!sent) {
      throw new Error(`Failed to send activate command to runtime ${this.runtimeId}`);
    }

    // Set activating state
    const state = this.stateManager.handleActivate(agentId, {
      container: {
        containerId: this.runtimeId,
        runtime: 'local',
      },
    });

    console.log(`[LocalRuntime] Activate command sent, state: ${state.status}`);
    return state;
  }

  /**
   * Send a message to an agent on this runtime.
   */
  async sendMessage(agentId: string, message: AgentMessage): Promise<void> {
    const state = this.stateManager.getState(agentId);

    if (!state || (state.status !== 'online' && state.status !== 'busy')) {
      throw new Error(`Agent ${agentId} is not online (status: ${state?.status ?? 'unknown'})`);
    }

    // Verify runtime is still connected
    if (!this.connectionManager.isRuntimeOnline(this.runtimeId)) {
      throw new Error(`Runtime ${this.runtimeId} is not connected`);
    }

    // Send message command via WS
    const sent = this.connectionManager.sendCommand(this.runtimeId, {
      type: 'message',
      agentId,
      messageId: generateMessageId(),
      content: message.content,
      sender: 'backend',
      systemPrompt: message.systemPrompt,
    });

    if (!sent) {
      throw new Error(`Failed to send message to runtime ${this.runtimeId}`);
    }

    console.log(`[LocalRuntime] Message sent to agent ${agentId}`);
  }

  /**
   * Suspend an agent on this runtime.
   * Idempotent: no-op if already offline.
   */
  async suspend(agentId: string, reason?: string): Promise<void> {
    const state = this.stateManager.getState(agentId);

    if (!state || state.status === 'offline') {
      console.log(`[LocalRuntime] Agent ${agentId} already offline`);
      return;
    }

    console.log(`[LocalRuntime] Suspending agent ${agentId}: ${reason ?? 'no reason'}`);

    // Send suspend command if runtime is connected
    if (this.connectionManager.isRuntimeOnline(this.runtimeId)) {
      this.connectionManager.sendCommand(this.runtimeId, {
        type: 'suspend',
        agentId,
        reason,
      });
    }

    // Update state to offline immediately
    const newState = this.stateManager.handleSuspend(agentId);

    // Emit event
    await this.emit({ type: 'agent_offline', agentId, reason: reason ?? 'suspended' });

    console.log(`[LocalRuntime] Agent suspended, state: ${newState.status}`);
  }

  /**
   * Get current runtime state for an agent.
   */
  getState(agentId: string): AgentRuntimeState | null {
    return this.stateManager.getState(agentId);
  }

  /**
   * Check if an agent is currently online.
   */
  isOnline(agentId: string): boolean {
    return this.stateManager.isOnline(agentId);
  }

  /**
   * Get all currently online agents on this runtime.
   */
  getAllOnline(): AgentRuntimeState[] {
    // Filter to only agents on this runtime
    return this.stateManager.getAllOnline().filter((state) => {
      return state.container?.containerId === this.runtimeId;
    });
  }

  /**
   * Graceful shutdown - suspend all agents on this runtime.
   */
  async shutdown(): Promise<void> {
    console.log(`[LocalRuntime] Shutting down...`);

    const online = this.getAllOnline();
    for (const state of online) {
      await this.suspend(state.agentId, 'runtime shutdown');
    }

    console.log(`[LocalRuntime] Shutdown complete`);
  }

  // ---------------------------------------------------------------------------
  // Event Handlers (called by RuntimeConnectionManager)
  // ---------------------------------------------------------------------------

  /**
   * Handle agent checkin from WS.
   * Called by RuntimeConnectionManager when agent_checkin message received.
   */
  handleAgentCheckin(agentId: string): AgentRuntimeState {
    const state = this.stateManager.handleCheckin(agentId);
    this.emit({ type: 'agent_online', agentId, endpoint: `ws:${this.runtimeId}` });
    return state;
  }

  /**
   * Handle Tymbal frame from WS.
   * Called by RuntimeConnectionManager when frame message received.
   */
  handleAgentFrame(agentId: string, isIdle: boolean): AgentRuntimeState {
    return this.stateManager.handleFrame(agentId, isIdle);
  }

  /**
   * Handle agent error.
   * Called by RuntimeConnectionManager on timeout or error.
   */
  handleAgentError(agentId: string): AgentRuntimeState {
    const state = this.stateManager.handleError(agentId);
    this.emit({ type: 'agent_error', agentId, error: 'agent error' });
    return state;
  }

  /**
   * Handle runtime disconnect.
   * Marks all agents on this runtime as offline.
   */
  handleRuntimeDisconnect(): void {
    console.log(`[LocalRuntime] Runtime disconnected, marking agents offline`);

    const online = this.getAllOnline();
    for (const state of online) {
      this.stateManager.handleSuspend(state.agentId);
      this.emit({ type: 'agent_offline', agentId: state.agentId, reason: 'runtime disconnected' });
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private computeWorkspacePath(agentId: string): string {
    const { spaceId, channelId, callsign } = parseAgentId(agentId);
    return `${this.workspaceBasePath}/${spaceId}/${channelId}/${callsign}`;
  }

  private async emit(event: Parameters<RuntimeEventHandler>[0]): Promise<void> {
    if (this.onEvent) {
      await this.onEvent(event);
    }
  }
}

// =============================================================================
// Factory Function
// =============================================================================

/**
 * Create a LocalRuntime instance.
 */
export function createLocalRuntime(config: LocalRuntimeConfig): LocalRuntime {
  return new LocalRuntime(config);
}
