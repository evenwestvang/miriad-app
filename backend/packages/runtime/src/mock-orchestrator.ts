/**
 * Mock Agent Runtime
 *
 * Test-only implementation of AgentRuntime that:
 * - Records all activate/sendMessage calls
 * - Provides callbacks to simulate container responses
 * - No Docker dependency - purely in-memory
 */

import type {
  AgentRuntime,
  ActivateOptions,
  AgentRuntimeState,
  AgentMessage,
  RuntimeEvent,
  RuntimeEventHandler,
} from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface ActivateCall {
  options: ActivateOptions;
  timestamp: string;
}

export interface SendMessageCall {
  agentId: string;
  message: AgentMessage;
  timestamp: string;
}

export interface MockRuntimeOptions {
  /** Base URL for simulating Tymbal callbacks (e.g., "http://localhost:3000") */
  serverBaseUrl?: string;
  /** Event handler for runtime events */
  onEvent?: RuntimeEventHandler;
}

// =============================================================================
// Mock Runtime
// =============================================================================

export class MockAgentRuntime implements AgentRuntime {
  private agents = new Map<string, AgentRuntimeState>();
  private activateCalls: ActivateCall[] = [];
  private sendMessageCalls: SendMessageCall[] = [];
  private options: MockRuntimeOptions;
  private nextPort = 10000;

  constructor(options: MockRuntimeOptions = {}) {
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // AgentRuntime Implementation
  // ---------------------------------------------------------------------------

  async activate(options: ActivateOptions): Promise<AgentRuntimeState> {
    const { agentId } = options;
    const now = new Date().toISOString();

    // Record the call
    this.activateCalls.push({
      options,
      timestamp: now,
    });

    // Check if already online (idempotent)
    const existing = this.agents.get(agentId);
    if (existing && (existing.status === 'online' || existing.status === 'activating')) {
      return existing;
    }

    // Emit activating event
    await this.emit({ type: 'agent_activating', agentId });

    // Create agent state
    const port = this.nextPort++;
    const state: AgentRuntimeState = {
      agentId,
      container: {
        containerId: `mock-container-${agentId}`,
        runtime: 'mock',
      },
      port,
      status: 'online',
      endpoint: `http://localhost:${port}`,
      routeHints: null,
      activatedAt: now,
      lastActivity: now,
    };

    this.agents.set(agentId, state);

    // Emit online event
    await this.emit({ type: 'agent_online', agentId, endpoint: state.endpoint! });

    return state;
  }

  async sendMessage(agentId: string, message: AgentMessage): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state || state.status !== 'online') {
      throw new Error(`Agent ${agentId} is not online`);
    }

    // Record the call
    this.sendMessageCalls.push({
      agentId,
      message,
      timestamp: new Date().toISOString(),
    });

    // Update last activity
    state.lastActivity = new Date().toISOString();
  }

  async suspend(agentId: string, reason = 'manual'): Promise<void> {
    const state = this.agents.get(agentId);
    if (!state) {
      return;
    }

    // Idempotent
    if (state.status === 'offline' || state.status === 'suspending') {
      return;
    }

    state.status = 'offline';
    state.endpoint = null;
    state.routeHints = null;
    state.container = null;
    await this.emit({ type: 'agent_offline', agentId, reason });
  }

  getState(agentId: string): AgentRuntimeState | null {
    return this.agents.get(agentId) || null;
  }

  isOnline(agentId: string): boolean {
    const state = this.agents.get(agentId);
    return state?.status === 'online';
  }

  getAllOnline(): AgentRuntimeState[] {
    return Array.from(this.agents.values()).filter(
      (s) => s.status === 'online'
    );
  }

  async shutdown(): Promise<void> {
    for (const agentId of this.agents.keys()) {
      await this.suspend(agentId, 'shutdown');
    }
  }

  // ---------------------------------------------------------------------------
  // Test Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get all recorded activate calls.
   */
  getActivateCalls(): ActivateCall[] {
    return [...this.activateCalls];
  }

  /**
   * Get all recorded sendMessage calls.
   */
  getSendMessageCalls(): SendMessageCall[] {
    return [...this.sendMessageCalls];
  }

  /**
   * Get sendMessage calls for a specific agent.
   */
  getMessagesForAgent(agentId: string): SendMessageCall[] {
    return this.sendMessageCalls.filter((c) => c.agentId === agentId);
  }

  /**
   * Clear all recorded calls (useful between tests).
   */
  clearHistory(): void {
    this.activateCalls = [];
    this.sendMessageCalls = [];
  }

  /**
   * Reset all state (agents + history).
   */
  reset(): void {
    this.agents.clear();
    this.clearHistory();
    this.nextPort = 10000;
  }

  /**
   * Simulate a container posting a Tymbal frame back to the server.
   * Returns the fetch Response for assertions.
   */
  async simulateTymbalPost(
    channelId: string,
    frame: string,
    authToken = 'mock-container-token'
  ): Promise<Response> {
    if (!this.options.serverBaseUrl) {
      throw new Error('serverBaseUrl not configured');
    }

    const response = await fetch(
      `${this.options.serverBaseUrl}/tymbal/${channelId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain',
          Authorization: `Bearer ${authToken}`,
        },
        body: frame,
      }
    );

    return response;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private async emit(event: RuntimeEvent): Promise<void> {
    if (this.options.onEvent) {
      await this.options.onEvent(event);
    }
  }
}

/**
 * Create a mock runtime for testing.
 */
export function createMockRuntime(
  options: MockRuntimeOptions = {}
): MockAgentRuntime {
  return new MockAgentRuntime(options);
}
