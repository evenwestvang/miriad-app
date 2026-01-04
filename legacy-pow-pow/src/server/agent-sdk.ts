import { query, type Query, type SDKMessage, type SDKUserMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";

// Agent state
export type AgentState = "starting" | "idle" | "thinking" | "tool_running" | "stopped" | "error";

// Context for building agent system prompts
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
}

export interface AgentOutput {
  type: "text" | "tool_call" | "tool_result" | "error" | "system";
  timestamp: string;
  content: string;
  toolName?: string;
  toolInput?: unknown;
}

export interface Agent {
  name: string;
  channel: string;
  sessionId: string;
  workdir: string;
  state: AgentState;
  status?: string;
  startedAt: string;
  lastActivity: string;
  output: AgentOutput[];
  error?: string;
}

// Pushable async iterable for sending messages to agent
class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  end(): void {
    this.done = true;
    for (const resolve of this.resolvers) {
      resolve({ value: undefined as any, done: true });
    }
    this.resolvers = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

export class AgentManager {
  private agents = new Map<string, {
    agent: Agent;
    query: Query;
    input: Pushable<SDKUserMessage>;
    abortController: AbortController;
  }>();

  private onMessage?: (channel: string, sender: string, content: string) => void;
  private onStateChange?: (agent: Agent) => void;

  constructor(options?: {
    onMessage?: (channel: string, sender: string, content: string) => void;
    onStateChange?: (agent: Agent) => void;
  }) {
    this.onMessage = options?.onMessage;
    this.onStateChange = options?.onStateChange;
  }

  private getAgentKey(channel: string, name: string): string {
    return `${channel}:${name}`;
  }

  private slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  private addOutput(agent: Agent, output: AgentOutput): void {
    agent.output.push(output);
    agent.lastActivity = new Date().toISOString();
    // Keep only last 1000 outputs per agent
    if (agent.output.length > 1000) {
      agent.output = agent.output.slice(-1000);
    }
    this.onStateChange?.(agent);
  }

  private setState(agent: Agent, state: AgentState, status?: string): void {
    agent.state = state;
    if (status !== undefined) {
      agent.status = status;
    }
    agent.lastActivity = new Date().toISOString();
    this.onStateChange?.(agent);
  }

  private formatToolStatus(toolName: string, input: unknown): string {
    const inp = input as Record<string, unknown>;
    const truncate = (s: string, len = 40) => s.length > len ? s.slice(0, len) + "…" : s;

    // Strip mcp__ prefixes for cleaner names
    const cleanName = toolName.replace(/^mcp__\w+__/, "");

    switch (cleanName) {
      case "Bash":
        return inp.command ? `> ${truncate(String(inp.command), 50)}` : "Running shell";
      case "Read":
        return inp.file_path ? `Reading ${truncate(String(inp.file_path).split("/").pop() || "", 30)}` : "Reading file";
      case "Write":
        return inp.file_path ? `Writing ${truncate(String(inp.file_path).split("/").pop() || "", 30)}` : "Writing file";
      case "Edit":
        return inp.file_path ? `Editing ${truncate(String(inp.file_path).split("/").pop() || "", 30)}` : "Editing file";
      case "Grep":
        return inp.pattern ? `Searching: ${truncate(String(inp.pattern), 30)}` : "Searching";
      case "Glob":
        return inp.pattern ? `Finding: ${truncate(String(inp.pattern), 30)}` : "Finding files";
      case "Task":
        return inp.description ? truncate(String(inp.description), 40) : "Running task";
      case "WebFetch":
        return inp.url ? `Fetching ${truncate(String(inp.url), 35)}` : "Fetching URL";
      case "send_message":
        return "Sending message";
      case "track_channel":
        return `Joining #${inp.channel || "channel"}`;
      case "set_status":
        return inp.status ? truncate(String(inp.status), 40) : "Setting status";
      default:
        return `${cleanName}`;
    }
  }

  private buildSystemPrompt(channel: string, name: string, context?: SpawnContext): string {
    const sections: string[] = [];

    // Channel context section
    const channelParts: string[] = [];
    if (context?.tagline) {
      channelParts.push(context.tagline);
    }
    if (context?.mission) {
      channelParts.push(`### Mission\n${context.mission}`);
    }
    if (context?.playbookContent) {
      channelParts.push(`### Workflow\n${context.playbookContent}`);
    }
    if (context?.specialInstructions) {
      channelParts.push(`### Special Instructions\n${context.specialInstructions}`);
    }

    if (channelParts.length > 0) {
      sections.push(`## Channel: #${channel}\n\n${channelParts.join("\n\n")}`);
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

    const workdir = path.join("/tmp/powpow", `${this.slugify(channel)}--${this.slugify(name)}`);

    // Create workdir if needed
    if (!fs.existsSync(workdir)) {
      fs.mkdirSync(workdir, { recursive: true });
    }

    // Check for existing session to resume
    const hasContext = fs.existsSync(path.join(workdir, ".claude"));

    const agent: Agent = {
      name,
      channel,
      sessionId: "",
      workdir,
      state: "starting",
      startedAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
      output: [],
    };

    const input = new Pushable<SDKUserMessage>();
    const abortController = new AbortController();

    const options: Options = {
      model: "claude-opus-4-5-20251101",
      cwd: workdir,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: this.buildSystemPrompt(channel, name, context),
      },
      mcpServers: {
        powpow: {
          type: "http",
          url: mcpServerUrl,
        },
      },
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      abortController,
      continue: hasContext,
    };

    try {
      console.error(`[agent-sdk] Spawning ${name} in #${channel} (workdir: ${workdir})`);

      const q = query({ prompt: input, options });

      this.agents.set(key, { agent, query: q, input, abortController });

      // Start processing messages in background
      this.processMessages(key, q, agent);

      // Send initial message to start the agent
      setTimeout(() => {
        input.push({
          type: "user",
          message: {
            role: "user",
            content: `Track channel #${channel} using the track_channel MCP tool and introduce yourself to the channel. Your name is ${name}.`,
          },
          parent_tool_use_id: null,
          session_id: agent.sessionId,
        });
      }, 1000);

      return { success: true, message: `Spawned ${name} in #${channel}` };
    } catch (err) {
      console.error(`[agent-sdk] Failed to spawn ${name}:`, err);
      this.agents.delete(key);
      return { success: false, message: `Failed to spawn ${name}: ${err}` };
    }
  }

