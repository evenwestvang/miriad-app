/**
 * Agent Manager
 *
 * Manages multiple Claude SDK agent instances within a single runtime process.
 * Handles agent lifecycle: activation, message routing, suspension.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { query, type SDKMessage, type Options } from '@anthropic-ai/claude-agent-sdk';
import { TymbalBridge } from './tymbal-bridge.js';
import type {
  AgentState,
  AgentStatus,
  ActivateAgentMessage,
  DeliverMessageMessage,
  SuspendAgentMessage,
  AgentFrameMessage,
  McpServerConfig,
} from './types.js';

// =============================================================================
// Types
// =============================================================================

interface AgentInstance {
  state: AgentState;
  bridge: TymbalBridge;
  messageQueue: DeliverMessageMessage[];
  isProcessing: boolean;
}

export interface AgentManagerConfig {
  /** Base path for agent workspaces */
  workspaceBasePath: string;
  /** Callback when agent sends a frame */
  onFrame: (message: AgentFrameMessage) => void;
  /** Callback when agent checks in (SDK ready) */
  onCheckin: (agentId: string) => void;
  /** Callback on agent error */
  onError?: (agentId: string, error: Error) => void;
}

// =============================================================================
// Agent ID Parsing
// =============================================================================

export function parseAgentId(agentId: string): {
  spaceId: string;
  channelId: string;
  callsign: string;
} {
  const parts = agentId.split(':');
  if (parts.length !== 3) {
    throw new Error(`Invalid agentId format: ${agentId}. Expected spaceId:channelId:callsign`);
  }
  return {
    spaceId: parts[0],
    channelId: parts[1],
    callsign: parts[2],
  };
}

// =============================================================================
// Agent Manager
// =============================================================================

export class AgentManager {
  private readonly config: AgentManagerConfig;
  private readonly agents = new Map<string, AgentInstance>();

  constructor(config: AgentManagerConfig) {
    this.config = config;
  }

  /**
   * Get all agents.
   */
  getAgents(): AgentState[] {
    return Array.from(this.agents.values()).map((instance) => instance.state);
  }

  /**
   * Get a specific agent's state.
   */
  getAgent(agentId: string): AgentState | null {
    return this.agents.get(agentId)?.state ?? null;
  }

  /**
   * Activate an agent (spawn Claude SDK).
   */
  async activate(message: ActivateAgentMessage): Promise<void> {
    const { agentId, systemPrompt, mcpServers, workspacePath } = message;
    const { callsign } = parseAgentId(agentId);

    console.log(`[AgentManager] Activating ${agentId}`);
    console.log(`[AgentManager]   mcpServers from message:`, JSON.stringify(mcpServers));

    // Check if already active
    const existing = this.agents.get(agentId);
    if (existing && existing.state.status !== 'offline') {
      console.log(`[AgentManager] Agent ${agentId} already active (${existing.state.status})`);
      return;
    }

    console.log(`[AgentManager] @${callsign} state: offline → activating`);

    // Always use local config basePath + agentId structure for security
    // (ignore workspacePath from backend to prevent arbitrary path access)
    const resolvedPath = join(this.config.workspaceBasePath, agentId.replace(/:/g, '/'));
    console.log(`[AgentManager] @${callsign} workspace config:`);
    console.log(`[AgentManager]   basePath: ${this.config.workspaceBasePath}`);
    console.log(`[AgentManager]   backend workspacePath (ignored): ${workspacePath || '(none)'}`);
    console.log(`[AgentManager]   resolved: ${resolvedPath}`);
    this.ensureWorkspace(resolvedPath);

    // Create bridge
    const bridge = new TymbalBridge({
      agentId,
      callsign,
      onFrame: this.config.onFrame,
    });

    // Create agent instance
    const instance: AgentInstance = {
      state: {
        agentId,
        status: 'activating',
        workspacePath: resolvedPath,
        systemPrompt,
        mcpServers,
        activatedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
      },
      bridge,
      messageQueue: [],
      isProcessing: false,
    };

    console.log(`[AgentManager]   Stored mcpServers in state:`, JSON.stringify(instance.state.mcpServers));
    this.agents.set(agentId, instance);

    // Signal checkin (SDK ready)
    // In a real implementation, we'd wait for SDK initialization
    // For now, we mark as online immediately after activation setup
    instance.state.status = 'online';
    instance.state.lastActivity = new Date().toISOString();
    this.config.onCheckin(agentId);

    console.log(`[AgentManager] @${callsign} state: activating → online`);
  }

