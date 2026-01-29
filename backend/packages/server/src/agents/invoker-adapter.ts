/**
 * AgentInvoker Adapter
 *
 * Routes messages to agents - either directly to running containers (via callbackUrl
 * in roster) or by spawning new containers via the orchestrator.
 *
 * This is the integration point between message routing and agent lifecycle.
 * The roster table in PlanetScale is the source of truth for container state.
 */

import type { AgentManager } from "./agent-manager.js";
import type { Storage, MessageDeliveryContext } from "@cast/storage";
import type { LocalRuntimeConfig } from "@cast/core";
import type { ConnectionManager } from "../websocket/index.js";
import type { AgentInvoker, Message } from "../handlers/messages.js";
import type { DeliverMessageMessage } from "../runtimes/runtime-protocol-handlers.js";
import {
  pushMessagesToContainer,
  broadcastAgentState,
} from "../handlers/checkin.js";
import { generateContainerToken } from "../auth/index.js";
import { buildSystemPrompt } from "./agent-manager.js";

/**
 * Convert message content to string for agent consumption.
 * Text messages are already strings, structured messages (like status) are JSON-stringified.
 */
function contentToString(content: string | Record<string, unknown>): string {
  return typeof content === "string" ? content : JSON.stringify(content);
}

/**
 * Format attachment slugs as text appendix for agent messages.
 * Uses [[slug]] syntax which agents recognize as artifact references.
 */
function formatAttachments(attachmentSlugs: string[] | undefined): string {
  if (!attachmentSlugs || attachmentSlugs.length === 0) {
    return "";
  }
  const slugRefs = attachmentSlugs.map((slug) => `[[${slug}]]`).join(" ");
  return `\n\n<attachments>${slugRefs}</attachments>`;
}

/**
 * Build the user message string for agent consumption, including any attachments.
 */
function buildUserMessage(message: Message): string {
  const content = contentToString(message.content);
  const attachmentSlugs = message.metadata?.attachmentSlugs as string[] | undefined;
  return `Message from @${message.sender}: ${content}${formatAttachments(attachmentSlugs)}`;
}

/**
 * Build system prompt from pre-fetched context.
 * Uses the batch-fetched MessageDeliveryContext to avoid per-agent queries.
 */
function buildPromptFromContext(
  context: MessageDeliveryContext,
  channelId: string,
  callsign: string,
): string {
  // Get this agent's roster entry to find the agentType (definition slug)
  const agentData = context.agents.get(callsign);
  const agentType = agentData?.roster.agentType;

  // Find agent definition - prefer channel-specific over root
  let agentDefinition: { slug: string; title?: string; content: string } | undefined;
  if (agentType) {
    const definitions = context.definitions.get(agentType);
    if (definitions && definitions.length > 0) {
      // Prefer channel definition over root
      const def = definitions.find(d => d.channelId === channelId) ?? definitions[0];
      agentDefinition = {
        slug: def.slug,
        title: def.title ?? undefined,
        content: def.content,
      };
    }
  }

  // Map focus type data
  const focusType = context.focusType
    ? {
        slug: context.focusType.slug,
        content: context.focusType.content,
      }
    : undefined;

  // Map channel context (handle null → undefined for optional fields)
  const channel = {
    id: context.channel.id,
    name: context.channel.name,
    tagline: context.channel.tagline ?? undefined,
    mission: context.channel.mission ?? undefined,
    focusSlug: context.channel.focusSlug ?? undefined,
  };

  // Map roster entries (fullRoster from context)
  const roster = context.fullRoster.map(r => ({
    id: r.id,
    callsign: r.callsign,
    agentType: r.agentType,
    status: r.status as "active" | "inactive",
  }));

  return buildSystemPrompt({
    channel,
    roster,
    callsign,
    agentDefinition,
    focusType,
    userCallsign: context.spaceOwnerCallsign ?? undefined,
  });
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
  /** WebSocket connection manager for broadcasting agent state to browser clients */
  connectionManager?: ConnectionManager;
  /** Send function for runtime WebSocket connections (different from client connectionManager) */
  runtimeSend?: (connectionId: string, data: string) => Promise<boolean>;
}

