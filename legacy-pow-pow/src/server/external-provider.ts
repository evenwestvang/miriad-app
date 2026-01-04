/**
 * ExternalProvider - Custom Binary Backend for PowPow
 *
 * Implements CodingAgentProvider interface for external agent binaries.
 * Key features:
 * - Subprocess spawning with stdio pipes
 * - JSON-RPC 2.0 over NDJSON (newline-delimited JSON)
 * - Three-phase handshake (ready → initialize → ack)
 * - Dynamic capabilities from binary's ready message
 * - Message queue pattern for mid-turn messaging limitation
 * - Graceful shutdown with timeout + SIGTERM/SIGKILL fallback
 */

import { spawn, type ChildProcess } from "child_process";
import * as readline from "readline";
import * as fs from "fs";
import * as path from "path";
import { v4 as uuidv4 } from "uuid";
import {
  type CodingAgentProvider,
  type AgentConfig,
  type AgentHandle,
  type AgentState,
  type AgentOutput,
  type ProviderCapabilities,
  type OutputCallback,
  type StateChangeCallback,
  ProviderError,
} from "./agent-provider.js";
import { createProviderError } from "./error-utils.js";

// --- JSON-RPC 2.0 Types ---

interface JsonRpcRequest {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
  id: number | string;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  id: number | string;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

// --- Protocol Types ---

interface AgentReadyParams {
  protocolVersion: string;
  engineName: string;
  engineVersion: string;
  capabilities: {
    supportsMidTurnMessages?: boolean;
    supportsInterruption?: boolean;
    exposesReasoning?: boolean;
    supportsSessionResume?: boolean;
  };
}

interface AgentOutputParams {
  type?: string;
  content?: string;
}

interface AgentToolCallParams {
  name?: string;
  tool?: string;
  input?: unknown;
  arguments?: unknown;
}

interface AgentToolResultParams {
  name?: string;
  tool?: string;
  result?: unknown;
  elapsed?: number;
}

interface AgentProgressParams {
  status?: string;
  message?: string;
}

interface AgentErrorParams {
  code?: string;
  message?: string;
  retryable?: boolean;
}

// --- Internal State ---

interface ExternalAgentState {
  handle: AgentHandle;
  process: ChildProcess;
  config: AgentConfig;
  state: AgentState;
  capabilities: ProviderCapabilities;
  pendingMessages: string[];
  isRunActive: boolean;
  isShuttingDown: boolean;
  outputCallbacks: OutputCallback[];
  stateCallbacks: StateChangeCallback[];
  pendingRequests: Map<number | string, {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
  }>;
  nextRequestId: number;
  readline: readline.Interface;
}

/** Default capabilities until binary reports its own */
const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  supportsMidTurnMessages: false,
  supportsInterruption: true,
  exposesReasoning: false,
  supportsSessionResume: true,
};

/** Timeout for binary to send agent/ready (ms) */
const READY_TIMEOUT = 30000;

/** Timeout for graceful shutdown (ms) */
const SHUTDOWN_TIMEOUT = 10000;

/** Grace period after SIGTERM before SIGKILL (ms) */
const SIGKILL_GRACE = 1000;

/**
 * ExternalProvider implements CodingAgentProvider for external binaries.
 *
 * Architecture:
 * - Spawns binary as subprocess with stdio pipes
 * - NDJSON framing (one JSON object per line)
 * - JSON-RPC 2.0 protocol
 * - Capabilities declared by binary in agent/ready message
 */
export class ExternalProvider implements CodingAgentProvider {
  /** Provider name used for registry lookup - set from constructor */
  readonly name: string;

  // Capabilities are dynamic per-agent, but we need a default for the interface
  // The actual capabilities come from each binary's agent/ready message
  readonly capabilities: ProviderCapabilities = DEFAULT_CAPABILITIES;

  private agents = new Map<string, ExternalAgentState>();

  constructor(
    private binaryPath: string,
    private binaryArgs: string[] = [],
    engineName: string = "external"
  ) {
    this.name = engineName;
  }

  private getAgentKey(channel: string, name: string): string {
    return `${channel}:${name}`;
  }

