/**
 * Claude Provider Implementation
 *
 * Implements CodingAgentProvider for Claude using the @anthropic-ai/claude-agent-sdk.
 * Wraps the existing agent-sdk.ts patterns with the unified provider interface.
 */

import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
import {
  CodingAgentProvider,
  AgentConfig,
  AgentHandle,
  AgentState,
  AgentOutput,
  AgentOutputType,
  ProviderCapabilities,
  ProviderError,
  OutputCallback,
  StateChangeCallback,
} from "../agent-provider.js";

/**
 * Pushable async iterable for sending messages to Claude agents.
 * Enables mid-turn message injection via the SDK's streaming interface.
 */
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
      resolve({ value: undefined as T, done: true });
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
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

/**
 * Internal agent state tracked by the provider.
 */
interface ClaudeAgentState {
  handle: AgentHandle;
  query: Query;
  input: Pushable<SDKUserMessage>;
  abortController: AbortController;
  state: AgentState;
  workdir: string;
  outputCallbacks: OutputCallback[];
  stateChangeCallbacks: StateChangeCallback[];
}

/**
 * Claude provider implementation using the claude-agent-sdk.
 */
export class ClaudeProvider implements CodingAgentProvider {
  readonly name = "claude";

  readonly capabilities: ProviderCapabilities = {
    supportsMidTurnMessages: true, // Pushable pattern enables this
    supportsInterruption: true, // AbortController
    exposesReasoning: false, // Claude doesn't expose thinking traces in SDK
    supportsSessionResume: true, // .claude folder persistence
  };

  private agents = new Map<string, ClaudeAgentState>();

  private getAgentKey(channel: string, name: string): string {
    return `${channel}:${name}`;
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }

  /**
   * Format tool status for display.
   */
  private formatToolStatus(toolName: string, input: unknown): string {
    const inp = input as Record<string, unknown>;
    const truncate = (s: string, len = 40) =>
      s.length > len ? s.slice(0, len) + "…" : s;

    // Strip mcp__ prefixes for cleaner names
    const cleanName = toolName.replace(/^mcp__\w+__/, "");

    switch (cleanName) {
      case "Bash":
        return inp.command
          ? `> ${truncate(String(inp.command), 50)}`
          : "Running shell";
      case "Read":
        return inp.file_path
          ? `Reading ${truncate(String(inp.file_path).split("/").pop() || "", 30)}`
          : "Reading file";
      case "Write":
        return inp.file_path
          ? `Writing ${truncate(String(inp.file_path).split("/").pop() || "", 30)}`
          : "Writing file";
      case "Edit":
        return inp.file_path
          ? `Editing ${truncate(String(inp.file_path).split("/").pop() || "", 30)}`
          : "Editing file";
      case "Grep":
        return inp.pattern
          ? `Searching: ${truncate(String(inp.pattern), 30)}`
          : "Searching";
      case "Glob":
        return inp.pattern
          ? `Finding: ${truncate(String(inp.pattern), 30)}`
          : "Finding files";
      case "Task":
        return inp.description
          ? truncate(String(inp.description), 40)
          : "Running task";
      case "WebFetch":
        return inp.url
          ? `Fetching ${truncate(String(inp.url), 35)}`
          : "Fetching URL";
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

  /**
   * Emit output to all registered callbacks.
   */
  private emitOutput(agentState: ClaudeAgentState, output: AgentOutput): void {
    for (const callback of agentState.outputCallbacks) {
      try {
        callback(output);
      } catch (err) {
        console.error(`[claude-provider] Output callback error:`, err);
      }
    }
  }

  /**
   * Update state and notify callbacks.
   */
  private setState(
    agentState: ClaudeAgentState,
    newState: AgentState,
    status?: string
  ): void {
    const previousState = agentState.state;
    agentState.state = newState;

    for (const callback of agentState.stateChangeCallbacks) {
      try {
        callback(newState, previousState);
      } catch (err) {
        console.error(`[claude-provider] State change callback error:`, err);
      }
    }

    // Emit system output for state changes
    if (status) {
      this.emitOutput(agentState, {
        type: "system",
        timestamp: new Date().toISOString(),
        content: status,
      });
    }
  }

  /**
   * Handle SDK messages and map to unified output format.
   */
  private handleMessage(agentState: ClaudeAgentState, message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          agentState.handle.sessionId = message.session_id;
          this.setState(agentState, "idle");
          this.emitOutput(agentState, {
            type: "system",
            timestamp: new Date().toISOString(),
            content: `Initialized with model ${message.model}, ${message.tools.length} tools available`,
            metadata: {
              model: message.model,
              toolCount: message.tools.length,
            },
          });
        }
        break;

      case "assistant":
        this.setState(agentState, "thinking");
        for (const block of message.message.content) {
          if (block.type === "text") {
            this.emitOutput(agentState, {
              type: "text",
              timestamp: new Date().toISOString(),
              content: block.text,
            });
          } else if (block.type === "tool_use") {
            const toolStatus = this.formatToolStatus(block.name, block.input);
            this.setState(agentState, "tool_running", toolStatus);
            this.emitOutput(agentState, {
              type: "tool_call",
              timestamp: new Date().toISOString(),
              content: toolStatus,
              toolName: block.name,
              toolInput: block.input,
            });
          }
        }
        break;

      case "tool_progress":
        this.setState(
          agentState,
          "tool_running",
          `${message.tool_name} (${Math.round(message.elapsed_time_seconds)}s)`
        );
        break;

      case "result":
        if (message.subtype === "success") {
          this.setState(agentState, "idle");
          this.emitOutput(agentState, {
            type: "system",
            timestamp: new Date().toISOString(),
            content: `Completed: ${message.result.slice(0, 200)}${message.result.length > 200 ? "..." : ""}`,
          });
        } else {
          this.setState(agentState, "error");
          this.emitOutput(agentState, {
            type: "error",
            timestamp: new Date().toISOString(),
            content: `Error: ${message.subtype} - ${(message as Record<string, unknown>).errors || "Unknown error"}`,
          });
        }
        break;
    }
  }

