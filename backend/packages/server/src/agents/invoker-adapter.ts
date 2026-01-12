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
import type { AgentRuntime } from '@cast/runtime';
import type { ConnectionManager } from '../websocket/index.js';
import type { AgentInvoker, Message } from '../handlers/messages.js';
import type { RuntimeRegistry } from './runtime-registry.js';
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
  /** Agent runtime for direct message routing (local Docker) */
  runtime?: AgentRuntime;
  /** Local agent manager for routing to local-agent-engine connections */
  localAgentRouter?: LocalAgentRouter;
  /** WebSocket connection manager for broadcasting agent state */
  connectionManager?: ConnectionManager;
  /** Runtime registry for routing to LocalRuntimes based on roster.runtime_id */
  runtimeRegistry?: RuntimeRegistry;
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
  const { agentManager, storage, spaceId, runtime, localAgentRouter, connectionManager, runtimeRegistry } = options;

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

            const agentId = `${spaceId}:${channelId}:${callsign}`;
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

            // Step 1: Check RuntimeRegistry for agents bound to a LocalRuntime (via roster.runtime_id)
            // This is the primary routing path for local agents running via local-runtime
            if (runtimeRegistry && rosterEntry?.runtimeId) {
              const localRuntime = await runtimeRegistry.getRuntimeForAgent(agentId);

              if (localRuntime === null) {
                // Runtime is offline - broadcast error to channel, message stays in DB for later
                console.warn(`[AgentInvoker] @${callsign}'s runtime (${rosterEntry.runtimeId}) is offline`);
                // Broadcast offline state so UI shows agent is unreachable
                await broadcastAgentState(connectionManager, channelId, callsign, 'offline');
                // Don't throw - message stays in DB, will be delivered when runtime reconnects
                return;
              }

              // Runtime is online - route message through it
              console.log(`[AgentInvoker] @${callsign} bound to LocalRuntime ${rosterEntry.runtimeId}, routing via registry`);

              // Check if agent is online on this runtime
              if (localRuntime.isOnline(agentId)) {
                // Agent is already active - send message directly
                const systemPrompt = await agentManager.buildPromptForAgent(spaceId, channelId, callsign);
                await localRuntime.sendMessage(agentId, { content: userMessage, systemPrompt });

                // Update readmark and lastMessageRoutedAt
                const now = new Date().toISOString();
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  readmark: message.id,
                  lastMessageRoutedAt: now,
                });
                await broadcastAgentState(connectionManager, channelId, callsign, 'pending', now);
                console.log(`[AgentInvoker] Successfully sent to @${callsign} via LocalRuntime`);
                return;
              } else {
                // Agent not active yet - activate it
                console.log(`[AgentInvoker] @${callsign} not active, activating on LocalRuntime ${rosterEntry.runtimeId}`);
                await broadcastAgentState(connectionManager, channelId, callsign, 'connecting');

                const systemPrompt = await agentManager.buildPromptForAgent(spaceId, channelId, callsign);
                const authToken = generateContainerToken({ spaceId, channelId, callsign });

                await localRuntime.activate({
                  agentId,
                  authToken,
                  systemPrompt,
                  // mcpServers could be added here from roster config in the future
                });

                // Update lastMessageRoutedAt - message will be delivered when agent checks in
                const now = new Date().toISOString();
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  lastMessageRoutedAt: now,
                });
                console.log(`[AgentInvoker] Activated @${callsign} on LocalRuntime (will get message on checkin)`);
                return;
              }
            }

            // Step 2: For local Docker, check if runtime has container running
            // This bypasses the roster callbackUrl which has host.docker.internal issues
            if (runtime?.isOnline(agentId)) {
              console.log(`[AgentInvoker] @${callsign} container running (via runtime), sending directly`);

              // Build system prompt using centralized method from AgentManager
              const systemPrompt = await agentManager.buildPromptForAgent(spaceId, channelId, callsign);
              await runtime.sendMessage(agentId, { content: userMessage, systemPrompt });

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
              console.log(`[AgentInvoker] Successfully sent to @${callsign} via runtime`);
              return;
            }

            // Step 3: Check roster for existing callbackUrl (remote container)
            // Note: rosterEntry already fetched at start of loop for status check

            if (rosterEntry?.callbackUrl) {
              // Step 3a: Container is running - push directly
              console.log(`[AgentInvoker] @${callsign} has callbackUrl, pushing directly to ${rosterEntry.callbackUrl}`);

              // Generate auth token for this agent (deterministic - same as container received at activate)
              const authToken = generateContainerToken({ spaceId, channelId, callsign });

              // Build system prompt using centralized method from AgentManager
              const systemPrompt = await agentManager.buildPromptForAgent(spaceId, channelId, callsign);

              // v3.0: Pass routeHints to be echoed as HTTP headers (for Fly.io routing, etc.)
              const success = await pushMessagesToContainer(
                rosterEntry.callbackUrl,
                userMessage,
                agentId,
                authToken,
                systemPrompt,
                rosterEntry.routeHints as Record<string, string> | null
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
              // Step 3b: No container running - spawn new one
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