  private async processMessages(key: string, q: Query, agent: Agent): Promise<void> {
    try {
      for await (const message of q) {
        this.handleMessage(agent, message);
      }
    } catch (err: any) {
      console.error(`[agent-sdk] Error in ${agent.name}:`, err);
      this.setState(agent, "error");
      agent.error = err.message || String(err);
      this.addOutput(agent, {
        type: "error",
        timestamp: new Date().toISOString(),
        content: agent.error || "Unknown error",
      });
    } finally {
      console.error(`[agent-sdk] Agent ${agent.name} stopped`);
      this.setState(agent, "stopped");
      this.agents.delete(key);
    }
  }

  private handleMessage(agent: Agent, message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          agent.sessionId = message.session_id;
          this.setState(agent, "idle");
          this.addOutput(agent, {
            type: "system",
            timestamp: new Date().toISOString(),
            content: `Initialized with model ${message.model}, ${message.tools.length} tools available`,
          });
        } else if (message.subtype === "status") {
          // Status update
        }
        break;

      case "assistant":
        this.setState(agent, "thinking");
        // Extract text content
        for (const block of message.message.content) {
          if (block.type === "text") {
            this.addOutput(agent, {
              type: "text",
              timestamp: new Date().toISOString(),
              content: block.text,
            });
          } else if (block.type === "tool_use") {
            const toolStatus = this.formatToolStatus(block.name, block.input);
            this.setState(agent, "tool_running", toolStatus);
            this.addOutput(agent, {
              type: "tool_call",
              timestamp: new Date().toISOString(),
              content: toolStatus,
              toolName: block.name,
              toolInput: block.input,
            });

            // Check if this is a send_message - extract for chat
            if (block.name === "mcp__powpow__send_message" && block.input) {
              const input = block.input as { channel?: string; sender?: string; content?: string };
              if (input.content && input.sender) {
                // The agent is sending a message - it will go through MCP
                // We don't need to duplicate it here
              }
            }
          }
        }
        break;

      case "stream_event":
        // Streaming partial content - could update UI in real-time
        break;

      case "tool_progress":
        this.setState(agent, "tool_running", `${message.tool_name} (${Math.round(message.elapsed_time_seconds)}s)`);
        break;

      case "result":
        if (message.subtype === "success") {
          this.setState(agent, "idle");
          this.addOutput(agent, {
            type: "system",
            timestamp: new Date().toISOString(),
            content: `Completed: ${message.result.slice(0, 200)}${message.result.length > 200 ? "..." : ""}`,
          });
        } else {
          this.setState(agent, "error");
          this.addOutput(agent, {
            type: "error",
            timestamp: new Date().toISOString(),
            content: `Error: ${message.subtype} - ${(message as any).errors?.join(", ") || "Unknown error"}`,
          });
        }
        break;

      case "user":
        // User message (could be from MCP injection)
        break;
    }
  }

  sendMessage(channel: string, name: string, content: string): boolean {
    const key = this.getAgentKey(channel, name);
    const entry = this.agents.get(key);
    if (!entry) return false;

    entry.input.push({
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
      session_id: entry.agent.sessionId,
    });

    return true;
  }

  kick(channel: string, name: string): { success: boolean; message: string } {
    const key = this.getAgentKey(channel, name);
    const entry = this.agents.get(key);

    if (!entry) {
      return { success: false, message: `Agent ${name} is not running in #${channel}` };
    }

    console.error(`[agent-sdk] Kicking ${name} from #${channel}`);
    entry.abortController.abort();
    entry.input.end();

    return { success: true, message: `Kicked ${name} from #${channel}` };
  }

  kickAll(channel: string): { kicked: string[]; message: string } {
    const kicked: string[] = [];
    for (const [key, entry] of this.agents) {
      if (entry.agent.channel === channel) {
        entry.abortController.abort();
        entry.input.end();
        kicked.push(entry.agent.name);
      }
    }
    return {
      kicked,
      message: kicked.length > 0 ? `Kicked ${kicked.join(", ")} from #${channel}` : "No agents to kick",
    };
  }

  getAgent(channel: string, name: string): Agent | undefined {
    const key = this.getAgentKey(channel, name);
    return this.agents.get(key)?.agent;
  }

  getAgents(channel?: string): Agent[] {
    const agents: Agent[] = [];
    for (const entry of this.agents.values()) {
      if (!channel || entry.agent.channel === channel) {
        agents.push(entry.agent);
      }
    }
    return agents;
  }

  getAgentOutput(channel: string, name: string, limit = 100): AgentOutput[] {
    const key = this.getAgentKey(channel, name);
    const entry = this.agents.get(key);
    if (!entry) return [];
    return entry.agent.output.slice(-limit);
  }
}