  /**
   * Process the message stream from the SDK.
   */
  private async processMessages(
    key: string,
    agentState: ClaudeAgentState
  ): Promise<void> {
    try {
      for await (const message of agentState.query) {
        this.handleMessage(agentState, message);
      }
    } catch (err: unknown) {
      const errorMessage =
        err instanceof Error ? err.message : String(err);
      console.error(
        `[claude-provider] Error in ${agentState.handle.name}:`,
        err
      );
      this.setState(agentState, "error");
      this.emitOutput(agentState, {
        type: "error",
        timestamp: new Date().toISOString(),
        content: errorMessage,
      });
    } finally {
      console.error(`[claude-provider] Agent ${agentState.handle.name} stopped`);
      this.setState(agentState, "stopped");
      this.agents.delete(key);
    }
  }

  async spawn(
    channel: string,
    name: string,
    config: AgentConfig
  ): Promise<AgentHandle> {
    const key = this.getAgentKey(channel, name);

    if (this.agents.has(key)) {
      throw new ProviderError(
        `Agent ${name} is already running in #${channel}`,
        "session_error",
        false,
        this.name
      );
    }

    const workdir =
      config.workdir ||
      path.join("/tmp/powpow", `${this.slugify(channel)}--${this.slugify(name)}`);

    // Create workdir if needed
    if (!fs.existsSync(workdir)) {
      fs.mkdirSync(workdir, { recursive: true });
    }

    // The SDK persists sessions to ~/.claude/projects/ (not to .claude in workdir)
    // When config.resume is true, use continue: true to resume the most recent session for this cwd
    const shouldContinue = config.resume ?? false;

    const handle: AgentHandle = {
      id: `claude-${channel}-${name}-${Date.now()}`,
      channel,
      name,
      engine: "claude",
      sessionId: undefined,
    };

    const input = new Pushable<SDKUserMessage>();
    const abortController = new AbortController();

    // Build MCP servers config - support stdio, sse, and http types
    const mcpServers: Record<string, {
      type?: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    } | {
      type: "sse" | "http";
      url: string;
      headers?: Record<string, string>;
    }> = {};

    if (config.mcpServers) {
      for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
        if (serverConfig.type === "stdio" && serverConfig.command) {
          // stdio MCP server (shell command)
          mcpServers[serverName] = {
            type: "stdio",
            command: serverConfig.command,
            args: serverConfig.args,
            env: serverConfig.env,
          };
          console.error(`[claude-provider] Adding stdio MCP server: ${serverName} (${serverConfig.command})`);
        } else if ((serverConfig.type === "sse" || serverConfig.type === "http") && serverConfig.url) {
          // HTTP or SSE MCP server
          mcpServers[serverName] = {
            type: serverConfig.type,
            url: serverConfig.url,
            headers: serverConfig.headers,
          };
          console.error(`[claude-provider] Adding ${serverConfig.type} MCP server: ${serverName} (${serverConfig.url})`);
        }
      }
    }

