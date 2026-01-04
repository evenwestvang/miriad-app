/**
 * Agent Manager
 *
 * Unified manager for coding agents across providers (Claude, Codex, etc.).
 * Uses the ProviderRegistry for engine lookup and delegates to provider implementations.
 *
 * Key features:
 * - Engine parameter in spawn() (default: 'claude')
 * - Provider lookup via registry
 * - Unified agent tracking with engine info
 * - Callbacks for state changes and output
 */

import {
  CodingAgentProvider,
  AgentHandle,
  AgentConfig,
  AgentState,
  AgentOutput,
  MCPServerConfig,
} from "./agent-provider.js";
import {
  ProviderRegistry,
  getDefaultRegistry,
  DEFAULT_ENGINE,
} from "./agent-registry.js";
import type { EngineCapabilities } from "../shared/engine-capabilities.js";
import {
  emitAgentOutput,
  emitAgentState,
} from "./firehose.js";
import { store, type McpReference, type ResolvedMcpConfig } from "./store.js";
import { resolveMcpConfigsWithOAuth } from "./oauth/index.js";

/**
 * Context for building agent system prompts.
 * Passed to spawn() to configure agent behavior.
 */
export interface SpawnContext {
  roleName?: string;
  roleInstructions?: string;
  playbookContent?: string;
  tagline?: string;
  mission?: string;
  specialInstructions?: string;
  roster?: { name: string; role: string }[];
  /** Engine type (e.g., "claude", "codex"). Defaults to "claude". */
  engine?: string;
  /** Model override for the engine. */
  model?: string;
/** MCP server references from system.agent props.mcp */
  mcp?: McpReference[];
  /** Initial prompt/task for the agent (injected into context, not visible in chat). */
  initialPrompt?: string;
}

/**
 * Agent info tracked by the manager.
 * Extends the basic handle with runtime state.
 */
export interface ManagedAgent {
  handle: AgentHandle;
  provider: CodingAgentProvider;
  state: AgentState;
  status?: string;
  startedAt: string;
  lastActivity: string;
  output: AgentOutput[];
  error?: string;
}

/**
 * Options for creating an AgentManager.
 */
export interface AgentManagerOptions {
  /** Callback when any agent's state changes */
  onStateChange?: (agent: ManagedAgent) => void;
  /** Custom provider registry (defaults to global registry) */
  registry?: ProviderRegistry;
  /** Path to defaults directory for loading external backends */
  defaultsDir?: string;
}

/**
 * Unified manager for coding agents.
 */
export class AgentManager {
  private agents = new Map<string, ManagedAgent>();
  private registry: ProviderRegistry;
  private onStateChange?: (agent: ManagedAgent) => void;

  constructor(options: AgentManagerOptions & { registry: ProviderRegistry }) {
    this.registry = options.registry;
    this.onStateChange = options.onStateChange;
  }

  /**
   * Create an AgentManager with the default provider registry.
   * Use this factory method for async initialization.
   *
   * @param options - Manager options including optional defaultsDir for external backends
   */
  static async create(options?: Omit<AgentManagerOptions, 'registry'>): Promise<AgentManager> {
    const registry = await getDefaultRegistry(options?.defaultsDir);
    return new AgentManager({ ...options, registry });
  }

  private getAgentKey(channel: string, name: string): string {
    return `${channel}:${name}`;
  }

  /**
   * Convert resolved MCP config to MCPServerConfig format.
   */
  private convertMcpConfig(mcp: ResolvedMcpConfig): MCPServerConfig {
    if (mcp.transport === "stdio") {
      return {
        type: "stdio",
        command: mcp.command,
        args: mcp.args,
        env: mcp.env,
        cwd: mcp.cwd,
      };
    } else {
      return {
        type: "http",
        url: mcp.url,
        headers: mcp.headers,
      };
    }
  }

  private addOutput(agent: ManagedAgent, output: AgentOutput): void {
    agent.output.push(output);
    agent.lastActivity = new Date().toISOString();
    // Keep only last 1000 outputs per agent
    if (agent.output.length > 1000) {
      agent.output = agent.output.slice(-1000);
    }
    this.onStateChange?.(agent);
  }

  private setState(agent: ManagedAgent, state: AgentState, status?: string): void {
    agent.state = state;
    if (status !== undefined) {
      agent.status = status;
    }
    agent.lastActivity = new Date().toISOString();
    this.onStateChange?.(agent);
  }

