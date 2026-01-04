/**
 * CodexProvider - OpenAI Codex SDK integration for PowPow
 *
 * Implements CodingAgentProvider interface for Codex agents.
 * Key features:
 * - Thread-based conversations via @openai/codex-sdk
 * - Message queue pattern for mid-turn messaging limitation
 * - HTTP MCP (Streamable HTTP) configuration
 * - Event mapping from Codex items to unified AgentOutput
 */

import { Codex, type Thread } from "./codex-sdk/index.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { v4 as uuidv4 } from "uuid";
import {
  type CodingAgentProvider,
  type AgentConfig,
  type AgentHandle,
  type AgentState,
  type AgentOutput,
  type AgentOutputType,
  type ProviderCapabilities,
  type OutputCallback,
  type StateChangeCallback,
  ProviderError,
} from "./agent-provider.js";
import { normalizeError, createProviderError } from "./error-utils.js";

/** Internal state for a Codex agent instance */
interface CodexAgentState {
  handle: AgentHandle;
  thread: Thread;
  config: AgentConfig;
  state: AgentState;
  pendingMessages: string[];
  isRunActive: boolean;
  systemPromptSent: boolean; // Track if system prompt has been included
  outputCallbacks: OutputCallback[];
  stateCallbacks: StateChangeCallback[];
  abortController: AbortController;
}

/**
 * CodexProvider implements CodingAgentProvider for OpenAI Codex.
 *
 * Architecture:
 * - Uses @openai/codex-sdk Thread for conversation management
 * - runStreamed() for real-time event streaming
 * - Message queue pattern: messages sent during active turns are queued
 *   and delivered when the turn completes
 */
export class CodexProvider implements CodingAgentProvider {
  readonly name = "codex";

  readonly capabilities: ProviderCapabilities = {
    supportsMidTurnMessages: false, // Codex cannot inject messages mid-turn
    supportsInterruption: true,     // Can cancel via abort
    exposesReasoning: true,         // Codex exposes reasoning traces
    supportsSessionResume: true,    // Via ~/.codex/sessions
  };

  private codex: Codex;
  private agents = new Map<string, CodexAgentState>();

  constructor() {
    this.codex = new Codex();
  }

  private getAgentKey(channel: string, name: string): string {
    return `${channel}:${name}`;
  }

