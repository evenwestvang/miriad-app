/**
 * Channel Model
 *
 * A channel is an evolved thread that supports multiple agents.
 * For backward compatibility, a single-agent thread is just a channel with one agent.
 */

// =============================================================================
// Types
// =============================================================================

export interface AgentInstance {
  /** Unique callsign for this agent in the channel */
  callsign: string;
  /** Agent type (e.g., "simple", "weather", "claude-code") */
  agentType: string;
  /** Current status */
  status: "idle" | "running" | "error";
  /** Order in roster (lower = earlier, leader is typically 0) */
  order: number;
}

export interface ChannelState {
  /** Channel identifier (same as threadId for compatibility) */
  channelId: string;
  /** Human-readable channel name */
  name?: string;
  /** Agents in this channel */
  agents: AgentInstance[];
  /** Callsign of the channel leader (receives unaddressed human messages) */
  leader: string;
  /** Channel status */
  status: "active" | "archived";
  /** Creation timestamp */
  createdAt: string;
  /** Last activity timestamp */
  updatedAt: string;
}

// =============================================================================
// Channel Storage
// =============================================================================

export class ChannelStorage {
  private channels: Map<string, ChannelState> = new Map();

  /**
   * Get a channel by ID.
   */
  async getChannel(channelId: string): Promise<ChannelState | null> {
    return this.channels.get(channelId) ?? null;
  }

  /**
   * Create a new channel with initial agents.
   */
  async createChannel(
    channelId: string,
    agents: Array<{ callsign: string; agentType: string }>,
    options?: { name?: string; leader?: string }
  ): Promise<ChannelState> {
    const now = new Date().toISOString();

    const agentInstances: AgentInstance[] = agents.map((a, index) => ({
      callsign: a.callsign,
      agentType: a.agentType,
      status: "idle",
      order: index,
    }));

    // Default leader is first agent
    const leader = options?.leader ?? agents[0]?.callsign ?? "";

    const channel: ChannelState = {
      channelId,
      name: options?.name,
      agents: agentInstances,
      leader,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };

    this.channels.set(channelId, channel);
    return channel;
  }

  /**
   * Add an agent to an existing channel.
   */
  async addAgent(
    channelId: string,
    callsign: string,
    agentType: string
  ): Promise<AgentInstance | null> {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    // Check for duplicate callsign
    if (channel.agents.some((a) => a.callsign === callsign)) {
      throw new Error(`Callsign "${callsign}" already exists in channel`);
    }

    const agent: AgentInstance = {
      callsign,
      agentType,
      status: "idle",
      order: channel.agents.length,
    };

    channel.agents.push(agent);
    channel.updatedAt = new Date().toISOString();
    return agent;
  }

  /**
   * Remove an agent from a channel.
   */
  async removeAgent(channelId: string, callsign: string): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    const index = channel.agents.findIndex((a) => a.callsign === callsign);
    if (index === -1) return false;

    channel.agents.splice(index, 1);
    channel.updatedAt = new Date().toISOString();

    // If leader was removed, promote next agent
    if (channel.leader === callsign && channel.agents.length > 0) {
      channel.leader = channel.agents[0].callsign;
    }

    return true;
  }

  /**
   * Update an agent's status.
   */
  async updateAgentStatus(
    channelId: string,
    callsign: string,
    status: AgentInstance["status"]
  ): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    const agent = channel.agents.find((a) => a.callsign === callsign);
    if (agent) {
      agent.status = status;
      channel.updatedAt = new Date().toISOString();
    }
  }

  /**
   * Set the channel leader.
   */
  async setLeader(channelId: string, callsign: string): Promise<boolean> {
    const channel = this.channels.get(channelId);
    if (!channel) return false;

    // Verify callsign exists in channel
    if (!channel.agents.some((a) => a.callsign === callsign)) {
      return false;
    }

    channel.leader = callsign;
    channel.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Get roster for routing.
   */
  getRoster(channelId: string): { agents: string[]; leader: string } | null {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    return {
      agents: channel.agents.map((a) => a.callsign),
      leader: channel.leader,
    };
  }

  /**
   * Get agent by callsign.
   */
  getAgent(channelId: string, callsign: string): AgentInstance | null {
    const channel = this.channels.get(channelId);
    if (!channel) return null;

    return channel.agents.find((a) => a.callsign === callsign) ?? null;
  }

  /**
   * List all channels.
   */
  async listChannels(): Promise<ChannelState[]> {
    return Array.from(this.channels.values());
  }
}

// Singleton instance
export const channelStorage = new ChannelStorage();
