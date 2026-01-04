/**
 * Agent Manager
 *
 * Manages agent lifecycle, @mention routing, and message delivery.
 * Supports two modes:
 * - Standard mode: Uses createDriver() for the agentic loop
 * - Durable mode: Uses createDurableDriver() with SQLite checkpointing
 *
 * Emits Tymbal frames (Start/Append/Set) via WebSocket broadcast.
 *
 * Environment variables:
 * - DURABLE_MODE=true: Enable durable execution with checkpointing
 * - MOCK_LLM=true: Use MockLLMAdapter instead of real Anthropic API
 */

import { ulid } from 'ulid';
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { defineAgent, defineTool, type ProcessDefinition, type ToolDefinition, type Message, type ContentBlock } from '@cikada/agent';
import {
  createDriver,
  tymbal,
  DurableSqliteStorage,
  createLocalDurableContext,
  createDurableDriver,
  createReactiveDriver,
  AnthropicLLMAdapter,
  MockLLMAdapter,
  DockerOrchestrator,
  type LLMAdapter,
  type MCPServerConfig,
} from '@cikada/local-runtime';
import { convertTymbalHistoryToAnthropic, type TymbalStoredMessage } from '@cikada/reactive-agent';
import type { Storage } from '@cikada/storage';
import type { RosterEntry, StoredMessage } from '@cikada/core';
import { generateContainerToken } from './auth/index.js';
import type { TymbalFrameHandler } from '@cikada/core';

// =============================================================================
// Types
// =============================================================================

export type AgentState = 'starting' | 'idle' | 'thinking' | 'tool_running' | 'stopped' | 'error';

export interface ManagedAgent {
  /** Agent name (callsign) */
  name: string;
  /** Channel ID this agent is in */
  channelId: string;
  /** Space ID this agent belongs to */
  spaceId: string;
  /** Current lifecycle state */
  state: AgentState;
  /** Accumulated output buffer */
  output: string[];
  /** Roster entry with config */
  rosterEntry: RosterEntry;
  /** ProcessDefinition built from roster config */
  process: ProcessDefinition;
}

export interface AgentManagerOptions {
  storage: Storage;
  broadcast: (channelId: string, frame: string) => Promise<void>;
  /** Enable Docker sandbox for Claude Code agents */
  enableSandbox?: boolean;
  /** Server port for Docker callback URL */
  serverPort?: number;
  /** TymbalFrameHandler for unified frame processing (optional - if not provided, uses legacy inline persistence) */
  tymbalHandler?: TymbalFrameHandler;
}