  private slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  /**
   * Spawn a new Codex agent or resume an existing session.
   */
  async spawn(
    channel: string,
    name: string,
    config: AgentConfig
  ): Promise<AgentHandle> {
    const key = this.getAgentKey(channel, name);

    // Check if agent exists - allow respawn if in error/stopped state
    const existing = this.agents.get(key);
    if (existing) {
      if (existing.state === "error" || existing.state === "stopped") {
        // Clean up the old agent before respawning
        this.agents.delete(key);
      } else {
        throw createProviderError(
          `Agent ${name} is already running in #${channel}`,
          "session_error",
          this.name
        );
      }
    }

    // Create workdir if needed
    if (!fs.existsSync(config.workdir)) {
      fs.mkdirSync(config.workdir, { recursive: true });
    }

    // Check for existing session to resume
    const sessionFile = path.join(config.workdir, ".codex-session");
    let thread: Thread;
    let sessionId: string | undefined;

    // Build thread options with MCP configuration
    const threadOptions: any = {
      workingDirectory: config.workdir,
      skipGitRepoCheck: true, // Allow non-git directories
      approvalPolicy: "never", // Auto-approve tool calls (full autonomy)
    };

    // Configure MCP servers if provided
    if (config.mcpServers) {
      threadOptions.mcpServers = {};
      for (const [serverName, mcpConfig] of Object.entries(config.mcpServers)) {
        if (mcpConfig.type === "http" || mcpConfig.type === "sse") {
          // HTTP/Streamable HTTP MCP server
          threadOptions.mcpServers[serverName] = {
            url: mcpConfig.url,
            // Bearer token from environment variable
            ...(mcpConfig.bearerTokenEnvVar && {
              bearerTokenEnvVar: mcpConfig.bearerTokenEnvVar,
            }),
            // Custom headers
            ...(mcpConfig.headers && {
              httpHeaders: mcpConfig.headers,
            }),
          };
        } else if (mcpConfig.type === "stdio") {
          // STDIO MCP server (local subprocess)
          threadOptions.mcpServers[serverName] = {
            command: mcpConfig.command,
            args: mcpConfig.args || [],
          };
        }
      }
    }

    if (config.resume && fs.existsSync(sessionFile)) {
      // Resume existing session
      try {
        const savedSession = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
        sessionId = savedSession.threadId;
        thread = this.codex.resumeThread(sessionId!, threadOptions);
        console.error(`[codex-provider] Resuming session ${sessionId} for ${name} in ${config.workdir}`);
      } catch {
        // Fall back to new thread if resume fails
        thread = this.codex.startThread(threadOptions);
        sessionId = uuidv4();
        console.error(`[codex-provider] Resume failed, starting new session for ${name} in ${config.workdir}`);
      }
    } else {
      // Start new thread
      thread = this.codex.startThread(threadOptions);
      sessionId = uuidv4();
      console.error(`[codex-provider] Starting new session for ${name} in ${config.workdir}`);
    }

    const handle: AgentHandle = {
      id: uuidv4(),
      channel,
      name,
      engine: "codex",
      sessionId,
    };

    const agentState: CodexAgentState = {
      handle,
      thread,
      config,
      state: "starting",
      pendingMessages: [],
      isRunActive: false,
      systemPromptSent: false,
      outputCallbacks: [],
      stateCallbacks: [],
      abortController: new AbortController(),
    };

    this.agents.set(key, agentState);

    // Save session ID for future resume
    fs.writeFileSync(sessionFile, JSON.stringify({ threadId: sessionId }));

    // Transition to idle
    this.setState(agentState, "idle");

    // Send system prompt + track channel immediately (don't await - let it run in background)
    if (config.systemPrompt) {
      const initialPrompt = `${config.systemPrompt}\n\n---\n\nTrack channel #${channel} using the track_channel MCP tool and introduce yourself to the channel. Your name is ${name}.`;
      this.runTurn(agentState, initialPrompt).catch((err) => {
        console.error(`[codex-provider] Failed to send initial prompt for ${name}:`, err);
      });
      agentState.systemPromptSent = true;
    }

    return handle;
  }

  /**
   * Send a message to the agent.
   * If a turn is active, the message is queued and delivered on turn completion.
   */
  async sendMessage(handle: AgentHandle, content: string): Promise<void> {
    const agentState = this.getAgentState(handle);

    if (agentState.isRunActive) {
      // Queue message for delivery after current turn
      agentState.pendingMessages.push(content);
      console.error(`[codex-provider] Queued message for ${handle.name} (${agentState.pendingMessages.length} pending)`);

      // Emit system event about queued message
      this.emitOutput(agentState, {
        type: "system",
        timestamp: new Date().toISOString(),
        content: `Message queued (${agentState.pendingMessages.length} pending)`,
        metadata: { pendingCount: agentState.pendingMessages.length },
      });
    } else {
      // Run immediately
      await this.runTurn(agentState, content);
    }
  }

  /**
   * Execute a turn with the given prompt.
   */
  private async runTurn(agentState: CodexAgentState, prompt: string): Promise<void> {
    agentState.isRunActive = true;
    this.setState(agentState, "thinking");

    // Prepend system prompt on first message
    let fullPrompt = prompt;
    if (!agentState.systemPromptSent && agentState.config.systemPrompt) {
      fullPrompt = `${agentState.config.systemPrompt}\n\n---\n\n${prompt}`;
      agentState.systemPromptSent = true;
    }

    try {
      const { events } = await agentState.thread.runStreamed(fullPrompt);

      for await (const event of events) {
        if (agentState.abortController.signal.aborted) {
          break;
        }
        this.handleCodexEvent(agentState, event);
      }

      // Turn completed
      this.setState(agentState, "idle");
    } catch (err: unknown) {
      // Normalize the error for consistent handling
      const providerError = normalizeError(err, this.name, `Turn failed for ${agentState.handle.name}`);
      console.error(`[codex-provider] Error in turn for ${agentState.handle.name}:`, {
        code: providerError.code,
        message: providerError.message,
        retryable: providerError.retryable,
        rawError: err,
      });
      this.setState(agentState, "error");
      this.emitOutput(agentState, {
        type: "error",
        timestamp: new Date().toISOString(),
        content: providerError.message,
        metadata: {
          code: providerError.code,
          retryable: providerError.retryable,
        },
      });
    } finally {
      agentState.isRunActive = false;

      // Flush pending messages
      await this.flushPendingMessages(agentState);
    }
  }

