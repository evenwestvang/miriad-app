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
   * Deliver a message to an agent.
   * Auto-activates the agent if it doesn't exist (local runtime is always-on).
   */
  async deliverMessage(message: DeliverMessageMessage): Promise<void> {
    const { agentId, content, systemPrompt } = message;
    let instance = this.agents.get(agentId);

    const { callsign } = parseAgentId(agentId);

    // Auto-activate agent if not found or offline (local runtime is always-on)
    if (!instance || instance.state.status === 'offline') {
      console.log(`[AgentManager] @${callsign} not active, auto-activating for message delivery`);
      await this.activate({
        type: 'activate',
        agentId,
        systemPrompt: systemPrompt || '',
        workspacePath: '', // Will be ignored, uses local config
      });
      instance = this.agents.get(agentId);
      if (!instance) {
        console.error(`[AgentManager] Failed to auto-activate agent ${agentId}`);
        return;
      }
      console.log(`[AgentManager] @${callsign} auto-activated, proceeding with message`);
    }

    // Queue message if already processing
    if (instance.isProcessing) {
      console.log(`[AgentManager] @${callsign} busy, queueing message`);
      instance.messageQueue.push(message);
      return;
    }

    // Process message (will transition to busy)
    console.log(`[AgentManager] @${callsign} calling processMessage with content length: ${content.length}`);
    await this.processMessage(instance, content, systemPrompt);
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
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        options.mcpServers = mcpServers as any;
      }
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

      // Process next message in queue
      if (instance.messageQueue.length > 0) {
        const nextMessage = instance.messageQueue.shift()!;
        await this.processMessage(instance, nextMessage.content, nextMessage.systemPrompt);
      }
    }
  }
}
