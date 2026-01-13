/**
 * @cast/runtime - Agent State Manager
 *
 * Shared state derivation logic for agent lifecycle management.
 * Used by DockerRuntime and LocalRuntime to manage agent states.
 *
 * State transitions:
 *   offline → activating (handleActivate)
 *   activating → online (handleCheckin)
 *   online → busy (handleFrame with isIdle=false)
 *   busy → online (handleFrame with isIdle=true)
 *   any → offline (handleSuspend)
 *   any → error (handleError, handleTimeout)
 */

import type { AgentRuntimeState, AgentStatus, ContainerInfo } from './types.js';

// =============================================================================
// Pure State Transition Functions
// =============================================================================

/**
 * Derive new status from checkin event.
 * Checkin means the agent is ready to receive messages.
 */
export function deriveStateFromCheckin(current: AgentStatus): AgentStatus {
  // Only transition from activating state
  if (current === 'activating') {
    return 'online';
  }
  // Already online/busy - no change (idempotent checkin)
  if (current === 'online' || current === 'busy') {
    return current;
  }
  // Unexpected checkin from offline/error - treat as online
  return 'online';
}

/**
 * Derive new status from Tymbal frame event.
 * Idle frame means agent finished processing, non-idle means working.
 */
export function deriveStateFromFrame(current: AgentStatus, isIdle: boolean): AgentStatus {
  // Only update if currently online or busy
  if (current !== 'online' && current !== 'busy') {
    return current;
  }
  return isIdle ? 'online' : 'busy';
}

/**
 * Derive new status from suspend event.
 */
export function deriveStateFromSuspend(_current: AgentStatus): AgentStatus {
  return 'offline';
}

/**
 * Derive new status from error/timeout event.
 */
export function deriveStateFromError(_current: AgentStatus): AgentStatus {
  return 'error';
}

/**
 * Derive new status from activate event.
 */
export function deriveStateFromActivate(current: AgentStatus): AgentStatus {
  // Already activating or online - no change (idempotent)
  if (current === 'activating' || current === 'online' || current === 'busy') {
    return current;
  }
  return 'activating';
}

// =============================================================================
// State Factory
// =============================================================================

/**
 * Create initial agent runtime state.
 */
export function createInitialState(agentId: string): AgentRuntimeState {
  return {
    agentId,
    container: null,
    port: null,
    status: 'offline',
    endpoint: null,
    routeHints: null,
    activatedAt: null,
    lastActivity: new Date().toISOString(),
  };
}

// =============================================================================
// Agent State Manager Class
// =============================================================================

export interface ActivateStateOptions {
  container?: ContainerInfo;
  port?: number;
  endpoint?: string;
  routeHints?: Record<string, string>;
}

/**
 * Manages agent runtime state with consistent state transitions.
 *
 * Usage:
 * ```typescript
 * const stateManager = new AgentStateManager();
 *
 * // Activate an agent
 * const state = stateManager.handleActivate('space:channel:callsign', {
 *   container: { containerId: 'abc', runtime: 'docker' }
 * });
 *
 * // Handle checkin
 * const newState = stateManager.handleCheckin('space:channel:callsign');
 * // Caller broadcasts state change
 *
 * // Handle frame
 * stateManager.handleFrame('space:channel:callsign', false); // busy
 * stateManager.handleFrame('space:channel:callsign', true);  // online
 * ```
 */
export class AgentStateManager {
  private states = new Map<string, AgentRuntimeState>();

  /**
   * Handle agent activation request.
   * Creates or updates state to 'activating'.
   * Idempotent: returns existing state if already activating/online.
   */
  handleActivate(agentId: string, options?: ActivateStateOptions): AgentRuntimeState {
    let state = this.states.get(agentId);

    if (!state) {
      state = createInitialState(agentId);
      this.states.set(agentId, state);
    }

    const newStatus = deriveStateFromActivate(state.status);

    // Only update if status actually changed
    if (newStatus !== state.status) {
      state.status = newStatus;
      state.activatedAt = new Date().toISOString();
    }

    // Update container info if provided
    if (options?.container) {
      state.container = options.container;
    }
    if (options?.port !== undefined) {
      state.port = options.port;
    }
    if (options?.endpoint !== undefined) {
      state.endpoint = options.endpoint;
    }
    if (options?.routeHints !== undefined) {
      state.routeHints = options.routeHints;
    }

    state.lastActivity = new Date().toISOString();
    return { ...state };
  }