  /**
   * Flush queued messages after turn completion.
   */
  private async flushPendingMessages(agentState: CodexAgentState): Promise<void> {
    if (agentState.pendingMessages.length === 0) return;

    const count = agentState.pendingMessages.length;
    // Combine all pending messages
    const combined = agentState.pendingMessages.join("\n\n---\n\n");
    agentState.pendingMessages = [];

    console.error(`[codex-provider] Flushing ${count} pending messages for ${agentState.handle.name}`);

    // Run with combined messages
    await this.runTurn(agentState, combined);
  }

  /**
   * Handle a Codex SDK event and map to AgentOutput.
   */
  private handleCodexEvent(agentState: CodexAgentState, event: any): void {
    switch (event.type) {
      case "turn.started":
        this.setState(agentState, "thinking");
        this.emitOutput(agentState, {
          type: "system",
          timestamp: new Date().toISOString(),
          content: "Turn started",
        });
        break;

      case "turn.completed":
        this.setState(agentState, "idle");
        this.emitOutput(agentState, {
          type: "system",
          timestamp: new Date().toISOString(),
          content: "Turn completed",
          metadata: event.usage ? {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
            cachedInputTokens: event.usage.cached_input_tokens,
          } : undefined,
        });
        break;

      case "turn.failed":
        this.setState(agentState, "error");
        this.emitOutput(agentState, {
          type: "error",
          timestamp: new Date().toISOString(),
          content: event.error?.message || "Turn failed",
          metadata: { errorCode: event.error?.code },
        });
        break;

      case "item.started":
      case "item.updated":
        this.handleItemEvent(agentState, event.item, false);
        break;

      case "item.completed":
        this.handleItemEvent(agentState, event.item, true);
        break;

      default:
        // Unknown event type - log but don't fail
        console.error(`[codex-provider] Unknown event type: ${event.type}`);
    }
  }

  /**
   * Handle a Codex item event (agent_message, reasoning, command_execution, etc.)
   */
  private handleItemEvent(agentState: CodexAgentState, item: any, completed: boolean): void {
    if (!item) return;

    switch (item.type) {
      case "agent_message":
        this.emitOutput(agentState, {
          type: "text",
          timestamp: new Date().toISOString(),
          content: item.text || "",
        });
        break;

      case "reasoning":
        this.emitOutput(agentState, {
          type: "reasoning",
          timestamp: new Date().toISOString(),
          content: item.text || "",
        });
        break;

      case "command_execution":
        if (completed) {
          // Emit tool_result on completion
          this.setState(agentState, "idle");
          this.emitOutput(agentState, {
            type: "tool_result",
            timestamp: new Date().toISOString(),
            content: item.aggregated_output || "",
            toolName: "Bash",
            toolResult: {
              exitCode: item.exit_code,
              output: item.aggregated_output,
            },
          });
        } else {
          // Emit tool_call on start
          this.setState(agentState, "tool_running");
          this.emitOutput(agentState, {
            type: "tool_call",
            timestamp: new Date().toISOString(),
            content: this.formatToolStatus("Bash", item.command),
            toolName: "Bash",
            toolInput: { command: item.command },
          });
        }
        break;

      case "mcp_tool_call":
        if (completed) {
          this.setState(agentState, "idle");
          this.emitOutput(agentState, {
            type: "tool_result",
            timestamp: new Date().toISOString(),
            content: JSON.stringify(item.result || {}),
            toolName: item.tool,
            toolResult: item.result,
          });
        } else {
          this.setState(agentState, "tool_running");
          this.emitOutput(agentState, {
            type: "tool_call",
            timestamp: new Date().toISOString(),
            content: this.formatToolStatus(item.tool, item.arguments),
            toolName: item.tool,
            toolInput: item.arguments,
          });
        }
        break;

      case "file_change":
        this.emitOutput(agentState, {
          type: "tool_result",
          timestamp: new Date().toISOString(),
          content: `File ${item.action || "changed"}: ${item.path || "unknown"}`,
          toolName: "FileChange",
          toolResult: item,
        });
        break;

      case "web_search":
        this.emitOutput(agentState, {
          type: "tool_call",
          timestamp: new Date().toISOString(),
          content: `Searching: ${item.query || ""}`,
          toolName: "WebSearch",
          toolInput: { query: item.query },
        });
        break;

      case "todo_list":
        // Internal task tracking - emit as system
        this.emitOutput(agentState, {
          type: "system",
          timestamp: new Date().toISOString(),
          content: "Task list updated",
          metadata: { todos: item.todos },
        });
        break;

      default:
        console.error(`[codex-provider] Unknown item type: ${item.type}`);
    }
  }