  /**
   * Build system prompt from spawn context.
   */
  private buildSystemPrompt(channel: string, name: string, context?: SpawnContext): string {
    const sections: string[] = [];

    // Channel context section - always include channel info with tagline/mission
    const channelContextLines: string[] = [
      `**Channel:** #${channel}`,
      `**Tagline:** ${context?.tagline || "Not set"}`,
      `**Mission:** ${context?.mission || "Not set"}`,
    ];
    sections.push(`## Channel Context\n\n${channelContextLines.join("\n")}`);

    // Initial task section - injected from focus initialPrompt (not visible in chat)
    if (context?.initialPrompt) {
      sections.push(`## Initial Task\n\n${context.initialPrompt}`);
    }

    // Additional channel configuration
    const channelParts: string[] = [];
    if (context?.playbookContent) {
      channelParts.push(`### Workflow\n${context.playbookContent}`);
    }
    if (context?.specialInstructions) {
      channelParts.push(`### Special Instructions\n${context.specialInstructions}`);
    }

    if (channelParts.length > 0) {
      sections.push(channelParts.join("\n\n"));
    }

    // Role section
    if (context?.roleName && context?.roleInstructions) {
      sections.push(`## Your Role: ${context.roleName}\n\n${context.roleInstructions}`);
    } else {
      sections.push(`## Your Role\n\nYou are a helpful assistant. Collaborate with the team and contribute where you can.`);
    }

    // Roster section
    if (context?.roster && context.roster.length > 0) {
      const rosterLines = context.roster.map(r => `- @${r.name} (${r.role})`).join("\n");
      sections.push(`## Team Roster\n\nYour teammates in this channel:\n${rosterLines}`);
    }

    // Channel participation section (always present)
    sections.push(`## Channel Participation

You are "${name}", an AI agent participating in a multi-agent chat channel called #${channel}.

CRITICAL INSTRUCTIONS:
1. Use the track_channel MCP tool to join #${channel} immediately
2. Always use @mentions when sending messages (e.g., @someone or @channel)
3. Messages without @mentions will NOT be delivered
4. Your callsign is "${name}" - use this when sending messages
5. Collaborate with other agents and humans in the channel
6. Set your status using set_status to show what you're working on

Keep comms effective and brief. A little personality is welcome—we're collaborating, not filing reports—but remember that verbose messages break focus and consume context windows.

## Workspace Rules

Each agent has their own private workspace directory. You MUST:
1. Stay in your root directory - do NOT cd into other directories or use absolute paths outside your workspace
2. Coordinate with teammates through chat unless given other means (e.g., shared repo, special tools)

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
    { field: "assignees", old_value: [], new_value: ["${name}"] }
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

    return sections.join("\n\n---\n\n");
  }

  /**
   * Spawn a new agent.
   *
   * @param channel - Channel the agent will participate in
   * @param name - Agent's callsign
   * @param mcpServerUrl - URL of the MCP server for tool access
   * @param context - Spawn context with role, playbook, etc.
   * @returns Result with success status and message
   */
  async spawn(
    channel: string,
    name: string,
    mcpServerUrl: string,
    context?: SpawnContext
  ): Promise<{ success: boolean; message: string }> {
    const key = this.getAgentKey(channel, name);

    if (this.agents.has(key)) {
      return { success: false, message: `Agent ${name} is already running in #${channel}` };
    }

    // Determine engine from context (default to claude)
    const engine = context?.engine || DEFAULT_ENGINE;

    // Look up provider
    const provider = this.registry.get(engine);
    if (!provider) {
      const available = this.registry.list().join(", ") || "none";
      return {
        success: false,
        message: `Unknown engine "${engine}". Available: ${available}`,
      };
    }

    // Build config for provider
    const slugify = (text: string) =>
      text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

    const workdir = `/tmp/powpow/${slugify(channel)}--${slugify(name)}`;

    // Start with built-in powpow MCP (always provided)
    const mcpServers: Record<string, MCPServerConfig> = {
      powpow: {
        type: "http",
        url: mcpServerUrl,
      },
    };

    // Resolve external MCP servers from system.agent props.mcp
    // Only add if engine supports MCP (check capabilities)
    // Uses OAuth-aware resolution that handles token refresh
    const engineCaps = this.registry.getCapabilities(engine);
    if (context?.mcp && context.mcp.length > 0) {
      if (engineCaps?.supportsMcp !== false) {
        const resolvedMcps = await resolveMcpConfigsWithOAuth(channel, context.mcp);
        for (const mcp of resolvedMcps) {
          mcpServers[mcp.slug] = this.convertMcpConfig(mcp);
        }
        console.error(`[agent-manager] Resolved ${resolvedMcps.length} external MCP servers for ${name}`);
      } else {
        console.error(`[agent-manager] Engine ${engine} does not support MCP, skipping ${context.mcp.length} configured MCPs`);
      }
    }

    const config: AgentConfig = {
      model: context?.model,
      systemPrompt: this.buildSystemPrompt(channel, name, context),
      workdir,
      mcpServers,
      permissions: "bypassPermissions",
      resume: true, // Try to resume if session exists
    };

    try {
      console.error(`[agent-manager] Spawning ${name} in #${channel} (engine: ${engine})`);

      const handle = await provider.spawn(channel, name, config);

      // Create managed agent
      const managedAgent: ManagedAgent = {
        handle,
        provider,
        state: "starting",
        startedAt: new Date().toISOString(),
        lastActivity: new Date().toISOString(),
        output: [],
      };

      this.agents.set(key, managedAgent);

      // Wire up provider callbacks
      provider.onOutput(handle, (output) => {
        this.addOutput(managedAgent, output);
        // Emit to firehose for SSE consumers
        emitAgentOutput(channel, name, engine, output);
      });

      provider.onStateChange(handle, (state, previousState) => {
        this.setState(managedAgent, state);
        // Emit to firehose for SSE consumers
        const pendingMessages = provider.getPendingMessageCount(handle);
        emitAgentState(channel, name, engine, state, previousState, pendingMessages);

        // Clean up on terminal states
        if (state === "stopped" || state === "error") {
          console.error(`[agent-manager] Agent ${name} in #${channel} ${state}`);
          this.agents.delete(key);
        }
      });

      // Send initial message to start the agent (skip for codex - it handles this in spawn)
      if (engine !== "codex") {
        setTimeout(async () => {
          try {
            await provider.sendMessage(
              handle,
              `Track channel #${channel} using the track_channel MCP tool and introduce yourself to the channel. Your name is ${name}.`
            );
          } catch (err) {
            console.error(`[agent-manager] Failed to send initial message to ${name}:`, err);
          }
        }, 1000);
      }

      return { success: true, message: `Spawned ${name} in #${channel} (${engine})` };
    } catch (err) {
      console.error(`[agent-manager] Failed to spawn ${name}:`, err);
      this.agents.delete(key);
      return { success: false, message: `Failed to spawn ${name}: ${err}` };
    }
  }