export interface AgentOutput {
  type: 'text' | 'tool_use' | 'tool_result';
  content: string;
  toolName?: string;
  toolId?: string;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MODEL = 'claude-3-5-haiku-latest';
const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant participating in a channel conversation. Keep responses concise and helpful.';

// =============================================================================
// System Prompt Builder
// =============================================================================

/**
 * Build a system prompt for an agent with channel context, roster, and @mention rules.
 * This follows the PowPow format from [[powpow-agent-system-prompts]].
 */
async function buildSystemPrompt(
  storage: Storage,
  spaceId: string,
  channelId: string,
  callsign: string,
  rosterEntry: RosterEntry
): Promise<string> {
  const sections: string[] = [];

  // Fetch channel info
  const channel = await storage.getChannel(spaceId, channelId);
  const roster = await storage.getRoster(spaceId, channelId);

  // 1. Channel Context
  const channelName = channel?.name ?? channelId;
  const tagline = channel?.tagline ?? 'Open workspace';
  const mission = channel?.mission ?? 'A flexible space for collaboration.';

  sections.push(`## Channel Context

**Channel:** #${channelName}
**Tagline:** ${tagline}
**Mission:** ${mission}`);

  // 2. Your Role
  const roleName = rosterEntry.agentConfig?.agentName ?? rosterEntry.name ?? 'Assistant';
  const roleInstructions = rosterEntry.agentConfig?.system ?? 'You are a helpful assistant. Collaborate with the team and contribute where you can.';

  sections.push(`## Your Role: ${roleName}

${roleInstructions}`);

  // 3. Team Roster
  const rosterLines = roster
    .filter((r) => r.type === 'agent')
    .map((r) => {
      const role = r.agentConfig?.agentName ?? 'Agent';
      return `- @${r.id} (${role})`;
    });

  if (rosterLines.length > 0) {
    sections.push(`## Team Roster

Your teammates in this channel:
${rosterLines.join('\n')}`);
  }

  // 4. Channel Participation (CRITICAL - @mention routing rules)
  sections.push(`## Channel Participation

You are "${callsign}", an AI agent participating in a multi-agent chat channel called #${channelName}.

CRITICAL INSTRUCTIONS:
1. Always use @mentions when sending messages (e.g., @someone or @channel)
2. Messages without @mentions will NOT be delivered to other agents
3. Your callsign is "${callsign}" - this is how others will @mention you
4. Collaborate with other agents and humans in the channel
5. Keep responses concise and focused

When you want to communicate:
- @someone - Direct message to a specific agent or human
- @channel - Broadcast to all agents in the channel

WHEN NOT TO RESPOND:
- If you have nothing meaningful to add, stay quiet
- Don't respond just to acknowledge - only respond if you have value to contribute
- If someone else is better suited to answer, let them handle it
- Avoid conversation loops - if you've already addressed a topic, don't repeat yourself
- When a task is complete, say so briefly and stop - don't ask follow-up questions unless needed

Keep comms effective and brief. A little personality is welcome—we're collaborating, not filing reports—but remember that verbose messages break focus and consume context windows.`);

  // 5. Workspace Rules
  sections.push(`## Workspace Rules

You have your own workspace directory at /workspace. You MUST:
1. Stay in your workspace - do NOT access paths outside /workspace
2. Coordinate with teammates through chat for any shared work`);

  // Join sections with separator
  return sections.join('\n\n---\n\n');
}

// =============================================================================
// Mention Parsing
// =============================================================================

const MENTION_REGEX = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;
const CHANNEL_MENTION = '@channel';

/**
 * Extract @mentions from message content.
 * Returns array of mentioned names (without @ prefix).
 */
export function parseMentions(content: string): { mentions: string[]; isChannelBroadcast: boolean } {
  const isChannelBroadcast = content.toLowerCase().includes(CHANNEL_MENTION.toLowerCase());

  const mentions: string[] = [];
  let match;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    const name = match[1].toLowerCase();
    if (name !== 'channel' && !mentions.includes(name)) {
      mentions.push(name);
    }
  }

  return { mentions, isChannelBroadcast };
}

// =============================================================================
// Built-in Test Tools
// =============================================================================

/**
 * Test tool: get_time - returns current date/time
 */
const getTimeTool = defineTool({
  description: 'Get the current date and time',
  parameters: z.object({
    timezone: z.string().optional().describe('Timezone (e.g., "UTC", "America/New_York")'),
  }),
  execute: async (args) => {
    const now = new Date();
    const options: Intl.DateTimeFormatOptions = {
      timeZone: args.timezone || 'UTC',
      dateStyle: 'full',
      timeStyle: 'long',
    };
    return {
      timestamp: now.toISOString(),
      formatted: now.toLocaleString('en-US', options),
      timezone: args.timezone || 'UTC',
    };
  },
});

/**
 * Test tool: calculate - performs basic math
 */
const calculateTool = defineTool({
  description: 'Perform a mathematical calculation',
  parameters: z.object({
    expression: z.string().describe('Math expression to evaluate (e.g., "2 + 2", "10 * 5")'),
  }),
  execute: async (args) => {
    // Simple safe eval for basic math (only numbers and operators)
    const expr = args.expression.replace(/[^0-9+\-*/().% ]/g, '');
    try {
      // Use Function constructor for safe evaluation of math expressions
      const result = new Function(`return ${expr}`)();
      return {
        expression: args.expression,
        result: result,
      };
    } catch {
      return {
        expression: args.expression,
        error: 'Invalid expression',
      };
    }
  },
});

// =============================================================================
// Process Definition Builder
// =============================================================================

/**
 * Build a ProcessDefinition from roster entry config.
 * Includes test tools (get_time, calculate) for agents with tools enabled.
 *
 * System prompt priority:
 * 1. rosterEntry.systemPrompt (captured at spawn time - immutable)
 * 2. config.system (fallback for legacy entries)
 * 3. DEFAULT_SYSTEM_PROMPT
 */
