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
import type { LocalRuntimeConfig } from '@cast/core';
import type { ConnectionManager } from '../websocket/index.js';
import type { AgentInvoker, Message } from '../handlers/messages.js';
import type { RuntimeRegistry } from './runtime-registry.js';
import type { ActivateAgentMessage, DeliverMessageMessage } from '../runtimes/runtime-protocol-handlers.js';
import { generateMessageId } from '@cast/core';
import { pushMessagesToContainer, compileMessages, broadcastAgentState } from '../handlers/checkin.js';
import { generateContainerToken } from '../auth/index.js';

/**
 * Convert message content to string for agent consumption.
 * Text messages are already strings, structured messages (like status) are JSON-stringified.
 */
function contentToString(content: string | Record<string, unknown>): string {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

/**
 * Check if an agent is online based on lastHeartbeat timestamp.
 * Agents send heartbeats every 30s, so we consider them online if
 * the last heartbeat was within 60s (allowing for some latency).
 */
function isAgentOnline(lastHeartbeat: string | null | undefined): boolean {
  if (!lastHeartbeat) return false;
  const heartbeatTime = new Date(lastHeartbeat).getTime();
  const now = Date.now();
  const ONLINE_THRESHOLD_MS = 60000; // 60 seconds
  return now - heartbeatTime < ONLINE_THRESHOLD_MS;
}

// =============================================================================
// Types
// =============================================================================

export interface AgentInvokerAdapterOptions {
  /** The AgentManager instance to delegate to (for spawning new containers and building prompts) */
  agentManager: AgentManager;
  /** Storage for checking roster callbackUrl */
  storage: Storage;
  /** The space ID (all agents in this invoker belong to same space) */
  spaceId: string;
  /** Agent runtime for direct message routing (local Docker) */
  runtime?: AgentRuntime;
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
  const { agentManager, storage, spaceId, runtime, connectionManager, runtimeRegistry } = options;

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

            // Step 1: Check RuntimeRegistry for agents bound to a LocalRuntime (via roster.runtime_id)
            // This is the primary routing path for local agents running via local-runtime
            if (rosterEntry?.runtimeId) {
              // First try in-memory registry (works in local dev)
              const localRuntime = runtimeRegistry
                ? await runtimeRegistry.getRuntimeForAgent(agentId)
                : null;

              if (localRuntime) {
                // Runtime is online in-memory - route message through it
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
                  const mcpServers = await agentManager.getMcpConfigsForAgent(spaceId, channelId, authToken);

                  await localRuntime.activate({
                    agentId,
                    authToken,
                    systemPrompt,
                    mcpServers,
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

              // Fallback: No in-memory registry (Lambda) - look up runtime in DB and send via WebSocket
              // This is the key path for Lambda where in-memory state doesn't persist
              console.log(`[AgentInvoker] No in-memory registry, checking DB for runtime ${rosterEntry.runtimeId}`);
              const runtimeRecord = await storage.getRuntime(rosterEntry.runtimeId);

              if (!runtimeRecord) {
                console.warn(`[AgentInvoker] @${callsign}'s runtime (${rosterEntry.runtimeId}) not found in DB`);
                await broadcastAgentState(connectionManager, channelId, callsign, 'offline');
                return;
              }

              const runtimeConfig = runtimeRecord.config as LocalRuntimeConfig | null;
              const wsConnectionId = runtimeConfig?.wsConnectionId;

              if (runtimeRecord.status !== 'online' || !wsConnectionId) {
                // Runtime is offline - broadcast error to channel, message stays in DB for later
                console.warn(`[AgentInvoker] @${callsign}'s runtime (${rosterEntry.runtimeId}) is ${runtimeRecord.status}, wsConnectionId: ${wsConnectionId ?? 'none'}`);
                await broadcastAgentState(connectionManager, channelId, callsign, 'offline');
                return;
              }

              // Runtime is online - check if agent is already active
              if (!connectionManager) {
                console.error(`[AgentInvoker] No connectionManager available to send message`);
                await broadcastAgentState(connectionManager, channelId, callsign, 'offline');
                return;
              }

              const systemPrompt = await agentManager.buildPromptForAgent(spaceId, channelId, callsign);

              // Check if agent is online based on lastHeartbeat
              if (isAgentOnline(rosterEntry.lastHeartbeat)) {
                // Agent is already active - send message directly
                console.log(`[AgentInvoker] @${callsign} is online (lastHeartbeat: ${rosterEntry.lastHeartbeat}), sending message via WebSocket ${wsConnectionId}`);

                const deliverMessage: DeliverMessageMessage = {
                  type: 'message',
                  agentId,
                  messageId: message.id,
                  content: userMessage,
                  sender: message.sender,
                  systemPrompt,
                };

                try {
                  const result = (await connectionManager.send(
                    wsConnectionId,
                    JSON.stringify(deliverMessage)
                  )) as unknown as boolean | undefined;
                  if (result === false) {
                    console.warn(`[AgentInvoker] Failed to send message to @${callsign} (connection stale)`);
                    await broadcastAgentState(connectionManager, channelId, callsign, 'offline');
                    return;
                  }
                } catch (error) {
                  console.warn(`[AgentInvoker] Failed to send message to @${callsign}:`, error);
                  await broadcastAgentState(connectionManager, channelId, callsign, 'offline');
                  return;
                }

                // Update readmark and lastMessageRoutedAt after successful delivery
                const now = new Date().toISOString();
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  readmark: message.id,
                  lastMessageRoutedAt: now,
                });
                await broadcastAgentState(connectionManager, channelId, callsign, 'pending', now);
                console.log(`[AgentInvoker] Successfully sent message to @${callsign} via WebSocket`);
                return;
              }

              // Agent not active yet - send activate message
              console.log(`[AgentInvoker] @${callsign} not active (lastHeartbeat: ${rosterEntry.lastHeartbeat ?? 'none'}), sending activate via WebSocket ${wsConnectionId}`);
              await broadcastAgentState(connectionManager, channelId, callsign, 'connecting');

              const authToken = generateContainerToken({ spaceId, channelId, callsign });
              const mcpServers = await agentManager.getMcpConfigsForAgent(spaceId, channelId, authToken);

              // Workspace path is set by the runtime client, we don't control it from here
              const workspacePath = '/tmp/cast-agents';

              const activateMessage: ActivateAgentMessage = {
                type: 'activate',
                agentId,
                systemPrompt,
                mcpServers,
                workspacePath,
              };

              try {
                // connectionManager.send() may return Promise<boolean> (Postgres) or Promise<void> (local)
                // We handle both by catching errors and treating false as failure
                // Cast to allow checking boolean return from PostgresConnectionManager
                const result = (await connectionManager.send(
                  wsConnectionId,
                  JSON.stringify(activateMessage)
                )) as unknown as boolean | undefined;
                // PostgresConnectionManager returns false on stale connection
                if (result === false) {
                  console.warn(`[AgentInvoker] Failed to send activate to runtime ${rosterEntry.runtimeId} (connection stale)`);
                  await broadcastAgentState(connectionManager, channelId, callsign, 'offline');
                  return;
                }
              } catch (error) {
                // Local ConnectionManager throws on failure
                console.warn(`[AgentInvoker] Failed to send activate to runtime ${rosterEntry.runtimeId}:`, error);
                await broadcastAgentState(connectionManager, channelId, callsign, 'offline');
                return;
              }

              // Update lastMessageRoutedAt - message will be delivered when agent checks in
              const now = new Date().toISOString();
              await storage.updateRosterEntry(channelId, rosterEntry.id, {
                lastMessageRoutedAt: now,
              });
              console.log(`[AgentInvoker] Activated @${callsign} via WebSocket (will get message on checkin)`);
              return;
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
