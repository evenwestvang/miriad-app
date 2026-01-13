/**
 * Runtime Registry
 *
 * Routes agents to the correct AgentRuntime based on roster.runtime_id.
 *
 * Routing logic:
 * - runtime_id = null → default runtime (FlyRuntime in prod, DockerRuntime in dev)
 * - runtime_id = "rt_xyz" → lookup LocalRuntime for that runtime
 *
 * Returns null when a LocalRuntime is offline (not connected), allowing caller
 * to broadcast error to channel. Message stays in DB for later delivery.
 */

import type { AgentRuntime } from '@cast/runtime';
import type { Storage } from '@cast/storage';
import { parseAgentId } from '@cast/runtime';

// =============================================================================
// Types
// =============================================================================

/**
 * LocalRuntime instance interface.
 * Full implementation comes in Phase 2 - this is the expected shape.
 */
export interface LocalRuntime extends AgentRuntime {
  /** Runtime ID from database */
  readonly runtimeId: string;
}

export interface RuntimeRegistryOptions {
  /** Storage for roster queries */
  storage: Storage;
  /** Default runtime for agents without runtime_id (FlyRuntime in prod, DockerRuntime in dev) */
  defaultRuntime: AgentRuntime;
}

export interface RuntimeRegistry {
  /**
   * Get the appropriate runtime for an agent.
   *
   * @param agentId - Agent identity in canonical format: {spaceId}:{channelId}:{callsign}
   * @returns AgentRuntime to use, or null if agent's LocalRuntime is offline
   *
   * Returns null (not throws) when:
   * - Agent is bound to a LocalRuntime that isn't connected
   *
   * This allows caller to:
   * 1. Broadcast error to channel ("Can't reach @agent - runtime offline")
   * 2. Leave message in DB for later delivery when runtime reconnects
   */
  getRuntimeForAgent(agentId: string): Promise<AgentRuntime | null>;

  /**
   * Register a LocalRuntime when it connects via WebSocket.
   * Called by RuntimeConnectionManager (Phase 2).
   */
  registerLocalRuntime(runtimeId: string, runtime: LocalRuntime): void;

  /**
   * Unregister a LocalRuntime when it disconnects.
   * Called by RuntimeConnectionManager (Phase 2).
   */
  unregisterLocalRuntime(runtimeId: string): void;

  /**
   * Get a LocalRuntime by ID.
   * Returns undefined if not connected.
   */
  getLocalRuntime(runtimeId: string): LocalRuntime | undefined;

  /**
   * Get all connected LocalRuntimes.
   */
  getAllLocalRuntimes(): Map<string, LocalRuntime>;

  /**
   * Check if a LocalRuntime is connected.
   */
  isLocalRuntimeConnected(runtimeId: string): boolean;
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a RuntimeRegistry instance.
 */
export function createRuntimeRegistry(options: RuntimeRegistryOptions): RuntimeRegistry {
  const { storage, defaultRuntime } = options;

  // In-memory map of connected LocalRuntimes
  // Key: runtimeId, Value: LocalRuntime instance
  const localRuntimes = new Map<string, LocalRuntime>();

  async function getRuntimeForAgent(agentId: string): Promise<AgentRuntime | null> {
    const { channelId, callsign } = parseAgentId(agentId);

    // Query roster for agent's runtime binding
    const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);

    // No roster entry or no runtime_id → use default runtime
    if (!rosterEntry?.runtimeId) {
      return defaultRuntime;
    }

    // Agent is bound to a LocalRuntime - check if it's connected
    const localRuntime = localRuntimes.get(rosterEntry.runtimeId);

    if (!localRuntime) {
      // Runtime is offline - return null so caller can handle gracefully
      console.log(
        `[RuntimeRegistry] LocalRuntime ${rosterEntry.runtimeId} not connected for agent ${agentId}`
      );
      return null;
    }

    return localRuntime;
  }

  function registerLocalRuntime(runtimeId: string, runtime: LocalRuntime): void {
    console.log(`[RuntimeRegistry] Registering LocalRuntime: ${runtimeId}`);
    localRuntimes.set(runtimeId, runtime);
  }

  function unregisterLocalRuntime(runtimeId: string): void {
    console.log(`[RuntimeRegistry] Unregistering LocalRuntime: ${runtimeId}`);
    localRuntimes.delete(runtimeId);
  }

  function getLocalRuntime(runtimeId: string): LocalRuntime | undefined {
    return localRuntimes.get(runtimeId);
  }

  function getAllLocalRuntimes(): Map<string, LocalRuntime> {
    return new Map(localRuntimes);
  }

  function isLocalRuntimeConnected(runtimeId: string): boolean {
    return localRuntimes.has(runtimeId);
  }

  return {
    getRuntimeForAgent,
    registerLocalRuntime,
    unregisterLocalRuntime,
    getLocalRuntime,
    getAllLocalRuntimes,
    isLocalRuntimeConnected,
  };
}
