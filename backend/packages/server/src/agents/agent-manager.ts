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
  /** Focus type slug for loading system.focus artifact */
  focusSlug?: string;
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

/**
 * Agent definition artifact (system.agent from #root)
 */
export interface AgentDefinition {
  slug: string;
  title?: string;
  tldr?: string;
  content: string;
  props?: {
    engine?: string;
    nameTheme?: string;
    mcp?: string[];
  };
}

/**
 * Focus type artifact (system.focus from #root)
 */
export interface FocusType {
  slug: string;
  title?: string;
  tldr?: string;
  content: string;
  props?: {
    defaultAgents?: Array<{ slug: string; role?: string }>;
    initialPrompt?: string;
  };
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
  /** Get agent definition by slug from #root */
  getAgentDefinition?: (spaceId: string, agentSlug: string) => Promise<AgentDefinition | null>;
  /** Get focus type by slug from #root */
  getFocusType?: (spaceId: string, focusSlug: string) => Promise<FocusType | null>;
}

// =============================================================================
// System Prompt Builder
// =============================================================================

/**
 * Full context for building a system prompt.
 */
export interface PromptContext {
  channel: ChannelContext;
  roster: RosterEntry[];
  callsign: string;
  agentDefinition?: AgentDefinition;
  focusType?: FocusType;
}