  private slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  /**
   * Spawn a new external agent or resume an existing session.
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
        this.cleanup(existing);
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

    // Spawn the binary
    console.error(`[external-provider] Spawning ${this.binaryPath} for ${name} in ${config.workdir}`);
    const proc = spawn(this.binaryPath, this.binaryArgs, {
      cwd: config.workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        POWPOW_WORKDIR: config.workdir,
        POWPOW_CHANNEL: channel,
        POWPOW_AGENT_NAME: name,
      },
    });

    // Handle spawn errors
    if (!proc.pid) {
      throw createProviderError(
        `Failed to spawn binary: ${this.binaryPath}`,
        "invalid_config",
        this.name
      );
    }

    const handle: AgentHandle = {
      id: uuidv4(),
      channel,
      name,
      engine: this.name,
    };

    // Create readline interface for NDJSON parsing
    const rl = readline.createInterface({
      input: proc.stdout!,
      crlfDelay: Infinity,
    });

    const agentState: ExternalAgentState = {
      handle,
      process: proc,
      config,
      state: "starting",
      capabilities: { ...DEFAULT_CAPABILITIES },
      pendingMessages: [],
      isRunActive: false,
      isShuttingDown: false,
      outputCallbacks: [],
      stateCallbacks: [],
      pendingRequests: new Map(),
      nextRequestId: 1,
      readline: rl,
    };

    this.agents.set(key, agentState);

    // Wire up event handlers
    this.setupProcessHandlers(agentState);

    try {
      // Phase 1: Wait for agent/ready notification
      const readyParams = await this.waitForReady(agentState);

      // Update capabilities from binary's declaration
      agentState.capabilities = {
        supportsMidTurnMessages: readyParams.capabilities.supportsMidTurnMessages ?? false,
        supportsInterruption: readyParams.capabilities.supportsInterruption ?? true,
        exposesReasoning: readyParams.capabilities.exposesReasoning ?? false,
        supportsSessionResume: readyParams.capabilities.supportsSessionResume ?? true,
      };

      // Update engine name from binary
      handle.engine = readyParams.engineName || this.name;

      console.error(`[external-provider] Binary ready: ${readyParams.engineName} v${readyParams.engineVersion}`);
      console.error(`[external-provider] Capabilities:`, agentState.capabilities);

      // Phase 2: Send agent/initialize request
      const initParams = {
        protocolVersion: "1.0",
        config: {
          workDir: config.workdir,
          model: config.model,
          resume: config.resume ?? false,
        },
        credentials: {}, // Could pass API keys here if needed
        mcpServers: config.mcpServers || {},
      };

      // Phase 3: Wait for ack response
      const initResult = await this.sendRequest(agentState, "agent/initialize", initParams);
      console.error(`[external-provider] Initialize ack:`, initResult);

      // Save session info
      const sessionFile = path.join(config.workdir, `.${this.slugify(handle.engine)}-session`);
      fs.writeFileSync(sessionFile, JSON.stringify({
        handleId: handle.id,
        engine: handle.engine,
        createdAt: new Date().toISOString(),
      }));

      // Transition to idle
      this.setState(agentState, "idle");

      // Send system prompt + track channel if provided
      if (config.systemPrompt) {
        const initialPrompt = `${config.systemPrompt}\n\n---\n\nTrack channel #${channel} using the track_channel MCP tool and introduce yourself to the channel. Your name is ${name}.`;
        this.runTurn(agentState, initialPrompt).catch((err) => {
          console.error(`[external-provider] Failed to send initial prompt for ${name}:`, err);
        });
      }

      return handle;
    } catch (err) {
      // Cleanup on failure
      this.cleanup(agentState);
      this.agents.delete(key);
      throw err;
    }
  }

  /**
   * Set up process event handlers.
   */
  private setupProcessHandlers(agentState: ExternalAgentState): void {
    const { process: proc, readline: rl } = agentState;

    // Handle stdout lines (NDJSON)
    rl.on("line", (line) => {
      this.handleLine(agentState, line);
    });

    // Handle stderr (log for debugging)
    proc.stderr?.on("data", (data) => {
      console.error(`[external-provider:${agentState.handle.name}:stderr] ${data.toString().trim()}`);
    });

    // Handle process exit
    proc.on("exit", (code, signal) => {
      console.error(`[external-provider] Process exited: code=${code}, signal=${signal}`);
      if (agentState.state !== "stopped" && !agentState.isShuttingDown) {
        this.setState(agentState, "error");
        this.emitOutput(agentState, {
          type: "error",
          timestamp: new Date().toISOString(),
          content: `Process exited unexpectedly: code=${code}, signal=${signal}`,
        });
      }
      // Reject any pending requests
      for (const [, pending] of agentState.pendingRequests) {
        pending.reject(new Error(`Process exited: code=${code}, signal=${signal}`));
      }
      agentState.pendingRequests.clear();
    });

    // Handle process error
    proc.on("error", (err) => {
      console.error(`[external-provider] Process error:`, err);
      this.setState(agentState, "error");
      this.emitOutput(agentState, {
        type: "error",
        timestamp: new Date().toISOString(),
        content: `Process error: ${err.message}`,
      });
    });
  }

