/**
 * Channel Handler Functions
 *
 * Platform-agnostic business logic for channel operations.
 * Used by both local server and AWS Lambda handlers.
 */

import { ulid } from 'ulid';
import type {
  Channel,
  CreateChannelInput,
  AddAgentInput,
  RosterEntry,
  FocusProps,
  ResolvedFocus,
  ChannelStorage,
  ChannelHandlerContext,
  AgentEngine,
} from './types.js';
import type { ArtifactReader, ResolvedAgentDefinition } from '../agents/types.js';
import {
  resolveAgentDefinition,
  resolveMcpConfigs,
  type ResolveAgentOptions,
} from '../agents/resolve.js';

// =============================================================================
// Focus Area Resolution
// =============================================================================

/**
 * Resolve a focus area configuration from a system.focus artifact.
 *
 * @param reader - Artifact reader for looking up the focus
 * @param rootChannelId - Root channel where focus artifacts live
 * @param focusSlug - The focus area slug to resolve
 * @param overrides - Optional overrides for tagline/mission
 */
export async function resolveFocusArea(
  reader: ArtifactReader,
  rootChannelId: string,
  focusSlug: string,
  overrides?: { tagline?: string; mission?: string }
): Promise<ResolvedFocus | null> {
  const result = reader.read(rootChannelId, focusSlug);
  const artifact = result instanceof Promise ? await result : result;

  if (!artifact || artifact.type !== 'system.focus') {
    return null;
  }

  const props = artifact.props as FocusProps | undefined;

  return {
    tagline: overrides?.tagline ?? props?.defaultTagline,
    mission: overrides?.mission ?? props?.defaultMission,
    agents: props?.agents ?? [],
    leader: props?.leader ?? props?.agents?.[0],
    initialPrompt: props?.initialPrompt,
  };
}

// =============================================================================
// Channel Creation
// =============================================================================

export interface CreateChannelOptions {
  /** Artifact reader for focus/agent resolution */
  artifactReader: ArtifactReader;
  /** Root channel ID for artifact lookups */
  rootChannelId?: string;
  /** Options for agent resolution */
  resolveOptions?: ResolveAgentOptions;
}

export interface CreateChannelResult {
  channel: Channel;
  spawnedAgents: string[];
  initialPromptPosted: boolean;
}

/**
 * Create a new channel with focus area support.
 *
 * If a focusSlug is provided, resolves the focus area to get:
 * - Default tagline/mission (if not overridden)
 * - Agents to spawn
 * - Initial prompt to post
 *
 * @param ctx - Handler context with storage and spaceId
 * @param input - Channel creation input
 * @param options - Options for artifact resolution
 */
export async function createChannel(
  ctx: ChannelHandlerContext,
  input: CreateChannelInput,
  options: CreateChannelOptions
): Promise<CreateChannelResult> {
  const { storage, spaceId } = ctx;
  const { artifactReader, rootChannelId, resolveOptions } = options;

  // Resolve focus area if provided
  let focus: ResolvedFocus | null = null;
  if (input.focusSlug && rootChannelId) {
    focus = await resolveFocusArea(artifactReader, rootChannelId, input.focusSlug, {
      tagline: input.tagline,
      mission: input.mission,
    });
  }

  // Create the channel
  const channelId = ulid();
  const channel = await storage.createChannel(spaceId, {
    id: channelId,
    name: input.name,
    description: input.description,
    focusSlug: input.focusSlug,
    tagline: focus?.tagline ?? input.tagline,
    mission: focus?.mission ?? input.mission,
    leader: focus?.leader,
  });

  // Spawn agents from focus definition
  const spawnedAgents: string[] = [];
  if (focus && focus.agents.length > 0) {
    for (const agentSlug of focus.agents) {
      const agentDef = await resolveAgentDefinition(
        artifactReader,
        channelId,
        agentSlug,
        { rootChannelId, ...resolveOptions }
      );

      if (agentDef) {
        const callsign = agentDef.agentName || agentSlug;

        // Resolve MCP servers if referenced
        const mcpServers = agentDef.mcp && agentDef.mcp.length > 0
          ? await resolveMcpConfigs(
              artifactReader,
              channelId,
              agentDef.mcp,
              { rootChannelId, ...resolveOptions }
            )
          : undefined;

        // Add to roster
        const rosterEntry: RosterEntry = {
          id: callsign,
          name: agentDef.name,
          type: 'agent',
          status: 'online',
          joinedAt: new Date().toISOString(),
          agentConfig: {
            agentName: agentSlug,
            engine: (agentDef.engine || 'claude-code') as AgentEngine,
            model: agentDef.model,
            system: agentDef.content,
            mcpServers: mcpServers?.length ? mcpServers : undefined,
          },
          systemPrompt: agentDef.content,
        };

        await storage.addToRoster(spaceId, channelId, rosterEntry);
        spawnedAgents.push(callsign);
      }
    }
  }

  // Post initial prompt if defined
  let initialPromptPosted = false;
  if (focus?.initialPrompt) {
    const messageId = ulid();
    await storage.saveMessage(spaceId, {
      id: messageId,
      channelId,
      sender: 'system',
      senderType: 'user',
      type: 'user',
      content: focus.initialPrompt,
      timestamp: new Date().toISOString(),
      isComplete: true,
    });
    initialPromptPosted = true;
  }

  return { channel, spawnedAgents, initialPromptPosted };
}