function buildProcessDefinition(rosterEntry: RosterEntry): ProcessDefinition {
  const config = rosterEntry.agentConfig ?? {};

  // Check if this agent should have tools enabled
  // For now, enable tools for all agents (can be controlled via config later)
  const enableTools = true;

  const tools = enableTools ? {
    get_time: getTimeTool,
    calculate: calculateTool,
  } : undefined;

  // Use systemPrompt from roster entry (captured at spawn time)
  // This ensures the prompt doesn't drift if someone edits the agent definition
  const systemPrompt = rosterEntry.systemPrompt ?? config.system ?? DEFAULT_SYSTEM_PROMPT;

  return defineAgent({
    name: rosterEntry.name,
    system: systemPrompt,
    config: {
      model: config.model ?? DEFAULT_MODEL,
      maxTokens: config.maxTokens ?? 2048,
    },
    tools,
  });
}

// =============================================================================
// Agent Manager
// =============================================================================

export class AgentManager {
  private agents: Map<string, ManagedAgent[]> = new Map(); // channelId -> agents
  private storage: Storage;
  private broadcast: (channelId: string, frame: string) => Promise<void>;
  private anthropic: Anthropic | null = null;
  private driver: ReturnType<typeof createDriver> | null = null;
  private useRealLLM: boolean = false;

  // Durable mode components
  private durableStorage: DurableSqliteStorage | null = null;
  private llmAdapter: LLMAdapter | null = null;
  private useDurableMode: boolean = false;
  private useMockLLM: boolean = false;

  // Docker sandbox components
  private dockerOrchestrator: DockerOrchestrator | null = null;
  private enableSandbox: boolean = false;
  private serverPort: number = 3001;

  // Unified frame handler
  private tymbalHandler: TymbalFrameHandler | null = null;

  constructor(options: AgentManagerOptions) {
    this.storage = options.storage;
    this.broadcast = options.broadcast;
    this.enableSandbox = options.enableSandbox ?? (process.env.ENABLE_SANDBOX === 'true');
    this.serverPort = options.serverPort ?? 3001;
    this.tymbalHandler = options.tymbalHandler ?? null;

    // Check environment flags
    this.useDurableMode = process.env.DURABLE_MODE === 'true';
    this.useMockLLM = process.env.MOCK_LLM === 'true';

    // Initialize Anthropic client if API key is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
      this.useRealLLM = true;
    }

    // Initialize based on mode
    if (this.useDurableMode) {
      this.initDurableMode(apiKey);
    } else {
      this.initStandardMode();
    }

