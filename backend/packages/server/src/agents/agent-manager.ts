/**
 * Agent Manager
 *
 * Manages agent lifecycle, @mention routing, and container spawning.
 * Coordinates between storage, container orchestrator, and WebSocket broadcast.
 */

import type {
  ContainerOrchestrator,
  ContainerSpawnOptions,
  ContainerState,
} from '@cast/runtime';
import { generateContainerToken } from '../auth/index.js';

// =============================================================================
// Types
// =============================================================================

export type AgentState = 'starting' | 'idle' | 'thinking' | 'stopped' | 'error';

export interface ManagedAgent {
  /** Agent callsign */
  callsign: string;
  /** Channel ID */
  channelId: string;
  /** Space ID */
  spaceId: string;
  /** Current lifecycle state */
  state: AgentState;
  /** Container state (if running) */
  containerState?: ContainerState;
}

export interface ChannelContext {
  id: string;
  name: string;
  tagline?: string;
  mission?: string;
}

export interface RosterEntry {
  callsign: string;
  agentType: string;
  status: 'active' | 'inactive';
}

export interface AgentManagerConfig {
  /** Container orchestrator (Docker for local, Fargate for prod) */
  orchestrator: ContainerOrchestrator;
  /** Broadcast function for WebSocket frames */
  broadcast: (channelId: string, frame: string) => Promise<void>;
  /** Get channel context for system prompt */
  getChannel: (spaceId: string, channelId: string) => Promise<ChannelContext | null>;
  /** Get roster for channel */
  getRoster: (spaceId: string, channelId: string) => Promise<RosterEntry[]>;
}

// =============================================================================
// System Prompt Builder
// =============================================================================

/**
 * Build a system prompt for an agent with channel context.
 */
export function buildSystemPrompt(
  channel: ChannelContext,
  roster: RosterEntry[],
  callsign: string
): string {
  const sections: string[] = [];

  // Channel Context
  sections.push(`## Channel Context

**Channel:** #${channel.name}
**Tagline:** ${channel.tagline ?? 'Open workspace'}
**Mission:** ${channel.mission ?? 'A flexible space for collaboration.'}`);

  // Your Role
  sections.push(`## Your Role

You are "${callsign}", an AI agent participating in #${channel.name}.`);

  // Team Roster
  const rosterLines = roster.map((r) => `- @${r.callsign} (${r.agentType})`);
  if (rosterLines.length > 0) {
    sections.push(`## Team Roster

Your teammates in this channel:
${rosterLines.join('\n')}`);
  }

  // Channel Participation Rules
  sections.push(`## Channel Participation

CRITICAL INSTRUCTIONS:
1. Always use @mentions when sending messages (e.g., @someone or @channel)
2. Messages without @mentions will NOT be delivered to other agents
3. Your callsign is "${callsign}" - this is how others will @mention you
4. Collaborate with other agents and humans in the channel

When you want to communicate:
- @someone - Direct message to a specific agent or human
- @channel - Broadcast to all agents in the channel

WHEN NOT TO RESPOND:
- If you have nothing meaningful to add, stay quiet
- Don't respond just to acknowledge
- If someone else is better suited to answer, let them handle it
- When a task is complete, say so briefly and stop

Keep comms effective and brief.`);

  return sections.join('\n\n---\n\n');
}

// =============================================================================
// Agent Manager
// =============================================================================

export class AgentManager {
  private config: AgentManagerConfig;
  private agents: Map<string, ManagedAgent> = new Map(); // threadId -> agent

  constructor(config: AgentManagerConfig) {
    this.config = config;
    console.log('[AgentManager] Initialized');
  }

  /**
   * Build a thread ID from space, channel, and callsign.
   */
  private buildThreadId(spaceId: string, channelId: string, callsign: string): string {
    return `${spaceId}:${channelId}:${callsign}`;
  }

  /**
   * Get or spawn an agent for the given context.
   */
  async getOrSpawn(
    spaceId: string,
    channelId: string,
    callsign: string
  ): Promise<ManagedAgent> {
    const threadId = this.buildThreadId(spaceId, channelId, callsign);

    // Check if already managed
    let agent = this.agents.get(threadId);
    if (agent && agent.state !== 'stopped' && agent.state !== 'error') {
      // Verify container is still running
      if (this.config.orchestrator.isRunning(threadId)) {
        return agent;
      }
      // Container died, need to respawn
      agent.state = 'stopped';
    }

    // Need to spawn
    console.log(`[AgentManager] Spawning agent ${callsign} in ${channelId}`);

    // Get channel context and roster for system prompt
    const channel = await this.config.getChannel(spaceId, channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    const roster = await this.config.getRoster(spaceId, channelId);

    // Build system prompt
    const systemPrompt = buildSystemPrompt(channel, roster, callsign);

    // Generate auth token
    const authToken = generateContainerToken({ spaceId, channelId, callsign });

    // Spawn container
    const spawnOptions: ContainerSpawnOptions = {
      spaceId,
      channelId,
      callsign,
      authToken,
      systemPrompt,
    };

    const containerState = await this.config.orchestrator.spawn(spawnOptions);

    // Create managed agent
    agent = {
      callsign,
      channelId,
      spaceId,
      state: 'idle',
      containerState,
    };

    this.agents.set(threadId, agent);
    console.log(`[AgentManager] Agent ${callsign} spawned, port ${containerState.port}`);

    return agent;
  }

  /**
   * Send a message to an agent.
   * Spawns the agent if not running.
   */
  async sendMessage(
    spaceId: string,
    channelId: string,
    callsign: string,
    sender: string,
    content: string
  ): Promise<void> {
    const agent = await this.getOrSpawn(spaceId, channelId, callsign);
    const threadId = this.buildThreadId(spaceId, channelId, callsign);

    // Format message with sender context
    const userMessage = `Message from @${sender}: ${content}`;

    // Update state
    agent.state = 'thinking';

    try {
      // Send to container
      await this.config.orchestrator.sendMessage(threadId, userMessage);
      agent.state = 'idle';
    } catch (error) {
      agent.state = 'error';
      console.error(`[AgentManager] Error sending to ${callsign}:`, error);
      throw error;
    }
  }

  /**
   * Stop an agent.
   */
  async stop(spaceId: string, channelId: string, callsign: string): Promise<void> {
    const threadId = this.buildThreadId(spaceId, channelId, callsign);
    const agent = this.agents.get(threadId);

    if (agent) {
      agent.state = 'stopped';
      await this.config.orchestrator.stop(threadId, 'manual');
      this.agents.delete(threadId);
      console.log(`[AgentManager] Agent ${callsign} stopped`);
    }
  }

  /**
   * Get agent status.
   */
  getStatus(spaceId: string, channelId: string, callsign: string): ManagedAgent | null {
    const threadId = this.buildThreadId(spaceId, channelId, callsign);
    return this.agents.get(threadId) ?? null;
  }

  /**
   * Get all running agents in a channel.
   */
  getChannelAgents(channelId: string): ManagedAgent[] {
    return Array.from(this.agents.values()).filter((a) => a.channelId === channelId);
  }

  /**
   * Shutdown all agents.
   */
  async shutdown(): Promise<void> {
    console.log('[AgentManager] Shutting down all agents...');
    await this.config.orchestrator.shutdown();
    this.agents.clear();
  }
}
