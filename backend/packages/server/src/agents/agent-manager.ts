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
  McpServerConfig,
} from '@cast/runtime';
import type { ArtifactSummary } from '@cast/core';
import { generateContainerToken } from '../auth/index.js';
import { getAppDefinition, type TokenSet } from '../apps/index.js';

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
  id: string;
  callsign: string;
  agentType: string;
  status: 'active' | 'inactive';
  tunnelHash?: string;
}

export interface AppSecrets {
  /** Get decrypted access token */
  getAccessToken: (spaceId: string, channelId: string, slug: string) => Promise<string | null>;
  /** Get decrypted refresh token */
  getRefreshToken: (spaceId: string, channelId: string, slug: string) => Promise<string | null>;
  /** Get secret metadata */
  getMetadata: (channelId: string, slug: string, key: string) => Promise<{ expiresAt?: string } | null>;
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
  /** Get a specific roster entry by callsign */
  getRosterByCallsign?: (channelId: string, callsign: string) => Promise<RosterEntry | null>;
  /** Get system.app artifacts for a channel (includes root) */
  getApps?: (spaceId: string, channelId: string) => Promise<ArtifactSummary[]>;
  /** App secrets accessor */
  appSecrets?: AppSecrets;
  /** Tunnel server URL for HTTP tunnel access (e.g., "https://tunnel.clanker.is") */
  tunnelServerUrl?: string;
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
  // NOTE: In-memory Map removed - Lambda doesn't preserve state between invocations.
  // Roster table (callbackUrl) is now the source of truth for running containers.
  // See invoker-adapter.ts for the routing logic.

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
   * Derive MCP configs from connected system.app artifacts.
   * For each connected app, generates MCP config using the app registry.
   */
  private async deriveMcpConfigsFromApps(
    spaceId: string,
    channelId: string
  ): Promise<McpServerConfig[]> {
    const { getApps, appSecrets } = this.config;

    // Skip if app derivation not configured
    if (!getApps || !appSecrets) {
      return [];
    }

    const mcpConfigs: McpServerConfig[] = [];

    try {
      // Get all system.app artifacts for this channel (includes root)
      const apps = await getApps(spaceId, channelId);

      for (const app of apps) {
        // Get provider from props
        const provider = (app.props as Record<string, unknown> | undefined)?.provider as string | undefined;
        if (!provider) {
          console.log(`[AgentManager] Skipping app ${app.slug}: no provider in props`);
          continue;
        }

        // Get app definition from registry
        const appDef = getAppDefinition(provider);
        if (!appDef) {
          console.log(`[AgentManager] Skipping app ${app.slug}: unknown provider ${provider}`);
          continue;
        }

        // Check if connected (has accessToken secret)
        const accessTokenMeta = await appSecrets.getMetadata(app.channelId, app.slug, 'accessToken');
        if (!accessTokenMeta) {
          console.log(`[AgentManager] Skipping app ${app.slug}: not connected`);
          continue;
        }

        // Check if token expired (with 1 minute buffer)
        const bufferMs = 60 * 1000;
        const isExpired = accessTokenMeta.expiresAt &&
          new Date(accessTokenMeta.expiresAt).getTime() < Date.now() + bufferMs;

        if (isExpired) {
          console.log(`[AgentManager] Skipping app ${app.slug}: token expired`);
          // Note: In a more robust implementation, we would try to refresh here
          // For now, the user needs to reconnect or call /refresh manually
          continue;
        }

        // Get the access token
        const accessToken = await appSecrets.getAccessToken(spaceId, app.channelId, app.slug);
        if (!accessToken) {
          console.log(`[AgentManager] Skipping app ${app.slug}: failed to get access token`);
          continue;
        }

        // Get refresh token (optional)
        const refreshToken = await appSecrets.getRefreshToken(spaceId, app.channelId, app.slug);

        // Build token set
        const tokens: TokenSet = {
          accessToken,
          refreshToken: refreshToken ?? undefined,
          expiresAt: accessTokenMeta.expiresAt
            ? new Date(accessTokenMeta.expiresAt).getTime()
            : undefined,
        };

        // Get app settings from props
        const settings = (app.props as Record<string, unknown> | undefined)?.settings as
          | Record<string, unknown>
          | undefined;

        // Derive MCP config
        const derivedConfig = appDef.deriveMcp(tokens, settings);

        // Convert to McpServerConfig format
        const mcpConfig: McpServerConfig = {
          name: app.slug, // Use artifact slug as MCP name
          slug: app.slug,
          transport: derivedConfig.transport,
          command: derivedConfig.command,
          args: derivedConfig.args,
          env: derivedConfig.env,
          url: derivedConfig.url,
          headers: derivedConfig.headers,
        };

        mcpConfigs.push(mcpConfig);
        console.log(`[AgentManager] Derived MCP config for ${app.slug} (${provider})`);
      }
    } catch (error) {
      console.error('[AgentManager] Error deriving MCP configs from apps:', error);
      // Don't fail spawn if app derivation fails — just skip app MCPs
    }

    return mcpConfigs;
  }

