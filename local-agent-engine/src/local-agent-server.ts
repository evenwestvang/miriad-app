#!/usr/bin/env node
/**
 * Local Agent Server (Stage 2)
 *
 * Long-running daemon that hosts multiple Claude Agent SDK instances.
 * Each agent has its own WebSocket connection to CAST.
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
import { existsSync, mkdirSync, unlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { query, type Options, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { TymbalBridge } from "./tymbal-bridge.js";
import {
  loadCredentials,
  initFromConnectionString,
  requestAgentToken,
} from "./credentials.js";
import {
  resolveConfig,
  detectEnvironment,
  getApiProtocol,
  type Environment,
  type ResolvedConfig,
} from "./profiles.js";
import type {
  ServerMessage,
  RegisterMessage,
  IncomingMessage,
  IPCCommand,
  IPCResponse,
  IPCAgentInfo,
  AgentInstanceConfig,
  AgentStatus,
  ServerCredentials,
} from "./types.js";

// ============================================================================
// Configuration
// ============================================================================

interface ServerConfig {
  wsHost: string;
  apiHost: string;
  wsProtocol: "ws" | "wss";
  apiProtocol: "http" | "https";
  environment: Environment;
  socketPath: string;
  profile?: string;
}

interface ParsedArgs {
  wsHost?: string;
  apiHost?: string;
  profile?: string;
  socketPath: string;
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2);
  let wsHost: string | undefined = process.env.CAST_WS_HOST;
  let apiHost: string | undefined = process.env.CAST_API_HOST;
  let profile: string | undefined = process.env.CAST_PROFILE;
  let socketPath = process.env.LOCAL_AGENT_SOCK ?? "/tmp/local-agent.sock";

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--ws-host":
        wsHost = args[++i];
        break;
      case "--api-host":
        apiHost = args[++i];
        break;
      case "--profile":
        profile = args[++i];
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
  --ws-host <host>   WebSocket host (overrides auto-detect)
  --api-host <host>  API host (overrides auto-detect)
  --profile <name>   Use named profile (local, staging, or custom)
  --socket <path>    IPC socket path (default: /tmp/local-agent.sock)
  --help             Show this help message

Environment Variables:
  CAST_WS_HOST        WebSocket host (overrides auto-detect)
  CAST_API_HOST       API host (overrides auto-detect)
  CAST_PROFILE        Profile name (local, staging, or custom)
  ANTHROPIC_API_KEY   Required for Claude Agent SDK
  LOCAL_AGENT_SOCK    IPC socket path (default: /tmp/local-agent.sock)

Environment Detection:
  The server auto-detects the environment from the connection string host:
    *.staging.clanker.is  →  staging (wss://, https://)
    Everything else       →  local (ws://, http://)

  Use --profile or --ws-host to override auto-detection.

Profile Config:
  Custom profiles can be saved to ~/.config/cast-local-agent/profiles.json

Use connect-local-agent to add/remove agents from this server.
`);
        process.exit(0);
      default:
        // Handle unknown arguments
        if (arg.startsWith("-")) {
          console.error(`Error: Unknown option: ${arg}`);
        } else {
          console.error(`Error: Unknown command: ${arg}`);
          console.error(`\nHint: Commands like 'list', 'status', 'connect' are top-level CLI commands.`);
          console.error(`Run: cast-local-agent ${arg}`);
          console.error(`Not:  cast-local-agent server ${arg}`);
        }
        console.error(`\nRun 'cast-local-agent --help' for usage.`);
        process.exit(1);
    }
  }

  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  return { wsHost, apiHost, profile, socketPath };
}

// ============================================================================
// Agent Instance (owns its own WebSocket connection)
// ============================================================================

interface AgentInstance {
  config: AgentInstanceConfig;
  token: string | null; // Agent token for auth (Stage 3)
  ws: WebSocket | null;
  bridge: TymbalBridge | null;
  status: AgentStatus;
  registeredAt: Date;
  isProcessing: boolean;
  messageQueue: IncomingMessage[];
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempts: number; // For exponential backoff (Stage 4)
}

// Reconnection constants
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const RECONNECT_MAX_ATTEMPTS = 10;

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
// MCP Configuration (Stage 3)
// ============================================================================

interface McpContext {
  credentials: ServerCredentials;
  channelId: string;
  token: string;
}

/**
 * Build MCP server configuration for the SDK.
 * Adds cast-artifacts MCP with HTTP transport when credentials are available.
 */