// =============================================================================
// Adapter
// =============================================================================

/**
 * Create an AgentInvoker that routes messages to agents.
 *
 * Flow for each target agent:
 * 1. If agent has runtimeId → route via WebSocket to LocalRuntime (DB lookup)
 * 2. If agent has callbackUrl → push directly to Fly.io container via HTTP
 * 3. Otherwise → spawn new container via AgentManager
 *
 * All paths use DB as source of truth - no in-memory state.
 * This ensures Lambda and local dev use identical routing logic.
 */
export function createAgentInvokerAdapter(
  options: AgentInvokerAdapterOptions,
): AgentInvoker {
  const { agentManager, storage, spaceId, connectionManager, runtimeSend } =
    options;

  return {
    invokeAgents: async (
      channelId: string,
      targets: string[],
      message: Message,
    ): Promise<void> => {
      if (targets.length === 0) {
        return;
      }

      console.log(
        `[AgentInvoker] Invoking ${targets.length} agent(s) for message ${message.id}:`,
        targets,
      );

      // =======================================================================
      // Phase 1: Batch fetch all context upfront
      // =======================================================================
      const context = await storage.getMessageDeliveryContext(
        spaceId,
        channelId,
        targets,
      );

      // Collect MCP slugs from agent definitions for batch fetch
      const mcpSlugs = new Set<string>();
      for (const [, agentData] of context.agents) {
        const agentType = agentData.roster.agentType;
        const definitions = context.definitions.get(agentType);
        if (!definitions || definitions.length === 0) continue;
        // Prefer channel definition over root
        const def = definitions.find(d => d.channelId === channelId) ?? definitions[0];
        const mcpRefs = (def.props?.mcp as Array<{ slug: string }>) ?? [];
        for (const ref of mcpRefs) {
          mcpSlugs.add(ref.slug);
        }
      }

      // Batch fetch MCP artifacts
      const mcpArtifacts = mcpSlugs.size > 0
        ? await storage.getMcpArtifactsBySlug(channelId, context.rootChannelId, [...mcpSlugs])
        : new Map();

      console.log(
        `[AgentInvoker] Context loaded: ${context.agents.size} agents, ${context.definitions.size} definitions, ${context.environments.length} env artifacts, ${mcpArtifacts.size} MCPs`,
      );

      // =======================================================================
      // Phase 2: Process each agent in parallel
      // =======================================================================
      const results = await Promise.allSettled(
        targets.map(async (callsign) => {
          try {
            // Get pre-fetched roster/runtime data
            const agentData = context.agents.get(callsign);
            const rosterEntry = agentData?.roster;
            const runtimeRecord = agentData?.runtime;

            // Check if agent is paused or archived - skip if so
            if (rosterEntry?.status === "paused") {
              console.log(
                `[AgentInvoker] Skipping @${callsign}: agent is paused`,
              );
              return;
            }
            if (rosterEntry?.status === "archived") {
              console.log(
                `[AgentInvoker] Skipping @${callsign}: agent is archived`,
              );
              return;
            }

            const agentId = `${spaceId}:${channelId}:${callsign}`;
            const userMessage = buildUserMessage(message);

            // Step 1: Check if agent is bound to a LocalRuntime (via roster.runtime_id)
            // Route via WebSocket to the runtime's connection
            if (rosterEntry?.runtimeId) {
              console.log(
                `[AgentInvoker] @${callsign} bound to LocalRuntime ${rosterEntry.runtimeId}`,
              );

              // Runtime record was pre-fetched in context
              if (!runtimeRecord) {
                console.warn(
                  `[AgentInvoker] @${callsign}'s runtime (${rosterEntry.runtimeId}) not found in DB`,
                );
                await broadcastAgentState(
                  connectionManager,
                  channelId,
                  callsign,
                  "offline",
                );
                return;
              }

              const runtimeConfig =
                runtimeRecord.config as LocalRuntimeConfig | null;
              const wsConnectionId = runtimeConfig?.wsConnectionId;

              if (runtimeRecord.status !== "online" || !wsConnectionId) {
                // Runtime is offline - broadcast error to channel, message stays in DB for later
                console.warn(
                  `[AgentInvoker] @${callsign}'s runtime (${rosterEntry.runtimeId}) is ${runtimeRecord.status}, wsConnectionId: ${wsConnectionId ?? "none"}`,
                );
                await broadcastAgentState(
                  connectionManager,
                  channelId,
                  callsign,
                  "offline",
                );
                return;
              }

              // Runtime is online - check if we have runtimeSend to deliver messages
              if (!runtimeSend) {
                console.error(
                  `[AgentInvoker] No runtimeSend available for LocalRuntime routing`,
                );
                await broadcastAgentState(
                  connectionManager,
                  channelId,
                  callsign,
                  "offline",
                );
                return;
              }

              // Build system prompt from pre-fetched context
              const systemPrompt = buildPromptFromContext(context, channelId, callsign);

              // LocalRuntime simplification: Always send 'message' type directly.
              // The AgentManager.deliverMessage() auto-activates if needed (lines 172-192).
              // This avoids the activate→checkin→fetch roundtrip that containerized agents need.
              // The local runtime process is always-on, so no cold start delay.
              console.log(
                `[AgentInvoker] @${callsign} bound to LocalRuntime, sending message directly via WebSocket ${wsConnectionId}`,
              );

              // Generate auth token and get MCP configs
              const authToken = generateContainerToken({
                spaceId,
                channelId,
                callsign,
              });
              const mcpServers = await agentManager.getMcpConfigsForAgent(
                spaceId,
                channelId,
                callsign,
                authToken,
              );
              console.log(
                `[AgentInvoker] @${callsign} MCP configs:`,
                JSON.stringify(mcpServers),
              );

              // Get agent definition props from pre-fetched context
              const agentType = rosterEntry.agentType;
              const definitions = context.definitions.get(agentType);
              const def = definitions?.find(d => d.channelId === channelId) ?? definitions?.[0];
              const props = def?.props as Record<string, unknown> | undefined;
              if (props) {
                console.log(
                  `[AgentInvoker] @${callsign} props:`,
                  JSON.stringify(props),
                );
              }

              // Resolve environment variables and secrets for this channel
              const environment = await agentManager.resolveEnvironment(
                spaceId,
                channelId,
              );

              // Add tunnel credentials to environment (per-agent, for cast-tunnel script)
              if (rosterEntry.tunnelHash) {
                environment.TUNNEL_HASH = rosterEntry.tunnelHash;
              }
              environment.CAST_AUTH_TOKEN = authToken;

              // Add platform-level secrets (Letta API key for engine: "letta" agents)
              const lettaApiKey = await storage.getSpaceSecretValue(
                spaceId,
                "letta_api_key",
              );
              if (lettaApiKey) {
                environment.LETTA_API_KEY = lettaApiKey;
              }

              const deliverMessage: DeliverMessageMessage = {
                type: "message",
                agentId,
                messageId: message.id,
                content: userMessage,
                sender: message.sender,
                systemPrompt,
                mcpServers,
                environment:
                  Object.keys(environment).length > 0 ? environment : undefined,
                props,
              };

              try {
                const result = await runtimeSend(
                  wsConnectionId,
                  JSON.stringify(deliverMessage),
                );
                if (result === false) {
                  console.warn(
                    `[AgentInvoker] Failed to send message to @${callsign} (connection stale)`,
                  );
                  await broadcastAgentState(
                    connectionManager,
                    channelId,
                    callsign,
                    "offline",
                  );
                  return;
                }
              } catch (error) {
                console.warn(
                  `[AgentInvoker] Failed to send message to @${callsign}:`,
                  error,
                );
                await broadcastAgentState(
                  connectionManager,
                  channelId,
                  callsign,
                  "offline",
                );
                return;
              }

              // Update readmark and lastMessageRoutedAt after successful delivery
              const now = new Date().toISOString();
              await storage.updateRosterEntry(channelId, rosterEntry.id, {
                readmark: message.id,
                lastMessageRoutedAt: now,
              });
              await broadcastAgentState(
                connectionManager,
                channelId,
                callsign,
                "pending",
                now,
              );
              console.log(
                `[AgentInvoker] Successfully sent message to @${callsign} via LocalRuntime WebSocket`,
              );
              return;
            }

            // Step 2: Check roster for existing callbackUrl (Fly.io container)
            // Note: rosterEntry already fetched at start of loop for status check
            if (rosterEntry?.callbackUrl) {
              // Container is running - push directly via HTTP
              console.log(
                `[AgentInvoker] @${callsign} has callbackUrl, pushing directly to ${rosterEntry.callbackUrl}`,
              );

              // Generate auth token for this agent (deterministic - same as container received at activate)
              const authToken = generateContainerToken({
                spaceId,
                channelId,
                callsign,
              });

              // Build system prompt from pre-fetched context
              const systemPrompt = buildPromptFromContext(context, channelId, callsign);

              // v3.0: Pass routeHints to be echoed as HTTP headers (for Fly.io routing, etc.)
              const success = await pushMessagesToContainer(
                rosterEntry.callbackUrl,
                userMessage,
                agentId,
                authToken,
                systemPrompt,
                rosterEntry.routeHints as Record<string, string> | null,
              );

              if (success) {
                // Update readmark and lastMessageRoutedAt after successful delivery
                const now = new Date().toISOString();
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  readmark: message.id,
                  lastMessageRoutedAt: now,
                });
                // Broadcast pending state - agent is now processing
                await broadcastAgentState(
                  connectionManager,
                  channelId,
                  callsign,
                  "pending",
                  now,
                );
                console.log(
                  `[AgentInvoker] Successfully pushed to @${callsign}, updated readmark to ${message.id}`,
                );
              } else {
                // Push failed - container may have died, clear callbackUrl and spawn new
                console.warn(
                  `[AgentInvoker] Push to @${callsign} failed, clearing callbackUrl and spawning new container`,
                );
                await storage.updateRosterEntry(channelId, rosterEntry.id, {
                  callbackUrl: undefined,
                });
                // Broadcast 'connecting' state before spawning
                await broadcastAgentState(
                  connectionManager,
                  channelId,
                  callsign,
                  "connecting",
                );
                // Fall through to spawn
                await agentManager.sendMessage(
                  spaceId,
                  channelId,
                  callsign,
                  message.sender,
                  contentToString(message.content),
                );
              }
            } else {
              // Step 3: No container running - spawn new one via AgentManager
              console.log(
                `[AgentInvoker] @${callsign} has no callbackUrl, spawning new container`,
              );
              // Broadcast 'connecting' state before spawning
              await broadcastAgentState(
                connectionManager,
                channelId,
                callsign,
                "connecting",
              );
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
                contentToString(message.content),
              );
              console.log(
                `[AgentInvoker] Spawned container for @${callsign} (will checkin and get pending messages)`,
              );
            }
          } catch (error) {
            console.error(
              `[AgentInvoker] Failed to invoke @${callsign}:`,
              error,
            );
            throw error;
          }
        }),
      );

      // Log any failures but don't throw - we want partial success
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        console.warn(
          `[AgentInvoker] ${failures.length}/${targets.length} agent invocations failed`,
        );
      }
    },
  };
}