// =============================================================================
// Channel Queries
// =============================================================================

/**
 * Get a channel by ID
 */
export async function getChannel(
  ctx: ChannelHandlerContext,
  channelId: string
): Promise<{ channel: Channel; roster: RosterEntry[] } | null> {
  const { storage, spaceId } = ctx;

  const channel = await storage.getChannel(spaceId, channelId);
  if (!channel) {
    return null;
  }

  const roster = await storage.getRoster(spaceId, channelId);
  return { channel, roster };
}

/**
 * List all channels in the space
 */
export async function listChannels(
  ctx: ChannelHandlerContext
): Promise<Channel[]> {
  return ctx.storage.listChannels(ctx.spaceId);
}

/**
 * Archive a channel
 */
export async function archiveChannel(
  ctx: ChannelHandlerContext,
  channelId: string
): Promise<void> {
  await ctx.storage.updateChannelStatus(ctx.spaceId, channelId, 'archived');
}

// =============================================================================
// Roster Management
// =============================================================================

export interface AddAgentOptions {
  artifactReader: ArtifactReader;
  rootChannelId?: string;
  resolveOptions?: ResolveAgentOptions;
}

export interface AddAgentResult {
  entry: RosterEntry;
  agentDef: ResolvedAgentDefinition | undefined;
}

/**
 * Add an agent to a channel's roster.
 *
 * @param ctx - Handler context
 * @param channelId - Channel to add agent to
 * @param input - Agent type and callsign
 * @param options - Options for agent resolution
 */
export async function addAgentToChannel(
  ctx: ChannelHandlerContext,
  channelId: string,
  input: AddAgentInput,
  options: AddAgentOptions
): Promise<AddAgentResult> {
  const { storage, spaceId, broadcast } = ctx;
  const { artifactReader, rootChannelId, resolveOptions } = options;

  // Check if callsign already exists
  const roster = await storage.getRoster(spaceId, channelId);
  const existing = roster.find(
    (entry) => entry.name.toLowerCase() === input.callsign.toLowerCase()
  );
  if (existing) {
    throw new Error(`Callsign "${input.callsign}" already exists in this channel`);
  }

  // Resolve agent definition
  const agentDef = await resolveAgentDefinition(
    artifactReader,
    channelId,
    input.agentType,
    { rootChannelId, ...resolveOptions }
  );

  // Resolve MCP servers if agent definition has mcp refs
  const mcpServers = agentDef?.mcp && agentDef.mcp.length > 0
    ? await resolveMcpConfigs(
        artifactReader,
        channelId,
        agentDef.mcp,
        { rootChannelId, ...resolveOptions }
      )
    : undefined;

  // Create roster entry
  const entry: RosterEntry = {
    id: input.callsign,
    name: input.callsign,
    type: 'agent',
    status: 'online',
    joinedAt: new Date().toISOString(),
    agentConfig: {
      agentName: input.agentType,
      engine: agentDef?.engine as AgentEngine | undefined,
      model: agentDef?.model,
      system: agentDef?.content,
      mcpServers: mcpServers?.length ? mcpServers : undefined,
    },
    systemPrompt: agentDef?.content,
  };

  await storage.addToRoster(spaceId, channelId, entry);

  // Broadcast agent joined event
  if (broadcast) {
    const frame = JSON.stringify({
      i: `agent:${entry.id}`,
      t: entry.joinedAt,
      v: {
        type: 'roster',
        action: 'agent_joined',
        agent: {
          callsign: input.callsign,
          agentType: input.agentType,
          status: 'idle',
        },
      },
    });
    await broadcast(channelId, frame);
  }

  return { entry, agentDef };
}

/**
 * Remove an agent from a channel's roster.
 *
 * @param ctx - Handler context
 * @param channelId - Channel to remove agent from
 * @param callsign - Agent callsign to remove
 * @param options - Options including whether to check for leader protection
 */
export async function removeAgentFromChannel(
  ctx: ChannelHandlerContext,
  channelId: string,
  callsign: string,
  options?: { protectLeader?: boolean }
): Promise<void> {
  const { storage, spaceId, broadcast } = ctx;
  const protectLeader = options?.protectLeader ?? true;

  // Find agent in roster
  const roster = await storage.getRoster(spaceId, channelId);
  const agent = roster.find(
    (entry) => entry.name.toLowerCase() === callsign.toLowerCase() && entry.type === 'agent'
  );

  if (!agent) {
    throw new Error(`Agent "${callsign}" not found in roster`);
  }

  // Check if this is the channel leader
  if (protectLeader) {
    const channel = await storage.getChannel(spaceId, channelId);
    const isLeader = channel?.leader?.toLowerCase() === callsign.toLowerCase() ||
                     roster[0]?.id === agent.id;
    if (isLeader) {
      throw new Error('Cannot dismiss the channel leader');
    }
  }

  // Remove from roster
  await storage.removeFromRoster(spaceId, channelId, agent.id);

  // Broadcast agent dismissed event
  if (broadcast) {
    const frame = JSON.stringify({
      i: `agent:${agent.id}`,
      t: new Date().toISOString(),
      v: {
        type: 'roster',
        action: 'agent_dismissed',
        agent: {
          callsign: agent.name,
          agentType: agent.agentConfig?.agentName,
        },
      },
    });
    await broadcast(channelId, frame);
  }
}