    // Initialize Docker sandbox if enabled
    if (this.enableSandbox && apiKey) {
      this.initDockerSandbox(apiKey);
    }
  }

  /**
   * Initialize standard (non-durable) mode.
   */
  private initStandardMode(): void {
    if (this.anthropic) {
      this.driver = createDriver({ anthropic: this.anthropic });
      console.log('[AgentManager] Standard mode initialized with Anthropic');
    } else {
      console.log('[AgentManager] Standard mode - ANTHROPIC_API_KEY not set, using echo mode');
    }
  }

  /**
   * Initialize durable mode with SQLite checkpointing.
   */
  private initDurableMode(apiKey: string | undefined): void {
    // Create durable SQLite storage
    const dbPath = process.env.DURABLE_DB_PATH ?? './cikada-durable.db';
    this.durableStorage = new DurableSqliteStorage(dbPath);
    console.log(`[AgentManager] Durable storage initialized at ${dbPath}`);

    // Create LLM adapter
    if (this.useMockLLM) {
      this.llmAdapter = new MockLLMAdapter({ delay: 100 });
      console.log('[AgentManager] Durable mode initialized with MockLLMAdapter');
    } else if (apiKey && this.anthropic) {
      this.llmAdapter = new AnthropicLLMAdapter({ client: this.anthropic });
      console.log('[AgentManager] Durable mode initialized with AnthropicLLMAdapter');
    } else {
      console.log('[AgentManager] Durable mode - ANTHROPIC_API_KEY not set, using echo mode fallback');
    }
  }

  /**
   * Initialize Docker sandbox for Claude Code agents.
   */
  private initDockerSandbox(apiKey: string): void {
    this.dockerOrchestrator = new DockerOrchestrator({
      anthropicApiKey: apiKey,
      cikadaApiUrl: `http://host.docker.internal:${this.serverPort}`,
      broadcast: async (threadId, frame) => {
        // threadId format is "channelId:agentName" - extract channelId
        const colonIdx = threadId.indexOf(':');
        const channelId = colonIdx > 0 ? threadId.slice(0, colonIdx) : threadId;
        await this.broadcast(channelId, frame);
      },
    });
    console.log(`[AgentManager] Docker sandbox initialized (callback URL: http://host.docker.internal:${this.serverPort})`);
  }

  /**
   * Check if an agent should use Docker sandbox based on its config.
   */
  private shouldUseSandbox(rosterEntry: RosterEntry): boolean {
    if (!this.enableSandbox || !this.dockerOrchestrator) {
      return false;
    }
    // Use sandbox if agent config specifies agentName or engine as 'claude-code'
    const config = rosterEntry.agentConfig;
    return config?.engine === 'claude-code' || config?.agentName === 'claude-code';
  }

  /**
   * Check if an agent should use the reactive driver (native MCP support).
   */
  private shouldUseReactive(rosterEntry: RosterEntry): boolean {
    const config = rosterEntry.agentConfig;
    return config?.engine === 'reactive';
  }

  /**
   * Get agents currently running in a channel.
   */
  getAgents(channelId: string): ManagedAgent[] {
    return this.agents.get(channelId) ?? [];
  }

  /**
   * Find a specific agent by name in a channel.
   */
  findAgent(channelId: string, name: string): ManagedAgent | undefined {
    return this.getAgents(channelId).find(
      (a) => a.name.toLowerCase() === name.toLowerCase()
    );
  }

  /**
   * Spawn an agent in a channel.
   */
  async spawn(spaceId: string, channelId: string, rosterEntry: RosterEntry): Promise<ManagedAgent> {
    // Check if already running
    const existing = this.findAgent(channelId, rosterEntry.name);
    if (existing) {
      return existing;
    }

    // Build process definition from roster config
    const process = buildProcessDefinition(rosterEntry);

    const agent: ManagedAgent = {
      name: rosterEntry.name,
      channelId,
      spaceId,
      state: 'starting',
      output: [],
      rosterEntry,
      process,
    };

    // Add to channel's agent list
    let channelAgents = this.agents.get(channelId);
    if (!channelAgents) {
      channelAgents = [];
      this.agents.set(channelId, channelAgents);
    }
    channelAgents.push(agent);

    // Emit state change
    await this.emitAgentState(agent);

    // Transition to idle
    agent.state = 'idle';
    await this.emitAgentState(agent);

    console.log(`[AgentManager] Spawned agent ${agent.name} in channel ${channelId}`);
    return agent;
  }

  /**
   * Stop an agent in a channel.
   */
  async kick(channelId: string, name: string): Promise<boolean> {
    const channelAgents = this.agents.get(channelId);
    if (!channelAgents) return false;

    const index = channelAgents.findIndex(
      (a) => a.name.toLowerCase() === name.toLowerCase()
    );
    if (index === -1) return false;

    const agent = channelAgents[index];
    agent.state = 'stopped';
    await this.emitAgentState(agent);

    channelAgents.splice(index, 1);
    if (channelAgents.length === 0) {
      this.agents.delete(channelId);
    }

    console.log(`[AgentManager] Kicked agent ${name} from channel ${channelId}`);
    return true;
  }

  /**
   * Route a message to relevant agents based on @mentions.
   * Auto-spawns agents from roster if not already running.
   */
  async routeMessage(
    spaceId: string,
    channelId: string,
    sender: string,
    content: string
  ): Promise<void> {
    // Get roster and check sender type
    const roster = await this.storage.getRoster(spaceId, channelId);

    // Skip routing for explicitly unknown senders
    // This prevents tool_result frames with sender="unknown" from triggering unwanted routing
    // but allows human users (sender=user) and other legitimate traffic through
    if (sender.toLowerCase() === 'unknown') {
      return;
    }

    const senderEntry = roster.find((r) => r.id.toLowerCase() === sender.toLowerCase());
    const senderIsAgent = senderEntry?.type === 'agent';

    // Parse mentions
    const { mentions, isChannelBroadcast } = parseMentions(content);

    // Get agents in roster (excluding sender to prevent loops)
    const agentRosterEntries = roster.filter((r) =>
      r.type === 'agent' && r.id.toLowerCase() !== sender.toLowerCase()
    );

    // Determine which agents to route to
    let targetAgents: RosterEntry[] = [];

    if (isChannelBroadcast) {
      // @channel broadcasts to all agents (except sender)
      targetAgents = agentRosterEntries;
    } else if (mentions.length > 0) {
      // Route to mentioned agents only (match against id/callsign, not display name)
      targetAgents = agentRosterEntries.filter((r) =>
        mentions.some((m) => r.id.toLowerCase() === m)
      );
    } else if (!senderIsAgent) {
      // No mentions from human - route to channel leader
      const channel = await this.storage.getChannel(spaceId, channelId);
      if (channel?.leader) {
        const leaderEntry = agentRosterEntries.find(
          (r) => r.id.toLowerCase() === channel.leader!.toLowerCase()
        );
        if (leaderEntry) {
          targetAgents = [leaderEntry];
        }
      }
      // Fallback: if no leader set, route to first agent in roster
      if (targetAgents.length === 0 && agentRosterEntries.length > 0) {
        targetAgents = [agentRosterEntries[0]];
      }
    }
    // else: Agent sender with no mentions - no routing (agents must explicitly @mention)

    if (targetAgents.length === 0) {
      return;
    }

    // Auto-spawn and send to each target agent
    for (const entry of targetAgents) {
      // Spawn if not running
      const agent = await this.spawn(spaceId, channelId, entry);

      // Send the message
      await this.sendToAgent(agent, sender, content);
    }
  }

  /**
   * Send a message to a specific agent and handle its response.
   * Uses Docker sandbox, durable driver, or standard driver based on config.
   */
  private async sendToAgent(
    agent: ManagedAgent,
    sender: string,
    content: string
  ): Promise<void> {
    agent.state = 'thinking';
    await this.emitAgentState(agent);

    try {
      // Check if this agent should use Docker sandbox
      if (this.shouldUseSandbox(agent.rosterEntry) && this.dockerOrchestrator) {
        // Route to Docker container
        await this.runAgentWithDocker(agent, sender, content);
      } else if (this.shouldUseReactive(agent.rosterEntry)) {
        // Route to reactive driver (native MCP support)
        await this.runAgentWithReactiveDriver(agent, sender, content);
      } else if (this.useDurableMode && this.durableStorage && this.llmAdapter) {
        // Use durable driver with checkpointing
        await this.runAgentWithDurableDriver(agent, sender, content);
      } else if (this.useRealLLM && this.driver) {
        // Use standard driver for the agentic loop
        await this.runAgentWithDriver(agent, sender, content);
      } else {
        // Fall back to mock echo
        await this.mockAgentResponse(agent, sender, content);
      }
    } catch (err) {
      agent.state = 'error';
      await this.emitAgentState(agent);
      console.error(`[AgentManager] Error from agent ${agent.name}:`, err);

      // Broadcast error frame
      const errorMsgId = ulid();
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      await this.broadcast(
        agent.channelId,
        tymbal.set(errorMsgId, {
          type: 'error',
          sender: agent.rosterEntry.id,
          senderType: 'agent',
          content: `Error: ${errorMessage}`,
        })
      );
      return;
    }

    // Return to idle
    agent.state = 'idle';
    await this.emitAgentState(agent);
  }

  /**
   * Run agent in Docker container (Claude Code sandbox).
   */
  private async runAgentWithDocker(
    agent: ManagedAgent,
    sender: string,
    content: string
  ): Promise<void> {
    if (!this.dockerOrchestrator) {
      throw new Error('Docker orchestrator not initialized');
    }

    // Use the roster entry id (callsign) for thread ID and container naming
    // This avoids spaces and special characters in paths
    const callsign = agent.rosterEntry.id;

    // Create a thread ID for this agent - include spaceId for isolation
    // Format: spaceId:channelId:callsign
    const threadId = `${agent.spaceId}:${agent.channelId}:${callsign}`;

    // Format the user message with sender context
    const userMessage = `Message from @${sender}: ${content}`;

    // Generate auth token for container to authenticate with server
    const authToken = generateContainerToken({
      spaceId: agent.spaceId,
      channelId: agent.channelId,
      callsign,
    });

    // Build system prompt with channel context, roster, and @mention rules
    const systemPrompt = await buildSystemPrompt(
      this.storage,
      agent.spaceId,
      agent.channelId,
      callsign,
      agent.rosterEntry
    );

    console.log(`[AgentManager] Running Docker sandbox for agent ${callsign}, thread: ${threadId}`);
    console.log(`[AgentManager] System prompt length: ${systemPrompt.length} chars`);

    // Send message to Docker orchestrator
    // The orchestrator will:
    // 1. Start container if needed
    // 2. Forward message to container (with MCP configs and system prompt)
    // 3. Container broadcasts frames back via tymbal endpoint
    await this.dockerOrchestrator.sendMessage(threadId, userMessage, {
      spaceId: agent.spaceId,
      channelId: agent.channelId,
      callsign,
      mcpServers: agent.rosterEntry.agentConfig?.mcpServers,
      authToken,
      systemPrompt,
    });

    console.log(`[AgentManager] Docker message sent for agent ${callsign}`);
  }

  /**
   * Run agent using the local-runtime driver.
   * The driver handles:
   * - Streaming with Tymbal frames (Start/Append/Set)
   * - Tool execution loop
   * - Message ID consistency
   */
  private async runAgentWithDriver(
    agent: ManagedAgent,
    sender: string,
    content: string
  ): Promise<void> {
    if (!this.driver) {
      throw new Error('Driver not initialized');
    }

    // Use the roster entry id (callsign) for sender consistency
    const callsign = agent.rosterEntry.id;

    // Create a thread ID for this conversation turn - include spaceId for isolation
    const threadId = `${agent.spaceId}:${agent.channelId}:${callsign}`;

    // Format the user message with sender context
    const userMessage = `Message from @${sender}: ${content}`;

    console.log(`[AgentManager] Running driver for agent ${agent.name}, thread: ${threadId}`);

    // Create a broadcast function that adds sender info and routes through TymbalFrameHandler
    const agentBroadcast = async (frame: string): Promise<void> => {
      try {
        const parsed = JSON.parse(frame);

        // Add sender info to Set frames (use roster id as sender)
        if (parsed.v && typeof parsed.v === 'object') {
          parsed.v.sender = callsign;
          parsed.v.senderType = 'agent';
        }

        // Add sender info to Start frame metadata
        if (parsed.m && typeof parsed.m === 'object') {
          parsed.m.sender = callsign;
          parsed.m.senderType = 'agent';
        }

        const enrichedFrame = JSON.stringify(parsed);

        // Use TymbalFrameHandler if available (unified path for broadcast + persistence + routing)
        if (this.tymbalHandler) {
          await this.tymbalHandler.handleFrame(agent.spaceId, agent.channelId, enrichedFrame);
        } else {
          // Legacy fallback: just broadcast (no persistence)
          await this.broadcast(agent.channelId, enrichedFrame);
        }
      } catch {
        // If parsing fails, broadcast as-is
        await this.broadcast(agent.channelId, frame);
      }
    };

    // Run the driver with the agent's process definition
    await this.driver.run({
      threadId,
      agentName: callsign,
      userMessage,
      agent: agent.process,
      broadcast: agentBroadcast,
    });

    console.log(`[AgentManager] Driver completed for agent ${agent.name}`);
  }

  /**
   * Run agent using the durable driver with SQLite checkpointing.
   * Enables recovery from crashes by persisting execution state.
   */
  private async runAgentWithDurableDriver(
    agent: ManagedAgent,
    sender: string,
    content: string
  ): Promise<void> {
    if (!this.durableStorage || !this.llmAdapter) {
      throw new Error('Durable storage or LLM adapter not initialized');
    }

    // Use the roster entry id (callsign) for sender consistency
    const callsign = agent.rosterEntry.id;

    // Create a thread ID for this conversation turn - include spaceId for isolation
    const threadId = `${agent.spaceId}:${agent.channelId}:${callsign}`;

    // Format the user message with sender context
    const userMessage = `Message from @${sender}: ${content}`;

    console.log(`[AgentManager] Running durable driver for agent ${agent.name}, thread: ${threadId}`);

    // Create durable context for this agent run
    const durableContext = await createLocalDurableContext({
      storage: this.durableStorage,
      threadId,
      agentName: callsign,
    });

    if (durableContext.isResuming) {
      console.log(`[AgentManager] Resuming execution from checkpoint (last step: ${durableContext.lastCompletedStep})`);
    }

    // Create durable driver
    const driver = createDurableDriver({
      llm: this.llmAdapter,
      durableContext,
    });

    // Create a broadcast function that adds sender info and routes through TymbalFrameHandler
    const agentBroadcast = async (frame: string): Promise<void> => {
      try {
        const parsed = JSON.parse(frame);

        // Add sender info to Set frames (use roster id as sender)
        if (parsed.v && typeof parsed.v === 'object') {
          parsed.v.sender = callsign;
          parsed.v.senderType = 'agent';
        }

        // Add sender info to Start frame metadata
        if (parsed.m && typeof parsed.m === 'object') {
          parsed.m.sender = callsign;
          parsed.m.senderType = 'agent';
        }

        const enrichedFrame = JSON.stringify(parsed);

        // Use TymbalFrameHandler if available (unified path for broadcast + persistence + routing)
        if (this.tymbalHandler) {
          await this.tymbalHandler.handleFrame(agent.spaceId, agent.channelId, enrichedFrame);
        } else {
          // Legacy fallback: just broadcast (no persistence)
          await this.broadcast(agent.channelId, enrichedFrame);
        }
      } catch {
        // If parsing fails, broadcast as-is
        await this.broadcast(agent.channelId, frame);
      }
    };

    // Run the durable driver
    await driver.run({
      threadId,
      agentName: callsign,
      userMessage,
      agent: agent.process,
      broadcast: agentBroadcast,
    });

    console.log(`[AgentManager] Durable driver completed for agent ${agent.name}`);
  }

  /**
   * Run agent using the reactive driver with native MCP tool support.
   * The reactive driver is stateless - each turn loads history from storage.
   *
   * @see packages/local-runtime/src/reactive/ for implementation
   */
  private async runAgentWithReactiveDriver(
    agent: ManagedAgent,
    sender: string,
    content: string
  ): Promise<void> {
    // Initialize LLM adapter if not already done
    if (!this.llmAdapter) {
      if (this.useMockLLM) {
        this.llmAdapter = new MockLLMAdapter({ delay: 100 });
        console.log('[AgentManager] Initialized MockLLMAdapter for reactive mode');
      } else if (this.anthropic) {
        this.llmAdapter = new AnthropicLLMAdapter({ client: this.anthropic });
        console.log('[AgentManager] Initialized AnthropicLLMAdapter for reactive mode');
      } else {
        // Fall back to mock if no API key
        await this.mockAgentResponse(agent, sender, content);
        return;
      }
    }

    // Create thread ID for this conversation turn - include spaceId for isolation
    const threadId = `${agent.spaceId}:${agent.channelId}:${agent.name}`;

    // Format the user message with sender context
    const userMessage = `Message from @${sender}: ${content}`;

    console.log(`[AgentManager] Running reactive driver for agent ${agent.name}, thread: ${threadId}`);

    // Generate auth token for reactive agent to authenticate MCP requests
    const callsign = agent.rosterEntry.id;
    const authToken = generateContainerToken({
      spaceId: agent.spaceId,
      channelId: agent.channelId,
      callsign,
    });

    // Convert MCP server configs from core types to local-runtime types (HTTP only)
    // Inject auth token header for MCP servers that need it
    const mcpServers: MCPServerConfig[] = (agent.rosterEntry.agentConfig?.mcpServers ?? [])
      .filter((config) => config.transport === 'http' && config.url)
      .map((config) => ({
        name: config.name,
        transport: 'http' as const,
        url: config.url!,
        headers: {
          ...config.headers,
          'X-Cikada-Token': authToken,
        },
      }));

    // Load conversation history for this agent from storage
    // - Scoped to messages since agent's joinedAt (instance startTime)
    // - Only messages where agent is addressed or broadcast to channel
    console.log(`[AgentManager] Loading history for ${callsign}: joinedAt=${agent.rosterEntry.joinedAt}`);
    const storedHistory = await this.storage.getAgentHistory(
      agent.spaceId,
      agent.channelId,
      {
        agentCallsign: callsign,
        sinceTimestamp: agent.rosterEntry.joinedAt,
      }
    );
    console.log(`[AgentManager] Got ${storedHistory.length} messages from history for ${callsign}`);

    // Convert Tymbal-native StoredMessage[] to Anthropic Message[] format
    // Uses JIT conversion from @cikada/reactive-agent - groups by turnId, embeds tool_use blocks
    const conversationHistory = convertTymbalHistoryToAnthropic(
      storedHistory as TymbalStoredMessage[]
    ) as Message[];

    console.log(`[AgentManager] Converted ${conversationHistory.length} history messages for agent ${agent.name}`);

    // Create reactive driver (stateless - no durable context)
    // Note: Persistence is handled server-side when Tymbal frames are received
    const driver = createReactiveDriver({
      llm: this.llmAdapter,
      mcpServers,
      conversationHistory,
    });

    // Create a broadcast function that adds sender info and routes through TymbalFrameHandler
    const agentBroadcast = async (frame: string): Promise<void> => {
      try {
        const parsed = JSON.parse(frame);

        // Add sender info to Set frames (use roster id as sender)
        if (parsed.v && typeof parsed.v === 'object') {
          parsed.v.sender = callsign;
          parsed.v.senderType = 'agent';
        }

        // Add sender info to Start frame metadata
        if (parsed.m && typeof parsed.m === 'object') {
          parsed.m.sender = callsign;
          parsed.m.senderType = 'agent';
        }

        const enrichedFrame = JSON.stringify(parsed);

        // Use TymbalFrameHandler if available (unified path for broadcast + persistence + routing)
        if (this.tymbalHandler) {
          await this.tymbalHandler.handleFrame(agent.spaceId, agent.channelId, enrichedFrame);
        } else {
          // Legacy fallback: just broadcast (no persistence)
          await this.broadcast(agent.channelId, enrichedFrame);
        }
      } catch {
        // If parsing fails, broadcast as-is
        await this.broadcast(agent.channelId, frame);
      }
    };

    // broadcastWithRouting is now unnecessary - TymbalFrameHandler handles routing
    // Keep alias for compatibility with driver.run() call below
    const broadcastWithRouting = async (frame: string): Promise<void> => {
      await agentBroadcast(frame);
      // Note: @mention routing is now handled by TymbalFrameHandler.handleFrame()
      // Legacy routing fallback if no tymbalHandler:
      if (!this.tymbalHandler) {
        try {
          const parsed = JSON.parse(frame);
          if (parsed.v?.type === 'assistant' && parsed.v?.content) {
            await this.routeMessage(agent.spaceId, agent.channelId, callsign, parsed.v.content);
          }
        } catch {
          // Ignore parsing errors
        }
      }
    };

    // Run the reactive driver
    await driver.run({
      threadId,
      agentName: callsign,
      userMessage,
      agent: agent.process,
      broadcast: broadcastWithRouting,
      // Pass correct parameters for runReactiveAgent
      spaceId: agent.spaceId,
      channelId: agent.channelId,
      callsign,
    });

    console.log(`[AgentManager] Reactive driver completed for agent ${agent.name}`);
  }

  /**
   * Mock agent response for testing when no API key is set.
   * Simulates a delay and echoes the message.
   */
  private async mockAgentResponse(
    agent: ManagedAgent,
    sender: string,
    content: string
  ): Promise<void> {
    // Use the roster entry id (callsign) for sender consistency
    const callsign = agent.rosterEntry.id;

    // Simulate thinking delay
    await new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 500));

    // Simple echo response
    const response = `Hey @${sender}! I received your message: "${content.slice(0, 100)}${content.length > 100 ? '...' : ''}"`;

    // Emit the response using Tymbal frames
    const messageId = ulid();
    const frame = tymbal.set(messageId, {
      type: 'assistant',
      content: response,
      sender: callsign,
      senderType: 'agent',
    });

    // Use TymbalFrameHandler if available (unified path for broadcast + persistence + routing)
    if (this.tymbalHandler) {
      await this.tymbalHandler.handleFrame(agent.spaceId, agent.channelId, frame);
    } else {
      // Legacy fallback: just broadcast (no persistence)
      await this.broadcast(agent.channelId, frame);
    }

    agent.output.push(response);
  }

  /**
   * Emit agent_state frame to WebSocket clients.
   */
  private async emitAgentState(agent: ManagedAgent): Promise<void> {
    const frame = tymbal.set(ulid(), {
      type: 'agent_state',
      sender: agent.rosterEntry.id,
      senderType: 'agent',
      state: agent.state,
    });
    await this.broadcast(agent.channelId, frame);
  }
}