  /**
   * Spawn a new container for an agent.
   * NOTE: No longer checks in-memory state - roster callbackUrl check happens in invoker-adapter.
   * This method just spawns unconditionally.
   */
  async spawn(
    spaceId: string,
    channelId: string,
    callsign: string
  ): Promise<ManagedAgent> {
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

    // Derive MCP configs from connected apps
    const appMcpConfigs = await this.deriveMcpConfigsFromApps(spaceId, channelId);
    if (appMcpConfigs.length > 0) {
      console.log(`[AgentManager] Derived ${appMcpConfigs.length} MCP configs from connected apps`);
    }

    // Get tunnel hash from roster entry (if available)
    let tunnelHash: string | undefined;
    if (this.config.getRosterByCallsign) {
      const rosterEntry = await this.config.getRosterByCallsign(channelId, callsign);
      tunnelHash = rosterEntry?.tunnelHash;
      if (tunnelHash) {
        console.log(`[AgentManager] Tunnel hash found for ${callsign}: ${tunnelHash.substring(0, 8)}...`);
      }
    }

    // Spawn container
    const spawnOptions: ContainerSpawnOptions = {
      spaceId,
      channelId,
      callsign,
      authToken,
      systemPrompt,
      mcpServers: appMcpConfigs.length > 0 ? appMcpConfigs : undefined,
      tunnelHash,
      tunnelServerUrl: this.config.tunnelServerUrl,
    };

    const containerState = await this.config.orchestrator.spawn(spawnOptions);

    const agent: ManagedAgent = {
      callsign,
      channelId,
      spaceId,
      state: 'idle',
      containerState,
    };

    console.log(`[AgentManager] Agent ${callsign} spawned, port ${containerState.port}`);

    return agent;
  }

  /**
   * Spawn a container and send a message to it.
   * NOTE: This always spawns - the invoker-adapter handles the "check roster first" logic.
   * The message is NOT pushed directly here - it's saved to storage, and the container
   * will receive it via the pending message queue when it checks in.
   */
  async sendMessage(
    spaceId: string,
    channelId: string,
    callsign: string,
    sender: string,
    content: string
  ): Promise<void> {
    // Spawn container - it will checkin and receive pending messages
    await this.spawn(spaceId, channelId, callsign);

    // Note: We don't push the message here. The message is already saved to storage
    // by the message handler. The container will receive it via getPendingMessages
    // when it calls /agents/checkin.
    console.log(`[AgentManager] Container spawned for ${callsign}, will receive message via checkin`);
  }

  /**
   * Stop an agent's container.
   * NOTE: With roster as source of truth, you should also clear callbackUrl in roster.
   */
  async stop(spaceId: string, channelId: string, callsign: string): Promise<void> {
    const threadId = this.buildThreadId(spaceId, channelId, callsign);
    await this.config.orchestrator.stop(threadId, 'manual');
    console.log(`[AgentManager] Agent ${callsign} stopped`);
    // Note: Caller should also clear callbackUrl in roster via storage.updateRosterEntry()
  }

  /**
   * Shutdown all containers managed by the orchestrator.
   */
  async shutdown(): Promise<void> {
    console.log('[AgentManager] Shutting down all agents...');
    await this.config.orchestrator.shutdown();
  }
}