  /**
   * Send a message to an agent.
   */
  sendMessage(channel: string, name: string, content: string): boolean {
    const key = this.getAgentKey(channel, name);
    const managedAgent = this.agents.get(key);
    if (!managedAgent) return false;

    managedAgent.provider.sendMessage(managedAgent.handle, content).catch((err) => {
      console.error(`[agent-manager] Failed to send message to ${name}:`, err);
    });

    return true;
  }

  /**
   * Kick (terminate) an agent.
   */
  kick(channel: string, name: string): { success: boolean; message: string } {
    const key = this.getAgentKey(channel, name);
    const managedAgent = this.agents.get(key);

    if (!managedAgent) {
      return { success: false, message: `Agent ${name} is not running in #${channel}` };
    }

    console.error(`[agent-manager] Kicking ${name} from #${channel}`);
    managedAgent.provider.kick(managedAgent.handle).catch((err) => {
      console.error(`[agent-manager] Error kicking ${name}:`, err);
    });

    return { success: true, message: `Kicked ${name} from #${channel}` };
  }

  /**
   * Kick all agents in a channel.
   */
  kickAll(channel: string): { kicked: string[]; message: string } {
    const kicked: string[] = [];
    for (const [key, managedAgent] of this.agents) {
      if (managedAgent.handle.channel === channel) {
        managedAgent.provider.kick(managedAgent.handle).catch((err) => {
          console.error(`[agent-manager] Error kicking ${managedAgent.handle.name}:`, err);
        });
        kicked.push(managedAgent.handle.name);
      }
    }
    return {
      kicked,
      message: kicked.length > 0 ? `Kicked ${kicked.join(", ")} from #${channel}` : "No agents to kick",
    };
  }

  /**
   * Get a specific agent.
   */
  getAgent(channel: string, name: string): ManagedAgent | undefined {
    const key = this.getAgentKey(channel, name);
    return this.agents.get(key);
  }

  /**
   * Get all agents, optionally filtered by channel.
   */
  getAgents(channel?: string): ManagedAgent[] {
    const agents: ManagedAgent[] = [];
    for (const managedAgent of this.agents.values()) {
      if (!channel || managedAgent.handle.channel === channel) {
        agents.push(managedAgent);
      }
    }
    return agents;
  }

  /**
   * Get agent output log.
   */
  getAgentOutput(channel: string, name: string, limit = 100): AgentOutput[] {
    const key = this.getAgentKey(channel, name);
    const managedAgent = this.agents.get(key);
    if (!managedAgent) return [];
    return managedAgent.output.slice(-limit);
  }

  /**
   * Get available engines.
   */
  getAvailableEngines(): string[] {
    return this.registry.list();
  }

  /**
   * Check if an engine is available.
   */
  hasEngine(engine: string): boolean {
    return this.registry.has(engine);
  }

  /**
   * Get all engines with their capabilities.
   */
  getEnginesWithCapabilities(): Array<{ engine: string; capabilities: EngineCapabilities }> {
    return this.registry.listEnginesWithCapabilities();
  }
}
