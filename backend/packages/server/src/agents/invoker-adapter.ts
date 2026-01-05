/**
 * AgentInvoker Adapter
 *
 * Routes messages to agents - either directly to running containers (via callbackUrl
 * in roster) or by spawning new containers via the orchestrator.
 *
 * This is the integration point between message routing and agent lifecycle.
 * The roster table in PlanetScale is the source of truth for container state.
 */

import type { AgentManager } from './agent-manager.js';
import type { Storage } from '@cast/storage';
import type { AgentInvoker, Message } from '../handlers/messages.js';
import { pushMessagesToContainer, compileMessages } from '../handlers/checkin.js';

// =============================================================================
// Types
// =============================================================================

export interface AgentInvokerAdapterOptions {
  /** The AgentManager instance to delegate to (for spawning new containers) */
  agentManager: AgentManager;
  /** Storage for checking roster callbackUrl */
  storage: Storage;
  /** The space ID (all agents in this invoker belong to same space) */
  spaceId: string;
}

// =============================================================================
// Adapter
// =============================================================================

/**
 * Create an AgentInvoker that routes messages to agents.
 *
 * Flow for each target agent:
 * 1. Check roster for callbackUrl (container already running?)
 * 2. If callbackUrl exists → push directly to container
 * 3. If no callbackUrl → spawn new container via AgentManager
 *    (container will checkin and get message via pending queue)
 *
 * This eliminates the need for in-memory state in Lambda - roster is source of truth.
 */
export function createAgentInvokerAdapter(
  options: AgentInvokerAdapterOptions
): AgentInvoker {
  const { agentManager, storage, spaceId } = options;

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
            // Step 1: Check roster for existing callbackUrl
            const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);

            if (rosterEntry?.callbackUrl) {
              // Step 2a: Container is running - push directly
              console.log(`[AgentInvoker] @${callsign} has callbackUrl, pushing directly to ${rosterEntry.callbackUrl}`);

              const threadId = `${spaceId}:${channelId}:${callsign}`;
              const userMessage = `Message from @${message.sender}: ${message.content}`;

              const success = await pushMessagesToContainer(
                rosterEntry.callbackUrl,
                userMessage,
                threadId
              );

              if (success) {
                // Update readmark after successful delivery
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  readmark: message.id,
                });
                console.log(`[AgentInvoker] Successfully pushed to @${callsign}, updated readmark to ${message.id}`);
              } else {
                // Push failed - container may have died, clear callbackUrl and spawn new
                console.warn(`[AgentInvoker] Push to @${callsign} failed, clearing callbackUrl and spawning new container`);
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  callbackUrl: undefined,
                });
                // Fall through to spawn
                await agentManager.sendMessage(
                  spaceId,
                  channelId,
                  callsign,
                  message.sender,
                  message.content
                );
              }
            } else {
              // Step 2b: No container running - spawn new one
              console.log(`[AgentInvoker] @${callsign} has no callbackUrl, spawning new container`);
              await agentManager.sendMessage(
                spaceId,
                channelId,
                callsign,
                message.sender,
                message.content
              );
              console.log(`[AgentInvoker] Spawned container for @${callsign} (will checkin and get pending messages)`);
            }
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