  /**
   * Handle a line of NDJSON from stdout.
   */
  private handleLine(agentState: ExternalAgentState, line: string): void {
    if (!line.trim()) return;

    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch (err) {
      console.error(`[external-provider] Parse error: ${err}, line: ${line}`);
      return;
    }

    // Check if this is a response to a pending request
    if ("id" in msg && msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const pending = agentState.pendingRequests.get(msg.id);
      if (pending) {
        agentState.pendingRequests.delete(msg.id);
        if ("error" in msg && msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
        return;
      }
    }

    // Handle notification
    if ("method" in msg) {
      this.handleNotification(agentState, msg.method, msg.params || {});
    }
  }

  /**
   * Handle a JSON-RPC notification from the binary.
   */
  private handleNotification(
    agentState: ExternalAgentState,
    method: string,
    params: Record<string, unknown>
  ): void {
    const timestamp = new Date().toISOString();

    switch (method) {
      case "agent/ready":
        // Handled separately in waitForReady
        break;

      case "agent/output": {
        const p = params as AgentOutputParams;
        this.emitOutput(agentState, {
          type: "text",
          timestamp,
          content: p.content || "",
        });
        break;
      }

      case "agent/tool_call": {
        const p = params as AgentToolCallParams;
        this.setState(agentState, "tool_running");
        this.emitOutput(agentState, {
          type: "tool_call",
          timestamp,
          content: `Calling ${p.name || p.tool || "tool"}`,
          toolName: p.name || p.tool,
          toolInput: p.input || p.arguments,
        });
        break;
      }

      case "agent/tool_result": {
        const p = params as AgentToolResultParams;
        this.setState(agentState, "thinking");
        this.emitOutput(agentState, {
          type: "tool_result",
          timestamp,
          content: JSON.stringify(p.result || {}),
          toolName: p.name || p.tool,
          toolResult: p.result,
          elapsedTime: p.elapsed,
        });
        break;
      }

      case "agent/progress": {
        const p = params as AgentProgressParams;
        // Map status to state if provided
        if (p.status === "working" || p.status === "thinking") {
          this.setState(agentState, "thinking");
        } else if (p.status === "idle") {
          this.setState(agentState, "idle");
        }
        this.emitOutput(agentState, {
          type: "system",
          timestamp,
          content: p.message || p.status || "Progress update",
        });
        break;
      }

      case "agent/error": {
        const p = params as AgentErrorParams;
        this.emitOutput(agentState, {
          type: "error",
          timestamp,
          content: p.message || "Unknown error",
          metadata: {
            code: p.code,
            retryable: p.retryable,
          },
        });
        break;
      }

      case "agent/reasoning": {
        this.emitOutput(agentState, {
          type: "reasoning",
          timestamp,
          content: (params as { content?: string }).content || "",
        });
        break;
      }

      default:
        console.error(`[external-provider] Unknown notification: ${method}`);
    }
  }

  /**
   * Wait for the agent/ready notification.
   */
  private waitForReady(agentState: ExternalAgentState): Promise<AgentReadyParams> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(createProviderError(
          `Timeout waiting for agent/ready from ${this.binaryPath}`,
          "timeout",
          this.name
        ));
      }, READY_TIMEOUT);

      // Temporarily override line handler to catch ready message
      const originalHandler = agentState.readline.listeners("line")[0] as (line: string) => void;
      agentState.readline.removeAllListeners("line");

      agentState.readline.on("line", (line) => {
        if (!line.trim()) return;

        try {
          const msg = JSON.parse(line);
          if (msg.method === "agent/ready") {
            clearTimeout(timeout);
            // Restore original handler
            agentState.readline.removeAllListeners("line");
            agentState.readline.on("line", (l) => this.handleLine(agentState, l));
            resolve(msg.params as AgentReadyParams);
          } else {
            // Pass through other messages
            this.handleLine(agentState, line);
          }
        } catch (err) {
          console.error(`[external-provider] Parse error waiting for ready: ${err}`);
        }
      });
    });
  }

  /**
   * Send a JSON-RPC request and wait for response.
   * TODO: Add per-request timeout (30s default) to handle hung binaries.
   */
  private sendRequest(
    agentState: ExternalAgentState,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = agentState.nextRequestId++;
      const request: JsonRpcRequest = {
        jsonrpc: "2.0",
        method,
        params,
        id,
      };

      agentState.pendingRequests.set(id, { resolve, reject });

      const line = JSON.stringify(request) + "\n";
      agentState.process.stdin?.write(line, (err) => {
        if (err) {
          agentState.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  private sendNotification(
    agentState: ExternalAgentState,
    method: string,
    params?: Record<string, unknown>
  ): void {
    const notification: JsonRpcNotification = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const line = JSON.stringify(notification) + "\n";
    agentState.process.stdin?.write(line);
  }

  /**
   * Send a message to the agent.
   * If a turn is active, the message is queued and delivered on turn completion.
   */
  async sendMessage(handle: AgentHandle, content: string): Promise<void> {
    const agentState = this.getAgentState(handle);

    if (agentState.isRunActive && !agentState.capabilities.supportsMidTurnMessages) {
      // Queue message for delivery after current turn
      agentState.pendingMessages.push(content);
      console.error(`[external-provider] Queued message for ${handle.name} (${agentState.pendingMessages.length} pending)`);

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
  private async runTurn(agentState: ExternalAgentState, prompt: string): Promise<void> {
    agentState.isRunActive = true;
    this.setState(agentState, "thinking");

    try {
      // Send execute request
      await this.sendRequest(agentState, "agent/execute", {
        task: prompt,
        taskId: uuidv4(),
      });

      // Turn completed
      this.setState(agentState, "idle");
    } catch (err) {
      console.error(`[external-provider] Error in turn for ${agentState.handle.name}:`, err);
      this.setState(agentState, "error");
      this.emitOutput(agentState, {
        type: "error",
        timestamp: new Date().toISOString(),
        content: err instanceof Error ? err.message : String(err),
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
  private async flushPendingMessages(agentState: ExternalAgentState): Promise<void> {
    if (agentState.pendingMessages.length === 0) return;
    if (agentState.state === "error" || agentState.state === "stopped") return;

    const count = agentState.pendingMessages.length;
    const combined = agentState.pendingMessages.join("\n\n---\n\n");
    agentState.pendingMessages = [];

    console.error(`[external-provider] Flushing ${count} pending messages for ${agentState.handle.name}`);

    await this.runTurn(agentState, combined);
  }

  /**
   * Cancel the current turn (if supported by binary).
   */
  async cancel(handle: AgentHandle): Promise<void> {
    const agentState = this.getAgentState(handle);
    if (agentState.capabilities.supportsInterruption) {
      console.error(`[external-provider] Cancelling turn for ${handle.name}`);
      this.sendNotification(agentState, "agent/cancel");
    }
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

    console.error(`[external-provider] Kicking ${handle.name} from #${handle.channel}`);

    // Set flag so exit handler knows this is intentional
    agentState.isShuttingDown = true;

    try {
      // Try graceful shutdown first
      await this.gracefulShutdown(agentState);
    } catch (err) {
      console.error(`[external-provider] Graceful shutdown failed:`, err);
    }

    // Force kill if still running
    if (agentState.process.exitCode === null) {
      console.error(`[external-provider] Force killing process`);
      agentState.process.kill("SIGTERM");
      await this.sleep(SIGKILL_GRACE);
      if (agentState.process.exitCode === null) {
        agentState.process.kill("SIGKILL");
      }
    }

    this.setState(agentState, "stopped");
    this.cleanup(agentState);
    this.agents.delete(key);
  }

  /**
   * Attempt graceful shutdown.
   */
  private async gracefulShutdown(agentState: ExternalAgentState): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Shutdown timeout"));
      }, SHUTDOWN_TIMEOUT);

      // Send shutdown request
      this.sendRequest(agentState, "agent/shutdown")
        .then(() => {
          clearTimeout(timeout);
          resolve();
        })
        .catch((err) => {
          clearTimeout(timeout);
          reject(err);
        });
    });
  }

  /**
   * Clean up agent resources.
   */
  private cleanup(agentState: ExternalAgentState): void {
    agentState.readline.close();
    agentState.pendingRequests.clear();
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
   * Note: Uses the same /tmp/powpow base path as other providers.
   * The workdir path construction matches agent-manager.ts.
   */
  async canResume(channel: string, name: string): Promise<boolean> {
    const workdir = path.join(
      "/tmp/powpow",
      `${this.slugify(channel)}--${this.slugify(name)}`
    );
    // Check for any session file (pattern: .{engine}-session)
    try {
      const files = fs.readdirSync(workdir);
      return files.some((f) => f.endsWith("-session"));
    } catch {
      return false;
    }
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

  /**
   * Get capabilities for a specific agent.
   * Note: This returns the capabilities declared by the binary.
   */
  getAgentCapabilities(handle: AgentHandle): ProviderCapabilities {
    const agentState = this.getAgentState(handle);
    return agentState.capabilities;
  }

  // --- Private helpers ---

  private getAgentState(handle: AgentHandle): ExternalAgentState {
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

  private setState(agentState: ExternalAgentState, newState: AgentState): void {
    const previousState = agentState.state;
    if (previousState === newState) return;

    agentState.state = newState;

    for (const callback of agentState.stateCallbacks) {
      try {
        callback(newState, previousState);
      } catch (err) {
        console.error("[external-provider] Error in state callback:", err);
      }
    }
  }

  private emitOutput(agentState: ExternalAgentState, output: AgentOutput): void {
    for (const callback of agentState.outputCallbacks) {
      try {
        callback(output);
      } catch (err) {
        console.error("[external-provider] Error in output callback:", err);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