  /**
   * Format a message with sender header.
   */
  private formatMessage(message: DeliverMessageMessage): string {
    return `--- @${message.sender} says:\n${message.content}`;
  }

  /**
   * Deliver a message to an agent.
   * Auto-activates the agent if it doesn't exist (local runtime is always-on).
   */
  async deliverMessage(message: DeliverMessageMessage): Promise<void> {
    const { agentId, systemPrompt, mcpServers } = message;
    let instance = this.agents.get(agentId);

    const { callsign } = parseAgentId(agentId);

    // Auto-activate agent if not found or offline (local runtime is always-on)
    if (!instance || instance.state.status === 'offline') {
      console.log(`[AgentManager] @${callsign} not active, auto-activating for message delivery`);
      if (mcpServers) {
        console.log(`[AgentManager] Auto-activation WITH mcpServers (count: ${mcpServers.length})`);
      } else {
        console.warn(`[AgentManager] WARNING: Auto-activation WITHOUT mcpServers!`);
      }
      await this.activate({
        type: 'activate',
        agentId,
        systemPrompt: systemPrompt || '',
        workspacePath: '', // Will be ignored, uses local config
        mcpServers, // Now passed from message
      });
      instance = this.agents.get(agentId);
      if (!instance) {
        console.error(`[AgentManager] Failed to auto-activate agent ${agentId}`);
        return;
      }
      console.log(`[AgentManager] @${callsign} auto-activated, proceeding with message`);
    }

    // Update mcpServers if provided in message (keeps config fresh even for online agents)
    if (mcpServers && instance) {
      console.log(`[AgentManager] Updating mcpServers for online agent @${callsign} (count: ${mcpServers.length})`);
      instance.state.mcpServers = mcpServers;
    }

    // Format message with sender header
    const formattedContent = this.formatMessage(message);

    // Queue message if already processing
    if (instance.isProcessing) {
      console.log(`[AgentManager] @${callsign} busy, queueing message`);
      instance.messageQueue.push(message);
      return;
    }

    // Process message (will transition to busy)
    console.log(`[AgentManager] @${callsign} calling processMessage with content length: ${formattedContent.length}`);
    await this.processMessage(instance, formattedContent, systemPrompt);
    console.log(`[AgentManager] @${callsign} processMessage returned`);
  }

  /**
   * Suspend an agent (tear down SDK).
   */
  async suspend(message: SuspendAgentMessage): Promise<void> {
    const { agentId, reason } = message;
    const instance = this.agents.get(agentId);

    if (!instance) {
      console.log(`[AgentManager] Agent ${agentId} not found for suspension`);
      return;
    }

    const { callsign } = parseAgentId(agentId);
    const oldStatus = instance.state.status;
    console.log(`[AgentManager] @${callsign} state: ${oldStatus} → offline (${reason ?? 'no reason'})`);

    // Update state
    instance.state.status = 'offline';
    instance.state.lastActivity = new Date().toISOString();

    // Clear message queue
    instance.messageQueue = [];
    instance.isProcessing = false;

    // Optionally remove from map (or keep for restart)
    // this.agents.delete(agentId);
  }

  /**
   * Suspend all agents (for shutdown).
   */
  async suspendAll(): Promise<void> {
    const agentIds = Array.from(this.agents.keys());
    for (const agentId of agentIds) {
      await this.suspend({ type: 'suspend', agentId, reason: 'runtime shutdown' });
    }
  }

  // ===========================================================================
  // Private Methods
  // ===========================================================================

  private ensureWorkspace(workspace: string): void {
    if (!existsSync(workspace)) {
      console.log(`[AgentManager] Creating workspace: ${workspace}`);
      mkdirSync(workspace, { recursive: true });
    }
  }

  private getClaudeConfigDir(workspace: string): string {
    return join(workspace, '.claude');
  }

  private hasExistingSession(workspace: string): boolean {
    return existsSync(this.getClaudeConfigDir(workspace));
  }