/**
 * Build a system prompt for an agent with full channel and role context.
 *
 * Assembly order (per spec):
 * 1. Channel Context (name, tagline, mission)
 * 2. Focus Type Instructions (if channel has focus)
 * 3. Your Role (agent definition content)
 * 4. Team Roster
 * 5. Channel Participation Instructions
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const { channel, roster, callsign, agentDefinition, focusType } = ctx;
  const sections: string[] = [];

  // 1. Channel Context
  sections.push(`## Channel Context

**Channel:** #${channel.name}
**Tagline:** ${channel.tagline ?? 'Open workspace'}
**Mission:** ${channel.mission ?? 'A flexible space for freeform collaboration and exploration.'}`);

  // 2. Focus Type Instructions (if channel has focus)
  if (focusType) {
    sections.push(`---

### Special Instructions
${focusType.content}`);
  }

  // 3. Your Role (from agent definition)
  if (agentDefinition) {
    sections.push(`## Your Role: ${agentDefinition.title ?? agentDefinition.slug}

${agentDefinition.content}`);
  } else {
    // Fallback if no agent definition found
    sections.push(`## Your Role

You are "${callsign}", an AI agent participating in #${channel.name}.`);
  }

  // 4. Team Roster (with titles from agent definitions if available)
  const rosterLines = roster.map((r) => `- @${r.callsign} (${r.agentType})`);
  if (rosterLines.length > 0) {
    sections.push(`---

## Team Roster

Your teammates in this channel:
${rosterLines.join('\n')}`);
  }

  // 5. Channel Participation Instructions (CAST-adapted per @ax feedback)
  sections.push(`---

## Channel Participation

You are "${callsign}", an AI agent in #${channel.name}.

Use @mentions to communicate:
• @callsign — notify a specific agent
• @channel — broadcast to all agents
Messages without @mentions are logged but won't notify anyone.

Use \`set_status\` frequently to show what you're working on.

Keep comms effective and brief. A little personality is welcome—we're collaborating, not filing reports—but remember that verbose messages break focus and consume context windows.

## Collaboration Board

The channel has a shared **Board** for persistent work products—things that outlive chat messages. Use artifact tools to create specs, track tasks, log decisions, and share code.

### Artifact Types
- **doc** — Specs, plans, notes, documentation (default)
- **task** — Work items with status tracking (pending → in_progress → done/blocked)
- **decision** — Logged choices with rationale for future reference
- **code** — Code snippets, file references (syntax highlighted)

### Structure
Artifacts form a **tree** like a file system. Each has a slug and optional \`parentSlug\`, creating paths like \`/auth-system/api-spec\`. **Use the tree structure to organize work—don't dump everything into content.**

Example task breakdown (as shown by \`artifact_glob\`):
\`\`\`
/planning
/phase-1 :task (done)
  /setup-repo :task (done) @fox
  /setup-ci :task (done) @bear
/phase-2 :task (in_progress)
  /implement-api :task (done) @fox
  /implement-auth :task (in_progress) @bear
/phase-3 :task (pending)
  /write-tests :task (pending)
  /write-docs :task (pending)
\`\`\`

Each task is a separate artifact with its own status. The \`tldr\` field is the task description—keep \`content\` for details, notes, or empty. Use \`artifact_glob\` to see the tree, \`artifact_list\` to query with filters.

### Task Coordination
For tasks, use the \`artifact_update\` tool with compare-and-swap to **claim work atomically**:

\`\`\`
artifact_update({
  slug: "implement-login",
  changes: [
    { field: "status", old_value: "pending", new_value: "in_progress" },
    { field: "assignees", old_value: [], new_value: ["${callsign}"] }
  ]
})
\`\`\`

This prevents race conditions—if another agent claimed it first, your update fails and you can pick a different task. Always check the current state before claiming.

### Playbooks

The board may contain **playbook** artifacts (type: \`system.playbook\`) with workflows and guidelines relevant to your work. When you join a channel:
1. Use \`artifact_list\` with \`type: "system.playbook"\` to find playbooks—this returns summaries (slug, tldr) without full content
2. Review the \`tldr\` field to understand what each playbook covers
3. Use \`artifact_read\` to read the full content when a playbook becomes relevant to your current task

Playbooks contain valuable context and procedures—consult them before diving into work.

### Quick Reference
- \`artifact_create\` - Create new artifact (fails if exists, use \`replace: true\` to overwrite)
- \`artifact_read\` - Get full content and version history
- \`artifact_edit\` - Surgical find-replace on content
- \`artifact_update\` - Atomic field updates (status, assignees, labels)
- \`artifact_checkpoint\` - Snapshot a named version for review
- \`artifact_list\` / \`artifact_glob\` - Browse and search`);

  return sections.join('\n\n');
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
   * Build a full system prompt for an agent.
   * This is the centralized method for building prompts with full context.
   * Used by both spawn() and exposed for local agent routing.
   */
  async buildPromptForAgent(
    spaceId: string,
    channelId: string,
    callsign: string
  ): Promise<string> {
    // Get channel context and roster
    const channel = await this.config.getChannel(spaceId, channelId);
    if (!channel) {
      console.warn(`[AgentManager] Channel not found for prompt: ${channelId}`);
      return `You are "${callsign}", an AI agent.`;
    }

    const roster = await this.config.getRoster(spaceId, channelId);

    // Find this agent's roster entry to get agentType (definition slug)
    const rosterEntry = roster.find((r) => r.callsign === callsign);
    const agentType = rosterEntry?.agentType;

    // Fetch agent definition from #root (if config method provided)
    let agentDefinition: AgentDefinition | undefined;
    if (agentType && this.config.getAgentDefinition) {
      try {
        agentDefinition = (await this.config.getAgentDefinition(spaceId, agentType)) ?? undefined;
        if (agentDefinition) {
          console.log(`[AgentManager] Loaded agent definition: ${agentType}`);
        }
      } catch (err) {
        console.error(`[AgentManager] Error loading agent definition:`, err);
      }
    }

    // Fetch focus type from #root (if channel has focusSlug and config method provided)
    let focusType: FocusType | undefined;
    if (channel.focusSlug && this.config.getFocusType) {
      try {
        focusType = (await this.config.getFocusType(spaceId, channel.focusSlug)) ?? undefined;
        if (focusType) {
          console.log(`[AgentManager] Loaded focus type: ${channel.focusSlug}`);
        }
      } catch (err) {
        console.error(`[AgentManager] Error loading focus type:`, err);
      }
    }

    // Build and return the full system prompt
    return buildSystemPrompt({
      channel,
      roster,
      callsign,
      agentDefinition,
      focusType,
    });
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

    // Verify channel exists (needed for error handling)
    const channel = await this.config.getChannel(spaceId, channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    // Build system prompt using centralized method
    const systemPrompt = await this.buildPromptForAgent(spaceId, channelId, callsign);

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
