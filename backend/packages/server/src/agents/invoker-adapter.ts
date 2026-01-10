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
import type { ContainerOrchestrator } from '@cast/runtime';
import type { ConnectionManager } from '../websocket/index.js';
import type { AgentInvoker, Message } from '../handlers/messages.js';
import { pushMessagesToContainer, compileMessages, broadcastAgentState } from '../handlers/checkin.js';
import { generateContainerToken } from '../auth/index.js';

/**
 * Convert message content to string for agent consumption.
 * Text messages are already strings, structured messages (like status) are JSON-stringified.
 */
function contentToString(content: string | Record<string, unknown>): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// =============================================================================
// Types
// =============================================================================

/** Interface for local agent manager */
export interface LocalAgentRouter {
  /** Check if a local agent is connected */
  isAgentConnected: (channelId: string, callsign: string) => boolean;
  /** Send a message to a local agent */
  sendToAgent: (channelId: string, callsign: string, message: {
    type: 'message';
    id: string;
    channelId: string;
    callsign: string;
    content: string;
    sender: string;
    systemPrompt: string;
  }) => boolean;
}

export interface AgentInvokerAdapterOptions {
  /** The AgentManager instance to delegate to (for spawning new containers and building prompts) */
  agentManager: AgentManager;
  /** Storage for checking roster callbackUrl */
  storage: Storage;
  /** The space ID (all agents in this invoker belong to same space) */
  spaceId: string;
  /** Container orchestrator for direct message routing (local Docker) */
  orchestrator?: ContainerOrchestrator;
  /** Local agent manager for routing to local-agent-engine connections */
  localAgentRouter?: LocalAgentRouter;
  /** WebSocket connection manager for broadcasting agent state */
  connectionManager?: ConnectionManager;
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
  const { agentManager, storage, spaceId, orchestrator, localAgentRouter, connectionManager } = options;

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
            // Step 0a: Check if agent is paused or archived - skip if so
            const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
            if (rosterEntry?.status === 'paused') {
              console.log(`[AgentInvoker] Skipping @${callsign}: agent is paused`);
              return;
            }
            if (rosterEntry?.status === 'archived') {
              console.log(`[AgentInvoker] Skipping @${callsign}: agent is archived`);
              return;
            }

            const threadId = `${spaceId}:${channelId}:${callsign}`;
            const userMessage = `Message from @${message.sender}: ${message.content}`;

            // Step 0b: Check if local agent is connected (local-agent-engine)
            if (localAgentRouter?.isAgentConnected(channelId, callsign)) {
              console.log(`[AgentInvoker] @${callsign} is a local agent, sending via WebSocket`);

              // Build system prompt using centralized method from AgentManager
              const systemPrompt = await agentManager.buildPromptForAgent(spaceId, channelId, callsign);

              const sent = localAgentRouter.sendToAgent(channelId, callsign, {
                type: 'message',
                id: message.id,
                channelId,
                callsign,
                content: contentToString(message.content),
                sender: message.sender,
                systemPrompt,
              });

              if (sent) {
                // Update readmark and lastMessageRoutedAt after successful delivery (rosterEntry already fetched above)
                if (rosterEntry) {
                  const now = new Date().toISOString();
                  await storage.updateRosterEntry(channelId, rosterEntry.id, {
                    readmark: message.id,
                    lastMessageRoutedAt: now,
                  });
                  // Broadcast pending state - agent is now processing
                  await broadcastAgentState(connectionManager, channelId, callsign, 'pending', now);
                }
                console.log(`[AgentInvoker] Successfully sent to local agent @${callsign}`);
                return;
              } else {
                console.warn(`[AgentInvoker] Failed to send to local agent @${callsign}, falling back`);
                // Fall through to other methods
              }
            }

            // Step 1: For local Docker, check if orchestrator has container running
            // This bypasses the roster callbackUrl which has host.docker.internal issues
            if (orchestrator?.isRunning(threadId)) {
              console.log(`[AgentInvoker] @${callsign} container running (via orchestrator), sending directly`);

              // Build system prompt using centralized method from AgentManager
              const systemPrompt = await agentManager.buildPromptForAgent(spaceId, channelId, callsign);
              await orchestrator.sendMessage(threadId, userMessage, systemPrompt);

              // Update readmark and lastMessageRoutedAt after successful delivery (rosterEntry already fetched above)
              if (rosterEntry) {
                const now = new Date().toISOString();
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  readmark: message.id,
                  lastMessageRoutedAt: now,
                });
                // Broadcast pending state - agent is now processing
                await broadcastAgentState(connectionManager, channelId, callsign, 'pending', now);
              }
              console.log(`[AgentInvoker] Successfully sent to @${callsign} via orchestrator`);
              return;
            }

            // Step 2: Check roster for existing callbackUrl (Fargate path)
            // Note: rosterEntry already fetched at start of loop for status check

            if (rosterEntry?.callbackUrl) {
              // Step 2a: Container is running - push directly
              console.log(`[AgentInvoker] @${callsign} has callbackUrl, pushing directly to ${rosterEntry.callbackUrl}`);

              // Generate auth token for this agent (deterministic - same as container received at spawn)
              const authToken = generateContainerToken({ spaceId, channelId, callsign });

              // Build system prompt using centralized method from AgentManager
              const systemPrompt = await agentManager.buildPromptForAgent(spaceId, channelId, callsign);

              const success = await pushMessagesToContainer(
                rosterEntry.callbackUrl,
                userMessage,
                threadId,
                authToken,
                systemPrompt
              );

              if (success) {
                // Update readmark and lastMessageRoutedAt after successful delivery
                const now = new Date().toISOString();
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  readmark: message.id,
                  lastMessageRoutedAt: now,
                });
                // Broadcast pending state - agent is now processing
                await broadcastAgentState(connectionManager, channelId, callsign, 'pending', now);
                console.log(`[AgentInvoker] Successfully pushed to @${callsign}, updated readmark to ${message.id}`);
              } else {
                // Push failed - container may have died, clear callbackUrl and spawn new
                console.warn(`[AgentInvoker] Push to @${callsign} failed, clearing callbackUrl and spawning new container`);
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  callbackUrl: undefined,
                });
                // Broadcast 'connecting' state before spawning
                await broadcastAgentState(connectionManager, channelId, callsign, 'connecting');
                // Fall through to spawn
                await agentManager.sendMessage(
                  spaceId,
                  channelId,
                  callsign,
                  message.sender,
                  contentToString(message.content)
                );
              }
            } else {
              // Step 2b: No container running - spawn new one
              console.log(`[AgentInvoker] @${callsign} has no callbackUrl, spawning new container`);
              // Broadcast 'connecting' state before spawning
              await broadcastAgentState(connectionManager, channelId, callsign, 'connecting');
              // Set lastMessageRoutedAt since we're routing a message (will become 'pending' after container starts)
              if (rosterEntry) {
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  lastMessageRoutedAt: new Date().toISOString(),
                });
              }
              await agentManager.sendMessage(
                spaceId,
                channelId,
                callsign,
                message.sender,
                contentToString(message.content)
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
