/**
 * AgentInvoker Adapter
 *
 * Adapts the AgentManager to the AgentInvoker interface used by message routing.
 * This is the integration point between @tymbal's routing and agent spawning.
 */

import type { AgentManager } from './agent-manager.js';
import type { AgentInvoker, Message } from '../handlers/messages.js';

// =============================================================================
// Types
// =============================================================================

export interface AgentInvokerAdapterOptions {
  /** The AgentManager instance to delegate to */
  agentManager: AgentManager;
  /** The space ID (all agents in this invoker belong to same space) */
  spaceId: string;
}

// =============================================================================
// Adapter
// =============================================================================

/**
 * Create an AgentInvoker that delegates to an AgentManager.
 *
 * This adapter handles:
 * 1. Iterating over target callsigns
 * 2. Invoking AgentManager.sendMessage() for each
 * 3. Parallel execution with proper error handling
 */
export function createAgentInvokerAdapter(
  options: AgentInvokerAdapterOptions
): AgentInvoker {
  const { agentManager, spaceId } = options;

  return {
    invokeAgents: async (
      channelId: string,
      targets: string[],
      message: Message
    ): Promise<void> => {
      if (targets.length === 0) {
        return;
      }

      console.log(
        `[AgentInvoker] Invoking ${targets.length} agent(s) for message ${message.id}:`,
        targets
      );

      // Invoke all agents in parallel
      const results = await Promise.allSettled(
        targets.map(async (callsign) => {
          try {
            await agentManager.sendMessage(
              spaceId,
              channelId,
              callsign,
              message.sender,
              message.content
            );
            console.log(`[AgentInvoker] Successfully invoked @${callsign}`);
          } catch (error) {
            console.error(`[AgentInvoker] Failed to invoke @${callsign}:`, error);
            throw error;
          }
        })
      );

      // Log any failures but don't throw - we want partial success
      const failures = results.filter((r) => r.status === 'rejected');
      if (failures.length > 0) {
        console.warn(
          `[AgentInvoker] ${failures.length}/${targets.length} agent invocations failed`
        );
      }
    },
  };
}