function buildMcpServers(ctx: McpContext | null): Record<string, McpServerConfig> {
  const mcpServers: Record<string, McpServerConfig> = {};

  if (ctx) {
    const protocol = getApiProtocol(ctx.credentials.host);
    const apiUrl = `${protocol}://${ctx.credentials.host}`;

    mcpServers["cast-artifacts"] = {
      type: "http",
      url: `${apiUrl}/mcp/${ctx.channelId}`,
      headers: {
        Authorization: `Agent ${ctx.token}`,
      },
    };
    console.log(`[Server] Added cast-artifacts MCP (HTTP transport to ${ctx.credentials.host})`);
  }

  return mcpServers;
}

// ============================================================================
// Claude SDK Integration
// ============================================================================

async function runClaudeQuery(
  prompt: string,
  bridge: TymbalBridge,
  workspace: string,
  systemPrompt?: string,
  mcpContext?: McpContext | null
): Promise<void> {
  const shouldContinue = hasExistingSession(workspace);
  const claudeConfigDir = getClaudeConfigDir(workspace);

  console.log(`[Server] Starting SDK query for ${bridge.getCallsign()}`);
  console.log(`[Server] Working directory: ${workspace}`);
  console.log(`[Server] Continue session: ${shouldContinue}`);

  // Build MCP servers config (Stage 3)
  const mcpServers = buildMcpServers(mcpContext ?? null);
  const hasMcp = Object.keys(mcpServers).length > 0;
  if (hasMcp) {
    console.log(`[Server] MCP servers: ${Object.keys(mcpServers).join(", ")}`);
  }

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
    ...(hasMcp && { mcpServers }),
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
  private ipcServer: NetServer | null = null;
  private agents: Map<string, AgentInstance> = new Map();
  private config: ServerConfig;
  private credentials: ServerCredentials | null = null;
  private startTime: Date;

  constructor(config: ServerConfig) {
    this.config = config;
    this.startTime = new Date();
  }

  /**
   * Load server credentials from disk (Stage 3).
   * Credentials are used for auth, but config is already resolved by resolveConfig().
   */
  async loadCredentials(): Promise<void> {
    this.credentials = await loadCredentials();
    if (this.credentials) {
      console.log(`[Server] Loaded credentials for space: ${this.credentials.spaceId}`);
    } else {
      console.log(`[Server] No credentials found (dev mode - localhost auth disabled)`);
    }
  }

  // --------------------------------------------------------------------------
  // Agent WebSocket Management (per-agent connections)
  // --------------------------------------------------------------------------

  private getWsUrl(): string {
    return `${this.config.wsProtocol}://${this.config.wsHost}/local-agents/connect`;
  }

  private async connectAgent(agent: AgentInstance): Promise<void> {
    const url = this.getWsUrl();
    const { callsign, channelId } = agent.config;

    console.log(`[${callsign}] Connecting to ${url}`);

    // Include server auth header if credentials available (Stage 3)
    const wsOptions: WebSocket.ClientOptions = {};
    if (this.credentials) {
      wsOptions.headers = {
        Authorization: `Server ${this.credentials.secret}`,
      };
    }

    return new Promise((resolve, reject) => {
      agent.ws = new WebSocket(url, wsOptions);

      agent.ws.on("open", () => {
        console.log(`[${callsign}] WebSocket connected`);
        this.cancelAgentReconnect(agent);
        // Registration happens after receiving 'connected' message
      });

      agent.ws.on("message", (data) => {
        this.handleAgentMessage(agent, data.toString());
      });

      agent.ws.on("close", (code, reason) => {
        console.log(`[${callsign}] WebSocket disconnected: ${code} ${reason}`);
        agent.status = "disconnected";
        agent.bridge = null;
        agent.ws = null;
        this.scheduleAgentReconnect(agent);
      });

      agent.ws.on("error", (error) => {
        console.error(`[${callsign}] WebSocket error:`, error);
        if (agent.status === "disconnected") {
          reject(error);
        }
      });

      // Resolve immediately after setting up handlers
      // Registration completes asynchronously
      resolve();
    });
  }

  private scheduleAgentReconnect(agent: AgentInstance): void {
    if (agent.reconnectTimer) return;

    const { callsign } = agent.config;

    // Check max attempts
    if (agent.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      console.error(`[${callsign}] Max reconnect attempts (${RECONNECT_MAX_ATTEMPTS}) reached. Giving up.`);
      return;
    }

    // Exponential backoff with jitter
    const backoffMs = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * Math.pow(2, agent.reconnectAttempts)
    );
    const jitter = Math.random() * 0.3 * backoffMs; // 0-30% jitter
    const delayMs = Math.floor(backoffMs + jitter);

    agent.reconnectAttempts++;
    console.log(`[${callsign}] Scheduling reconnect in ${Math.round(delayMs / 1000)}s (attempt ${agent.reconnectAttempts}/${RECONNECT_MAX_ATTEMPTS})...`);

    agent.reconnectTimer = setTimeout(async () => {
      agent.reconnectTimer = null;
      try {
        await this.connectAgent(agent);
      } catch (error) {
        console.error(`[${callsign}] Reconnect failed:`, error);
        this.scheduleAgentReconnect(agent);
      }
    }, delayMs);
  }

  private cancelAgentReconnect(agent: AgentInstance): void {
    if (agent.reconnectTimer) {
      clearTimeout(agent.reconnectTimer);
      agent.reconnectTimer = null;
    }
    // Reset attempts on successful connection
    agent.reconnectAttempts = 0;
  }

  // --------------------------------------------------------------------------
  // Agent Message Handling
  // --------------------------------------------------------------------------

  private handleAgentMessage(agent: AgentInstance, data: string): void {
    const { callsign, channelId } = agent.config;

    let message: ServerMessage;
    try {
      message = JSON.parse(data);
    } catch {
      console.error(`[${callsign}] Invalid JSON from server:`, data);
      return;
    }

    switch (message.type) {
      case "connected":
        console.log(`[${callsign}] Protocol version: ${message.version}`);
        // Now register the agent
        this.registerAgentWithServer(agent);
        break;

      case "registered":
        agent.status = "idle";
        // Initialize bridge with this agent's WebSocket and token (Stage 3)
        agent.bridge = new TymbalBridge({
          ws: agent.ws!,
          channelId,
          callsign,
          token: agent.token ?? undefined,
        });
        console.log(`[${callsign}] Registered in ${channelId}`);
        break;

      case "message":
        this.handleIncomingMessage(agent, message);
        break;

      case "error":
        console.error(`[${callsign}] Server error: ${message.code} - ${message.message}`);
        break;
    }
  }

  private registerAgentWithServer(agent: AgentInstance): void {
    const { callsign, channelId, workspace } = agent.config;

    if (!agent.ws || agent.ws.readyState !== WebSocket.OPEN) {
      console.error(`[${callsign}] Cannot register - WebSocket not connected`);
      agent.status = "disconnected";
      return;
    }

    const registerMsg: RegisterMessage = {
      type: "register",
      channelId,
      callsign,
      workspace,
      token: agent.token ?? undefined, // Include token if available (Stage 3)
    };

    agent.ws.send(JSON.stringify(registerMsg));
    console.log(`[${callsign}] Sent registration${agent.token ? " (with token)" : ""}`);
  }

  private async handleIncomingMessage(agent: AgentInstance, message: IncomingMessage): Promise<void> {
    const { callsign } = agent.config;

    if (!agent.bridge) {
      console.error(`[${callsign}] No bridge available`);
      return;
    }

    // Queue message if already processing
    if (agent.isProcessing) {
      console.log(`[${callsign}] Busy, queueing message`);
      agent.messageQueue.push(message);
      return;
    }

    await this.processAgentMessage(agent, message);
  }

  private async processAgentMessage(agent: AgentInstance, message: IncomingMessage): Promise<void> {
    const { callsign, channelId, workspace } = agent.config;

    agent.isProcessing = true;
    agent.status = "processing";

    console.log(`[${callsign}] Processing message from ${message.sender}`);

    // Build MCP context if credentials and token available (Stage 3)
    const mcpContext: McpContext | null =
      this.credentials && agent.token
        ? {
            credentials: this.credentials,
            channelId,
            token: agent.token,
          }
        : null;

    try {
      await runClaudeQuery(
        message.content,
        agent.bridge!,
        workspace,
        message.systemPrompt,
        mcpContext
      );
    } catch (error) {
      console.error(`[${callsign}] Error processing message:`, error);
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

  async addAgent(config: AgentInstanceConfig): Promise<{ success: boolean; message: string }> {
    const key = getAgentKey(config.channelId, config.callsign);
    const { callsign, channelId } = config;

    if (this.agents.has(key)) {
      return { success: false, message: `Agent ${callsign} already exists in ${channelId}` };
    }

    // Ensure workspace exists
    ensureWorkspace(config.workspace);

    // Request agent token from CAST if we have credentials (Stage 3)
    let token: string | null = null;
    if (this.credentials) {
      try {
        console.log(`[${callsign}] Requesting agent token...`);
        token = await requestAgentToken(this.credentials, channelId, callsign);
        console.log(`[${callsign}] Token acquired`);
      } catch (error) {
        return { success: false, message: `Failed to get agent token: ${error}` };
      }
    }

    const agent: AgentInstance = {
      config,
      token,
      ws: null,
      bridge: null,
      status: "disconnected",
      registeredAt: new Date(),
      isProcessing: false,
      messageQueue: [],
      reconnectTimer: null,
      reconnectAttempts: 0,
    };

    this.agents.set(key, agent);

    // Connect this agent's WebSocket
    try {
      await this.connectAgent(agent);
      return { success: true, message: `Agent ${callsign} added to ${channelId}` };
    } catch (error) {
      // Remove from registry if connection fails immediately
      this.agents.delete(key);
      return { success: false, message: `Failed to connect agent ${callsign}: ${error}` };
    }
  }

  removeAgent(channelId: string, callsign: string): { success: boolean; message: string } {
    const key = getAgentKey(channelId, callsign);
    const agent = this.agents.get(key);

    if (!agent) {
      return { success: false, message: `Agent ${callsign} not found in ${channelId}` };
    }

    // Cancel any pending reconnect
    this.cancelAgentReconnect(agent);

    // Close the WebSocket - server will detect disconnect and update roster
    if (agent.ws && agent.ws.readyState === WebSocket.OPEN) {
      agent.ws.close();
    }

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
    // "connected" is true if at least one agent is connected, or if no agents yet
    const anyConnected = this.agents.size === 0 ||
      Array.from(this.agents.values()).some(a => a.status !== "disconnected");

    return {
      connected: anyConnected,
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
      // Set socket permissions to owner-only (Stage 4 security)
      try {
        chmodSync(socketPath, 0o600);
        console.log(`[IPC] Server listening on ${socketPath} (mode 0600)`);
      } catch (error) {
        console.warn(`[IPC] Could not set socket permissions:`, error);
        console.log(`[IPC] Server listening on ${socketPath}`);
      }
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

    // Close all agent WebSocket connections
    for (const agent of this.agents.values()) {
      this.cancelAgentReconnect(agent);
      if (agent.ws && agent.ws.readyState === WebSocket.OPEN) {
        agent.ws.close();
      }
    }

    if (this.ipcServer) {
      this.ipcServer.close();
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
// Init Command
// ============================================================================

async function handleInit(connectionString: string): Promise<void> {
  console.log(`[Init] Initializing from connection string...`);

  try {
    const credentials = await initFromConnectionString(connectionString);
    console.log(`\n✓ Successfully initialized!`);
    console.log(`  Server ID: ${credentials.serverId}`);
    console.log(`  Space: ${credentials.spaceId}`);
    console.log(`  Host: ${credentials.wsHost}`);
    console.log(`\nYou can now run: local-agent-server`);
  } catch (error) {
    console.error(`\n✗ Initialization failed: ${error}`);
    process.exit(1);
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Handle init command separately
  if (args[0] === "init") {
    if (!args[1]) {
      console.error("Usage: local-agent-server init <connection-string>");
      console.error('Example: local-agent-server init "cast://bootstrap_abc@api.cast.dev/space_xyz"');
      process.exit(1);
    }
    await handleInit(args[1]);
    return;
  }

  const parsedArgs = parseArgs();

  // Load credentials to get host for auto-detection
  const credentials = await loadCredentials();

  // Resolve configuration from multiple sources (Stage 4)
  const resolved = await resolveConfig({
    wsHost: parsedArgs.wsHost,
    apiHost: parsedArgs.apiHost,
    profile: parsedArgs.profile,
    credentialsHost: credentials?.wsHost,
  });

  const config: ServerConfig = {
    wsHost: resolved.wsHost,
    apiHost: resolved.apiHost,
    wsProtocol: resolved.wsProtocol,
    apiProtocol: resolved.apiProtocol,
    environment: resolved.environment,
    socketPath: parsedArgs.socketPath,
    profile: parsedArgs.profile,
  };

  console.log(`[Server] Starting local agent server`);
  console.log(`[Server]   Environment: ${config.environment}`);
  console.log(`[Server]   WebSocket: ${config.wsProtocol}://${config.wsHost}`);
  console.log(`[Server]   API: ${config.apiProtocol}://${config.apiHost}`);
  console.log(`[Server]   Config source: ${resolved.source}`);
  console.log(`[Server]   IPC Socket: ${config.socketPath}`);

  const server = new LocalAgentServer(config);

  // Load credentials into server (Stage 3)
  await server.loadCredentials();

  // Handle shutdown signals
  const shutdown = async () => {
    console.log(`\n[Server] Received shutdown signal`);
    await server.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    // Start IPC server (no initial WS connection - each agent opens its own)
    server.startIPCServer();

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