  private async processMessage(
    instance: AgentInstance,
    content: string,
    systemPrompt?: string
  ): Promise<void> {
    const { state, bridge } = instance;

    const { callsign } = parseAgentId(state.agentId);
    const oldStatus = instance.state.status;
    instance.isProcessing = true;
    instance.state.status = 'busy';
    instance.state.lastActivity = new Date().toISOString();
    console.log(`[AgentManager] @${callsign} state: ${oldStatus} → busy`);

    const workspace = state.workspacePath;
    const shouldContinue = this.hasExistingSession(workspace);
    const claudeConfigDir = this.getClaudeConfigDir(workspace);

    // Use updated system prompt if provided
    const prompt = systemPrompt ?? state.systemPrompt;

    console.log(`[AgentManager] Processing message for ${state.agentId}`);
    console.log(`[AgentManager] Working directory: ${workspace}`);
    console.log(`[AgentManager] Continue session: ${shouldContinue}`);

    const options: Options = {
      model: 'claude-opus-4-5-20251101',
      systemPrompt: prompt
        ? {
            type: 'preset',
            preset: 'claude_code',
            append: prompt,
          }
        : {
            type: 'preset',
            preset: 'claude_code',
          },
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      continue: shouldContinue,
      cwd: workspace,
      env: {
        // Filter out PWD/OLDPWD to prevent parent's cwd from leaking into subprocess
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !['PWD', 'OLDPWD'].includes(key))
        ),
        CLAUDE_CONFIG_DIR: claudeConfigDir,
      },
    };

    // Add MCP servers if configured (SDK expects Record<string, McpServerConfig>)
    if (state.mcpServers && state.mcpServers.length > 0) {
      console.log(`[AgentManager] Building MCP config from state.mcpServers (count: ${state.mcpServers.length})`);
      console.log(`[AgentManager]   state.mcpServers:`, JSON.stringify(state.mcpServers));
      // Build MCP servers config - use type assertion since SDK uses discriminated unions
      const mcpServers: Record<string, unknown> = {};
      for (const server of state.mcpServers) {
        if (server.transport === 'stdio') {
          mcpServers[server.name] = {
            type: 'stdio' as const,
            command: server.command,
            args: server.args,
            env: server.env,
            cwd: server.cwd,
          };
        } else if (server.transport === 'sse' || server.transport === 'http') {
          mcpServers[server.name] = {
            type: server.transport as 'sse' | 'http',
            url: server.url,
            headers: server.headers,
          };
        }
      }
      if (Object.keys(mcpServers).length > 0) {
        console.log(`[AgentManager]   Built SDK mcpServers:`, JSON.stringify(mcpServers));
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options.mcpServers = mcpServers as any;
      }
    } else {
      console.warn(`[AgentManager] No MCP servers configured for ${state.agentId} (state.mcpServers: ${state.mcpServers})`);
    }

    try {
      const q = query({
        prompt: content,
        options,
      });

      for await (const message of q) {
        await bridge.processSDKMessage(message);
      }

      await bridge.finalize();
      console.log(`[AgentManager] Query completed for ${state.agentId}`);
    } catch (error) {
      console.error(`[AgentManager] Query error for ${state.agentId}:`, error);
      this.config.onError?.(state.agentId, error as Error);
    } finally {
      instance.isProcessing = false;
      instance.state.status = 'online';
      instance.state.lastActivity = new Date().toISOString();
      console.log(`[AgentManager] @${callsign} state: busy → online`);

      // Process queued messages as a batch (if any)
      await this.processQueue(instance);
    }
  }

  /**
   * Process the message queue for an agent.
   * Batches all queued messages into a single message to match sandbox behavior.
   */
  private async processQueue(instance: AgentInstance): Promise<void> {
    if (instance.messageQueue.length === 0) {
      return;
    }

    const { callsign } = parseAgentId(instance.state.agentId);

    // Batch all queued messages together
    const queuedMessages = [...instance.messageQueue];
    instance.messageQueue = []; // Clear the queue

    console.log(`[AgentManager] @${callsign} processing ${queuedMessages.length} queued messages as a batch`);

    // Format and combine all message contents with separator
    const combinedContent = queuedMessages.map(msg => this.formatMessage(msg)).join('\n\n');

    // Process as a single message (use first message's metadata)
    await this.processMessage(instance, combinedContent, queuedMessages[0].systemPrompt);
  }
}
