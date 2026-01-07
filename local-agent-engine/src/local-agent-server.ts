#!/usr/bin/env node
/**
 * Local Agent Server (Stage 2)
 *
 * Long-running daemon that hosts multiple Claude Agent SDK instances.
 * Single WebSocket connection to CAST, routes messages to appropriate agents.
 * Accepts IPC commands from connect-local-agent CLI.
 *
 * Usage:
 *   pnpm local-agent-server -- --ws-host localhost:3234
 *
 * Environment Variables:
 *   CAST_WS_HOST - WebSocket host (default: localhost:3234)
 *   CAST_WS_SECURE - Use wss:// (default: false for localhost)
 *   ANTHROPIC_API_KEY - Required for Claude Agent SDK
 *   LOCAL_AGENT_SOCK - IPC socket path (default: /tmp/local-agent.sock)
 */

import WebSocket from "ws";
import { createServer, type Server as NetServer, type Socket } from "node:net";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { TymbalBridge } from "./tymbal-bridge.js";
import type {
  ServerMessage,
  RegisterMessage,
  IncomingMessage,
  IPCCommand,
  IPCResponse,
  IPCAgentInfo,
  AgentInstanceConfig,
  AgentStatus,
} from "./types.js";

// ============================================================================
// Configuration
// ============================================================================

interface ServerConfig {
  wsHost: string;
  secure: boolean;
  socketPath: string;
}

function parseArgs(): ServerConfig {
  const args = process.argv.slice(2);
  let wsHost = process.env.CAST_WS_HOST ?? "localhost:3234";
  let secure = process.env.CAST_WS_SECURE === "true";
  let socketPath = process.env.LOCAL_AGENT_SOCK ?? "/tmp/local-agent.sock";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--ws-host":
        wsHost = args[++i];
        break;
      case "--secure":
        secure = true;
        break;
      case "--socket":
        socketPath = args[++i];
        break;
      case "--help":
        console.log(`
Local Agent Server - Multi-agent daemon for CAST

Usage:
  local-agent-server [options]

Options:
  --ws-host <host>   WebSocket host (default: localhost:3234)
  --secure           Use wss:// instead of ws://
  --socket <path>    IPC socket path (default: /tmp/local-agent.sock)
  --help             Show this help message

Environment Variables:
  CAST_WS_HOST        WebSocket host (default: localhost:3234)
  CAST_WS_SECURE      Use wss:// (default: false)
  ANTHROPIC_API_KEY   Required for Claude Agent SDK
  LOCAL_AGENT_SOCK    IPC socket path (default: /tmp/local-agent.sock)

Use connect-local-agent to add/remove agents from this server.
`);
        process.exit(0);
    }
  }

  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  return { wsHost, secure, socketPath };
}

// ============================================================================
// Agent Instance
// ============================================================================

interface AgentInstance {
  config: AgentInstanceConfig;
  bridge: TymbalBridge | null;
  status: AgentStatus;
  registeredAt: Date;
  isProcessing: boolean;
  messageQueue: IncomingMessage[];
}

function getAgentKey(channelId: string, callsign: string): string {
  return `${channelId}:${callsign}`;
}

// ============================================================================
// Workspace Management
// ============================================================================

function ensureWorkspace(workspace: string): void {
  if (!existsSync(workspace)) {
    console.log(`[Server] Creating workspace: ${workspace}`);
    mkdirSync(workspace, { recursive: true });
  }
}

function getClaudeConfigDir(workspace: string): string {
  return join(workspace, ".claude");
}

function hasExistingSession(workspace: string): boolean {
  return existsSync(getClaudeConfigDir(workspace));
}

// ============================================================================
// Claude SDK Integration
// ============================================================================

async function runClaudeQuery(
  prompt: string,
  bridge: TymbalBridge,
  workspace: string,
  systemPrompt?: string
): Promise<void> {
  const shouldContinue = hasExistingSession(workspace);
  const claudeConfigDir = getClaudeConfigDir(workspace);

  console.log(`[Server] Starting SDK query for ${bridge.getCallsign()}`);
  console.log(`[Server] Working directory: ${workspace}`);
  console.log(`[Server] Continue session: ${shouldContinue}`);

  const options: Options = {
    systemPrompt: systemPrompt
      ? {
          type: "preset",
          preset: "claude_code",
          append: systemPrompt,
        }
      : {
          type: "preset",
          preset: "claude_code",
        },
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    continue: shouldContinue,
    cwd: workspace,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: claudeConfigDir,
    },
  };

  try {
    const q = query({ prompt, options });

    for await (const message of q) {
      await bridge.processSDKMessage(message);
    }

    await bridge.finalize();
    console.log(`[Server] Query completed for ${bridge.getCallsign()}`);
  } catch (error) {
    console.error(`[Server] SDK query error for ${bridge.getCallsign()}:`, error);
    throw error;
  }
}

// ============================================================================
// Local Agent Server
// ============================================================================

class LocalAgentServer {
  private ws: WebSocket | null = null;
  private ipcServer: NetServer | null = null;
  private agents: Map<string, AgentInstance> = new Map();
  private config: ServerConfig;
  private startTime: Date;
  private isConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(config: ServerConfig) {
    this.config = config;
    this.startTime = new Date();
  }