  /**
   * Format tool status for display.
   */
  private formatToolStatus(toolName: string | undefined, input: any): string {
    const truncate = (s: string, len = 40) =>
      s.length > len ? s.slice(0, len) + "..." : s;

    if (!toolName) {
      return "Running tool";
    }
    if (toolName === "Bash" && typeof input === "string") {
      return `> ${truncate(input, 50)}`;
    }
    if (toolName === "Bash" && input?.command) {
      return `> ${truncate(input.command, 50)}`;
    }
    if (toolName.includes("send_message")) {
      return "Sending message";
    }
    if (toolName.includes("track_channel")) {
      return `Joining channel`;
    }
    return toolName;
  }

  /**
   * Terminate the agent.
   */
  async kick(handle: AgentHandle): Promise<void> {
    const key = this.getAgentKey(handle.channel, handle.name);
    const agentState = this.agents.get(key);

    if (!agentState) {
      throw createProviderError(
        `Agent ${handle.name} not found in #${handle.channel}`,
        "session_error",
        this.name
      );
    }

    console.error(`[codex-provider] Kicking ${handle.name} from #${handle.channel}`);

    // Abort any active run
    agentState.abortController.abort();

    // Set state to stopped
    this.setState(agentState, "stopped");

    // Clean up
    this.agents.delete(key);
  }

  /**
   * Get count of pending messages.
   */
  getPendingMessageCount(handle: AgentHandle): number {
    const agentState = this.getAgentState(handle);
    return agentState.pendingMessages.length;
  }

  /**
   * Register callback for output events.
   */
  onOutput(handle: AgentHandle, callback: OutputCallback): void {
    const agentState = this.getAgentState(handle);
    agentState.outputCallbacks.push(callback);
  }

  /**
   * Register callback for state changes.
   */
  onStateChange(handle: AgentHandle, callback: StateChangeCallback): void {
    const agentState = this.getAgentState(handle);
    agentState.stateCallbacks.push(callback);
  }

  /**
   * Check if a previous session can be resumed.
   */
  async canResume(channel: string, name: string): Promise<boolean> {
    const workdir = path.join(
      "/tmp/powpow",
      `${this.slugify(channel)}--${this.slugify(name)}`
    );
    const sessionFile = path.join(workdir, ".codex-session");
    return fs.existsSync(sessionFile);
  }

  /**
   * Get current agent state.
   */
  getState(handle: AgentHandle): AgentState {
    const agentState = this.getAgentState(handle);
    return agentState.state;
  }

  /**
   * Get agent's working directory.
   */
  getWorkdir(handle: AgentHandle): string {
    const agentState = this.getAgentState(handle);
    return agentState.config.workdir;
  }

  // Private helpers

  private getAgentState(handle: AgentHandle): CodexAgentState {
    const key = this.getAgentKey(handle.channel, handle.name);
    const agentState = this.agents.get(key);
    if (!agentState) {
      throw createProviderError(
        `Agent ${handle.name} not found in #${handle.channel}`,
        "session_error",
        this.name
      );
    }
    return agentState;
  }

  private setState(agentState: CodexAgentState, newState: AgentState): void {
    const previousState = agentState.state;
    if (previousState === newState) return;

    agentState.state = newState;

    for (const callback of agentState.stateCallbacks) {
      try {
        callback(newState, previousState);
      } catch (err) {
        console.error("[codex-provider] Error in state callback:", err);
      }
    }
  }

  private emitOutput(agentState: CodexAgentState, output: AgentOutput): void {
    for (const callback of agentState.outputCallbacks) {
      try {
        callback(output);
      } catch (err) {
        console.error("[codex-provider] Error in output callback:", err);
      }
    }
  }
}