  /**
   * Handle agent checkin (agent reports ready).
   * Transitions from 'activating' to 'online'.
   */
  handleCheckin(agentId: string, endpoint?: string): AgentRuntimeState {
    let state = this.states.get(agentId);

    if (!state) {
      // Unexpected checkin - create state
      state = createInitialState(agentId);
      this.states.set(agentId, state);
    }

    state.status = deriveStateFromCheckin(state.status);
    if (endpoint !== undefined) {
      state.endpoint = endpoint;
    }
    state.lastActivity = new Date().toISOString();

    return { ...state };
  }

  /**
   * Handle Tymbal frame from agent.
   * Transitions between 'online' and 'busy' based on idle flag.
   */
  handleFrame(agentId: string, isIdle: boolean): AgentRuntimeState {
    const state = this.states.get(agentId);

    if (!state) {
      // Frame from unknown agent - should not happen, return offline state
      return createInitialState(agentId);
    }

    state.status = deriveStateFromFrame(state.status, isIdle);
    state.lastActivity = new Date().toISOString();

    return { ...state };
  }

  /**
   * Handle agent suspension.
   * Transitions to 'offline' and clears runtime info.
   */
  handleSuspend(agentId: string): AgentRuntimeState {
    const state = this.states.get(agentId);

    if (!state) {
      return createInitialState(agentId);
    }

    state.status = deriveStateFromSuspend(state.status);
    state.lastActivity = new Date().toISOString();

    // Clear runtime info when going offline
    state.endpoint = null;
    state.routeHints = null;
    state.container = null;
    state.port = null;

    return { ...state };
  }

  /**
   * Handle agent heartbeat.
   * Updates lastActivity timestamp without changing state.
   * Used by LocalRuntime to signal agent is still alive.
   */
  handleHeartbeat(agentId: string): AgentRuntimeState {
    const state = this.states.get(agentId);

    if (!state) {
      // Heartbeat from unknown agent - should not happen
      return createInitialState(agentId);
    }

    // Just update lastActivity, don't change status
    state.lastActivity = new Date().toISOString();

    return { ...state };
  }

  /**
   * Handle agent error or timeout.
   * Transitions to 'error' state.
   */
  handleError(agentId: string, _error?: string): AgentRuntimeState {
    const state = this.states.get(agentId);

    if (!state) {
      const newState = createInitialState(agentId);
      newState.status = 'error';
      this.states.set(agentId, newState);
      return { ...newState };
    }

    state.status = deriveStateFromError(state.status);
    state.lastActivity = new Date().toISOString();

    return { ...state };
  }

  /**
   * Handle activation timeout (agent didn't checkin in time).
   * Alias for handleError.
   */
  handleTimeout(agentId: string): AgentRuntimeState {
    return this.handleError(agentId, 'activation timeout');
  }

  // ===========================================================================
  // Query Methods
  // ===========================================================================

  /**
   * Get current state for an agent.
   */
  getState(agentId: string): AgentRuntimeState | null {
    const state = this.states.get(agentId);
    return state ? { ...state } : null;
  }

  /**
   * Check if an agent is currently online (online or busy).
   */
  isOnline(agentId: string): boolean {
    const state = this.states.get(agentId);
    return state?.status === 'online' || state?.status === 'busy';
  }

  /**
   * Get all currently online agents.
   */
  getAllOnline(): AgentRuntimeState[] {
    return Array.from(this.states.values())
      .filter((s) => s.status === 'online' || s.status === 'busy')
      .map((s) => ({ ...s }));
  }

  /**
   * Remove an agent from state tracking.
   * Use after permanent removal (e.g., runtime disconnect).
   */
  removeAgent(agentId: string): void {
    this.states.delete(agentId);
  }

  /**
   * Clear all state (for shutdown/testing).
   */
  clear(): void {
    this.states.clear();
  }
}