  // --------------------------------------------------------------------------
  // WebSocket Management
  // --------------------------------------------------------------------------

  async connectWebSocket(): Promise<void> {
    const protocol = this.config.secure ? "wss" : "ws";
    const url = `${protocol}://${this.config.wsHost}/local-agents/connect`;

    console.log(`[Server] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        console.log(`[Server] WebSocket connected`);
        this.isConnected = true;
        this.cancelReconnect();
        resolve();
      });

      this.ws.on("message", (data) => {
        this.handleServerMessage(data.toString());
      });

      this.ws.on("close", (code, reason) => {
        console.log(`[Server] WebSocket disconnected: ${code} ${reason}`);
        this.isConnected = false;
        this.markAllAgentsDisconnected();
        this.scheduleReconnect();
      });

      this.ws.on("error", (error) => {
        console.error(`[Server] WebSocket error:`, error);
        if (!this.isConnected) {
          reject(error);
        }
      });
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    console.log(`[Server] Scheduling reconnect in 5s...`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connectWebSocket();
        // Re-register all agents
        await this.reregisterAllAgents();
      } catch (error) {
        console.error(`[Server] Reconnect failed:`, error);
        this.scheduleReconnect();
      }
    }, 5000);
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private markAllAgentsDisconnected(): void {
    for (const agent of this.agents.values()) {
      agent.status = "disconnected";
      agent.bridge = null;
    }
  }

  private async reregisterAllAgents(): Promise<void> {
    console.log(`[Server] Re-registering ${this.agents.size} agents...`);
    for (const agent of this.agents.values()) {
      await this.registerAgentWithServer(agent);
    }
  }

  // --------------------------------------------------------------------------
  // Server Message Handling
  // --------------------------------------------------------------------------

  private handleServerMessage(data: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(data);
    } catch {
      console.error(`[Server] Invalid JSON from server:`, data);
      return;
    }

    switch (message.type) {
      case "connected":
        console.log(`[Server] Protocol version: ${message.version}`);
        break;

      case "registered":
        this.handleRegistered(message.channelId, message.callsign);
        break;

      case "message":
        this.handleIncomingMessage(message);
        break;

      case "error":
        console.error(`[Server] Server error: ${message.code} - ${message.message}`);
        break;
    }
  }

  private handleRegistered(channelId: string, callsign: string): void {
    const key = getAgentKey(channelId, callsign);
    const agent = this.agents.get(key);

    if (agent) {
      agent.status = "idle";
      // Initialize bridge
      agent.bridge = new TymbalBridge({
        ws: this.ws!,
        channelId,
        callsign,
      });
      console.log(`[Server] Agent registered: ${callsign} in ${channelId}`);
    }
  }

  private async handleIncomingMessage(message: IncomingMessage): Promise<void> {
    const key = getAgentKey(message.channelId, message.callsign);
    const agent = this.agents.get(key);

    if (!agent) {
      console.error(`[Server] No agent found for ${key}`);
      return;
    }

    if (!agent.bridge) {
      console.error(`[Server] Agent ${key} has no bridge`);
      return;
    }

    // Queue message if already processing
    if (agent.isProcessing) {
      console.log(`[Server] Agent ${key} busy, queueing message`);
      agent.messageQueue.push(message);
      return;
    }

    await this.processAgentMessage(agent, message);
  }

  private async processAgentMessage(agent: AgentInstance, message: IncomingMessage): Promise<void> {
    agent.isProcessing = true;
    agent.status = "processing";

    console.log(`[Server] Processing message for ${agent.config.callsign}`);

    try {
      await runClaudeQuery(
        message.content,
        agent.bridge!,
        agent.config.workspace,
        message.systemPrompt
      );
    } catch (error) {
      console.error(`[Server] Error processing message:`, error);
    } finally {
      agent.isProcessing = false;
      agent.status = "idle";

      // Process queued messages
      if (agent.messageQueue.length > 0) {
        const nextMessage = agent.messageQueue.shift()!;
        await this.processAgentMessage(agent, nextMessage);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Agent Management
  // --------------------------------------------------------------------------

  private async registerAgentWithServer(agent: AgentInstance): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error(`[Server] Cannot register agent - WebSocket not connected`);
      agent.status = "disconnected";
      return;
    }

    const registerMsg: RegisterMessage = {
      type: "register",
      channelId: agent.config.channelId,
      callsign: agent.config.callsign,
      workspace: agent.config.workspace,
    };

    this.ws.send(JSON.stringify(registerMsg));
    console.log(`[Server] Sent registration for ${agent.config.callsign}`);
  }

  async addAgent(config: AgentInstanceConfig): Promise<{ success: boolean; message: string }> {
    const key = getAgentKey(config.channelId, config.callsign);

    if (this.agents.has(key)) {
      return { success: false, message: `Agent ${config.callsign} already exists in ${config.channelId}` };
    }

    // Ensure workspace exists
    ensureWorkspace(config.workspace);

    const agent: AgentInstance = {
      config,
      bridge: null,
      status: "disconnected",
      registeredAt: new Date(),
      isProcessing: false,
      messageQueue: [],
    };

    this.agents.set(key, agent);

    // Register with CAST server
    await this.registerAgentWithServer(agent);

    return { success: true, message: `Agent ${config.callsign} added to ${config.channelId}` };
  }

  removeAgent(channelId: string, callsign: string): { success: boolean; message: string } {
    const key = getAgentKey(channelId, callsign);
    const agent = this.agents.get(key);

    if (!agent) {
      return { success: false, message: `Agent ${callsign} not found in ${channelId}` };
    }

    // Note: Server will detect disconnect and update roster
    this.agents.delete(key);

    return { success: true, message: `Agent ${callsign} removed from ${channelId}` };
  }

  listAgents(): IPCAgentInfo[] {
    const result: IPCAgentInfo[] = [];

    for (const agent of this.agents.values()) {
      result.push({
        channelId: agent.config.channelId,
        callsign: agent.config.callsign,
        workspace: agent.config.workspace,
        status: agent.status,
        registeredAt: agent.registeredAt.toISOString(),
      });
    }

    return result;
  }

  getStatus(): { connected: boolean; wsHost: string; agentCount: number; uptime: number } {
    return {
      connected: this.isConnected,
      wsHost: this.config.wsHost,
      agentCount: this.agents.size,
      uptime: Date.now() - this.startTime.getTime(),
    };
  }

  // --------------------------------------------------------------------------
  // IPC Server
  // --------------------------------------------------------------------------

  startIPCServer(): void {
    const socketPath = this.config.socketPath;

    // Remove existing socket file
    if (existsSync(socketPath)) {
      try {
        unlinkSync(socketPath);
      } catch {
        // Ignore
      }
    }

    this.ipcServer = createServer((socket: Socket) => {
      console.log(`[IPC] Client connected`);

      let buffer = "";

      socket.on("data", async (data) => {
        buffer += data.toString();

        // Process complete messages (newline-delimited JSON)
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (line.trim()) {
            await this.handleIPCCommand(socket, line);
          }
        }
      });

      socket.on("close", () => {
        console.log(`[IPC] Client disconnected`);
      });

      socket.on("error", (error) => {
        console.error(`[IPC] Socket error:`, error);
      });
    });

    this.ipcServer.listen(socketPath, () => {
      console.log(`[IPC] Server listening on ${socketPath}`);
    });

    this.ipcServer.on("error", (error) => {
      console.error(`[IPC] Server error:`, error);
    });
  }

  private async handleIPCCommand(socket: Socket, data: string): Promise<void> {
    let command: IPCCommand;
    try {
      command = JSON.parse(data);
    } catch {
      this.sendIPCResponse(socket, { type: "error", message: "Invalid JSON" });
      return;
    }

    console.log(`[IPC] Command: ${command.type}`);

    let response: IPCResponse;

    switch (command.type) {
      case "add": {
        const result = await this.addAgent({
          channelId: command.channelId,
          callsign: command.callsign,
          workspace: command.workspace,
        });
        response = result.success
          ? { type: "ok", message: result.message }
          : { type: "error", message: result.message };
        break;
      }

      case "remove": {
        const result = this.removeAgent(command.channelId, command.callsign);
        response = result.success
          ? { type: "ok", message: result.message }
          : { type: "error", message: result.message };
        break;
      }

      case "list": {
        response = { type: "agents", agents: this.listAgents() };
        break;
      }

      case "status": {
        const status = this.getStatus();
        response = { type: "status", ...status };
        break;
      }

      default:
        response = { type: "error", message: `Unknown command: ${(command as { type: string }).type}` };
    }

    this.sendIPCResponse(socket, response);
  }

  private sendIPCResponse(socket: Socket, response: IPCResponse): void {
    socket.write(JSON.stringify(response) + "\n");
  }

  // --------------------------------------------------------------------------
  // Lifecycle
  // --------------------------------------------------------------------------

  async shutdown(): Promise<void> {
    console.log(`[Server] Shutting down...`);

    this.cancelReconnect();

    if (this.ipcServer) {
      this.ipcServer.close();
    }

    if (this.ws) {
      this.ws.close();
    }

    // Clean up socket file
    if (existsSync(this.config.socketPath)) {
      try {
        unlinkSync(this.config.socketPath);
      } catch {
        // Ignore
      }
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();

  console.log(`[Server] Starting local agent server`);
  console.log(`[Server]   WebSocket: ${config.secure ? "wss" : "ws"}://${config.wsHost}`);
  console.log(`[Server]   IPC Socket: ${config.socketPath}`);

  const server = new LocalAgentServer(config);

  // Handle shutdown signals
  const shutdown = async () => {
    console.log(`\n[Server] Received shutdown signal`);
    await server.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    // Start IPC server first
    server.startIPCServer();

    // Connect to CAST
    await server.connectWebSocket();

    console.log(`[Server] Ready. Use connect-local-agent to add agents.`);
  } catch (error) {
    console.error(`[Server] Failed to start:`, error);
    await server.shutdown();
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[Server] Fatal error:`, error);
  process.exit(1);
});