    const options: Options = {
      model: config.model || "claude-opus-4-5-20251101",
      cwd: workdir,
      systemPrompt: config.systemPrompt
        ? {
            type: "preset",
            preset: "claude_code",
            append: config.systemPrompt,
          }
        : {
            type: "preset",
            preset: "claude_code",
          },
      mcpServers,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      includePartialMessages: true,
      abortController,
      continue: shouldContinue,
    };

    try {
      console.error(
        `[claude-provider] Spawning ${name} in #${channel} (workdir: ${workdir})`
      );

      const q = query({ prompt: input, options });

      const agentState: ClaudeAgentState = {
        handle,
        query: q,
        input,
        abortController,
        state: "starting",
        workdir,
        outputCallbacks: [],
        stateChangeCallbacks: [],
      };

      this.agents.set(key, agentState);

      // Start processing messages in background
      this.processMessages(key, agentState);

      return handle;
    } catch (err) {
      console.error(`[claude-provider] Failed to spawn ${name}:`, err);
      this.agents.delete(key);
      throw new ProviderError(
        `Failed to spawn ${name}: ${err}`,
        "unknown",
        true,
        this.name,
        err
      );
    }
  }

  async sendMessage(handle: AgentHandle, content: string): Promise<void> {
    const key = this.getAgentKey(handle.channel, handle.name);
    const agentState = this.agents.get(key);

    if (!agentState) {
      throw new ProviderError(
        `Agent ${handle.name} not found in #${handle.channel}`,
        "session_error",
        false,
        this.name
      );
    }

    agentState.input.push({
      type: "user",
      message: {
        role: "user",
        content,
      },
      parent_tool_use_id: null,
      session_id: handle.sessionId || "",
    });
  }

  async kick(handle: AgentHandle): Promise<void> {
    const key = this.getAgentKey(handle.channel, handle.name);
    const agentState = this.agents.get(key);

    if (!agentState) {
      throw new ProviderError(
        `Agent ${handle.name} not found in #${handle.channel}`,
        "session_error",
        false,
        this.name
      );
    }

    console.error(
      `[claude-provider] Kicking ${handle.name} from #${handle.channel}`
    );
    agentState.abortController.abort();
    agentState.input.end();
  }

  getPendingMessageCount(_handle: AgentHandle): number {
    // Claude supports mid-turn messages, so there's never a pending queue
    return 0;
  }

  onOutput(handle: AgentHandle, callback: OutputCallback): void {
    const key = this.getAgentKey(handle.channel, handle.name);
    const agentState = this.agents.get(key);

    if (agentState) {
      agentState.outputCallbacks.push(callback);
    }
  }

  onStateChange(handle: AgentHandle, callback: StateChangeCallback): void {
    const key = this.getAgentKey(handle.channel, handle.name);
    const agentState = this.agents.get(key);

    if (agentState) {
      agentState.stateChangeCallbacks.push(callback);
    }
  }

  async canResume(channel: string, name: string): Promise<boolean> {
    // The SDK persists sessions to ~/.claude/projects/ by default (persistSession: true)
    // We can always attempt to resume - if no session exists, SDK starts a new one
    // The session is keyed by the cwd, so check if workdir exists as a proxy
    const workdir = path.join(
      "/tmp/powpow",
      `${this.slugify(channel)}--${this.slugify(name)}`
    );
    return fs.existsSync(workdir);
  }

  getState(handle: AgentHandle): AgentState {
    const key = this.getAgentKey(handle.channel, handle.name);
    const agentState = this.agents.get(key);
    return agentState?.state || "stopped";
  }

  getWorkdir(handle: AgentHandle): string {
    const key = this.getAgentKey(handle.channel, handle.name);
    const agentState = this.agents.get(key);
    return agentState?.workdir || "";
  }
}
