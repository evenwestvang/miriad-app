/**
 * Mock Container Orchestrator
 *
 * Test-only implementation of ContainerOrchestrator that:
 * - Records all spawn/sendMessage calls
 * - Provides callbacks to simulate container responses
 * - No Docker dependency - purely in-memory
 */

import type {
  ContainerOrchestrator,
  ContainerSpawnOptions,
  ContainerState,
  OrchestratorEvent,
  OrchestratorEventHandler,
} from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface SpawnCall {
  options: ContainerSpawnOptions;
  timestamp: string;
}

export interface SendMessageCall {
  threadId: string;
  content: string;
  systemPrompt?: string;
  timestamp: string;
}

export interface MockOrchestratorOptions {
  /** Base URL for simulating Tymbal callbacks (e.g., "http://localhost:3000") */
  serverBaseUrl?: string;
  /** Event handler for orchestrator events */
  onEvent?: OrchestratorEventHandler;
}

// =============================================================================
// Mock Orchestrator
// =============================================================================

export class MockContainerOrchestrator implements ContainerOrchestrator {
  private containers = new Map<string, ContainerState>();
  private spawnCalls: SpawnCall[] = [];
  private sendMessageCalls: SendMessageCall[] = [];
  private options: MockOrchestratorOptions;
  private nextPort = 10000;

  constructor(options: MockOrchestratorOptions = {}) {
    this.options = options;
  }

  // ---------------------------------------------------------------------------
  // ContainerOrchestrator Implementation
  // ---------------------------------------------------------------------------

  async spawn(options: ContainerSpawnOptions): Promise<ContainerState> {
    const threadId = `${options.spaceId}:${options.channelId}:${options.callsign}`;
    const now = new Date().toISOString();

    // Record the call
    this.spawnCalls.push({
      options,
      timestamp: now,
    });

    // Emit starting event
    await this.emit({ type: 'container_starting', threadId });

    // Create container state
    const port = this.nextPort++;
    const state: ContainerState = {
      threadId,
      containerId: `mock-container-${threadId}`,
      port,
      status: 'running',
      lastActivity: now,
      createdAt: now,
    };

    this.containers.set(threadId, state);

    // Emit ready event
    await this.emit({ type: 'container_ready', threadId, port });

    return state;
  }

  async sendMessage(
    threadId: string,
    content: string,
    systemPrompt?: string
  ): Promise<void> {
    const state = this.containers.get(threadId);
    if (!state || state.status !== 'running') {
      throw new Error(`Container ${threadId} is not running`);
    }

    // Record the call
    this.sendMessageCalls.push({
      threadId,
      content,
      systemPrompt,
      timestamp: new Date().toISOString(),
    });

    // Update last activity
    state.lastActivity = new Date().toISOString();
  }

  async stop(threadId: string, reason = 'stopped'): Promise<void> {
    const state = this.containers.get(threadId);
    if (!state) {
      return;
    }

    state.status = 'stopped';
    await this.emit({ type: 'container_stopped', threadId, reason });
  }

  getStatus(threadId: string): ContainerState | null {
    return this.containers.get(threadId) || null;
  }

  isRunning(threadId: string): boolean {
    const state = this.containers.get(threadId);
    return state?.status === 'running';
  }

  getAllRunning(): ContainerState[] {
    return Array.from(this.containers.values()).filter(
      (s) => s.status === 'running'
    );
  }

  async shutdown(): Promise<void> {
    for (const threadId of this.containers.keys()) {
      await this.stop(threadId, 'shutdown');
    }
  }

  // ---------------------------------------------------------------------------
  // Test Helpers
  // ---------------------------------------------------------------------------

  /**
   * Get all recorded spawn calls.
   */
  getSpawnCalls(): SpawnCall[] {
    return [...this.spawnCalls];
  }

  /**
   * Get all recorded sendMessage calls.
   */
  getSendMessageCalls(): SendMessageCall[] {
    return [...this.sendMessageCalls];
  }

  /**
   * Get sendMessage calls for a specific thread.
   */
  getMessagesForThread(threadId: string): SendMessageCall[] {
    return this.sendMessageCalls.filter((c) => c.threadId === threadId);
  }

  /**
   * Clear all recorded calls (useful between tests).
   */
  clearHistory(): void {
    this.spawnCalls = [];
    this.sendMessageCalls = [];
  }

  /**
   * Reset all state (containers + history).
   */
  reset(): void {
    this.containers.clear();
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

  private async emit(event: OrchestratorEvent): Promise<void> {
    if (this.options.onEvent) {
      await this.options.onEvent(event);
    }
  }
}

/**
 * Create a mock orchestrator for testing.
 */
export function createMockOrchestrator(
  options: MockOrchestratorOptions = {}
): MockContainerOrchestrator {
  return new MockContainerOrchestrator(options);
}
