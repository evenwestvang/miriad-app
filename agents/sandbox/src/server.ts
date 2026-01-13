/**
 * Claude Agent SDK Server
 *
 * HTTP server that receives messages from the orchestrator,
 * uses the Claude Agent SDK for conversation, and streams output via Tymbal.
 *
 * Endpoints:
 * - POST /message - Send message to Claude
 * - GET /health - Health check for ECS
 * - POST /shutdown - Graceful shutdown
 *
 * Protocol Version: 3.0
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { IdleMonitor } from "./idle-monitor.js";
import { TymbalBridge } from "./tymbal-bridge.js";
import { Pushable } from "./pushable.js";
import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type Options,
  type McpServerConfig,
} from "@anthropic-ai/claude-agent-sdk";

// Inline types for MCP config (avoid workspace dependency in Docker)
interface ResolvedMcpConfig {
  slug: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

function convertToSdkMcpConfig(resolved: ResolvedMcpConfig): McpServerConfig {
  if (resolved.transport === "stdio") {
    return {
      type: "stdio",
      command: resolved.command!,
      args: resolved.args,
      env: resolved.env,
    };
  } else {
    return {
      type: "http",
      url: resolved.url!,
      headers: resolved.headers,
    };
  }
}

// =============================================================================
// Identity Utilities (v3.0 protocol)
// =============================================================================

interface AgentIdComponents {
  spaceId: string;
  channelId: string;
  callsign: string;
}

/**
 * Parse agentId format (spaceId:channelId:callsign) into components.
 */
function parseAgentId(agentId: string): AgentIdComponents {
  const [spaceId, channelId, callsign] = agentId.split(":");
  if (!spaceId || !channelId || !callsign) {
    throw new Error(`Invalid agentId format: ${agentId}`);
  }
  return { spaceId, channelId, callsign };
}

// =============================================================================
// Configuration from Environment (v3.0 protocol)
// =============================================================================

const PORT = parseInt(process.env.PORT ?? "8080", 10);

// v3.0: Single CAST_AGENT_ID replaces THREAD_ID, CAST_SPACE_ID, CAST_CHANNEL_ID, CAST_CALLSIGN
const CAST_AGENT_ID = process.env.CAST_AGENT_ID ?? "";

// v3.0: Runtime-computed callback URL (replaces dynamic host detection)
const CAST_CALLBACK_URL = process.env.CAST_CALLBACK_URL ?? "";

// v3.0: Routing hints as JSON (for Fly.io instance routing, null for Docker)
const CAST_ROUTE_HINTS: Record<string, string> | null = process.env.CAST_ROUTE_HINTS
  ? JSON.parse(process.env.CAST_ROUTE_HINTS)
  : null;

const CAST_API_URL = process.env.CAST_API_URL ?? "";
const CAST_AUTH_TOKEN = process.env.CAST_AUTH_TOKEN ?? "";
const WORKSPACE_BASE = process.env.WORKSPACE_DIR ?? "/workspace";
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS ?? String(10 * 60 * 1000), 10);

// Derived values from agentId
let AGENT_CHANNEL_ID = "";
let AGENT_CALLSIGN = "";
if (CAST_AGENT_ID) {
  try {
    const { channelId, callsign } = parseAgentId(CAST_AGENT_ID);
    AGENT_CHANNEL_ID = channelId;
    AGENT_CALLSIGN = callsign;
  } catch (err) {
    console.error("[Server] Failed to parse CAST_AGENT_ID:", err);
  }
}

// Model configuration
const DEFAULT_MODEL = process.env.CLAUDE_MODEL ?? "claude-opus-4-5-20251101";

// MCP servers from orchestrator (passed as JSON env var)
let MCP_SERVERS_FROM_ENV: ResolvedMcpConfig[] = [];
if (process.env.MCP_SERVERS) {
  try {
    MCP_SERVERS_FROM_ENV = JSON.parse(process.env.MCP_SERVERS);
    console.log(`[Server] Loaded ${MCP_SERVERS_FROM_ENV.length} MCP server(s) from MCP_SERVERS env`);
  } catch (err) {
    console.error("[Server] Failed to parse MCP_SERVERS env var:", err);
  }
}

// Get dirname for relative paths
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Per-agent directory structure
function getAgentWorkspace(agentId: string): {
  root: string;
  project: string;
  claudeConfig: string;
  mcpConfig: string;
} {
  const root = join(WORKSPACE_BASE, "agents", agentId);
  return {
    root,
    project: join(root, "project"),
    claudeConfig: join(root, ".claude"),
    mcpConfig: join(root, "mcp-config.json"),
  };
}

/**
 * Ensure agent workspace directories exist.
 */
function ensureAgentWorkspace(agentId: string): ReturnType<typeof getAgentWorkspace> {
  const workspace = getAgentWorkspace(agentId);

  // Create directories if they don't exist
  if (!existsSync(workspace.project)) {
    console.log(`[Server] Creating workspace directories for agent ${agentId}`);
    mkdirSync(workspace.project, { recursive: true });
  }

  return workspace;
}

/**
 * Check if a previous Claude session exists for this agent.
 */
function hasExistingSession(agentId: string): boolean {
  const workspace = getAgentWorkspace(agentId);
  return existsSync(workspace.claudeConfig);
}

/**
 * Build MCP server configurations for SDK.
 */
function buildMcpServers(resolvedMcps?: ResolvedMcpConfig[]): Record<string, McpServerConfig> {
  const mcpServers: Record<string, McpServerConfig> = {};

  // Add built-in cast MCP via HTTP transport
  if (CAST_API_URL && AGENT_CHANNEL_ID && CAST_AUTH_TOKEN) {
    mcpServers["cast"] = {
      type: "http",
      url: `${CAST_API_URL}/mcp/${AGENT_CHANNEL_ID}`,
      headers: {
        Authorization: `Container ${CAST_AUTH_TOKEN}`,
      },
    };
    console.log("[Server] Added cast MCP (HTTP transport)");
  }

  // Use MCPs from env var if no resolvedMcps provided in request
  const mcpsToAdd = resolvedMcps && resolvedMcps.length > 0
    ? resolvedMcps
    : MCP_SERVERS_FROM_ENV;

  // Add resolved MCPs from orchestrator (either from request or env var)
  if (mcpsToAdd && mcpsToAdd.length > 0) {
    for (const resolved of mcpsToAdd) {
      mcpServers[resolved.slug] = convertToSdkMcpConfig(resolved);
      console.log(`[Server] Added resolved MCP: ${resolved.slug} (${resolved.transport})`);
    }
  }

  return mcpServers;
}

// State
let isProcessing = false;
let isShuttingDown = false;
let continueSession = false;
let currentQuery: Query | null = null;
let currentAbortController: AbortController | null = null;
let currentInput: Pushable<SDKUserMessage> | null = null;

// Message queue for handling messages while busy
interface QueuedMessage {
  content: string;
  agentId: string;
  resolvedMcps?: ResolvedMcpConfig[];
  systemPrompt?: string;
}
const messageQueue: QueuedMessage[] = [];

// Initialize idle monitor
const idleMonitor = new IdleMonitor({
  timeoutMs: IDLE_TIMEOUT_MS,
  onShutdown: async () => {
    console.log("[Server] Idle timeout - shutting down");
    await gracefulShutdown();
  },
});

/**
 * Run Claude Agent SDK query and stream output.
 */
async function runClaudeQuery(
  prompt: string,
  tymbalBridge: TymbalBridge,
  shouldContinue: boolean,
  agentId: string,
  resolvedMcps?: ResolvedMcpConfig[],
  systemPrompt?: string
): Promise<void> {
  // Ensure workspace directories exist
  const workspace = ensureAgentWorkspace(agentId);

  // Build MCP servers
  const mcpServers = buildMcpServers(resolvedMcps);

  // Create abort controller for cancellation
  const abortController = new AbortController();
  currentAbortController = abortController;

  // Create Pushable for mid-turn message injection (Phase 2: ready for future use)
  const input = new Pushable<SDKUserMessage>();
  currentInput = input;

  // Build SDK options
  const options: Options = {
    // Model selection
    model: DEFAULT_MODEL,

    // System prompt with Claude Code preset + channel context
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

    // MCP servers
    mcpServers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,

    // Permissions (container is sandboxed)
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,

    // Streaming - enable partial messages for Phase 3 readiness
    includePartialMessages: true,

    // Session management
    continue: shouldContinue,

    // Working directory
    cwd: workspace.project,

    // Environment - set Claude config directory for session persistence
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: workspace.claudeConfig,
    },

    // Abort controller for cancellation
    abortController,
  };

  console.log(`[Server] Starting SDK query for agent ${agentId}`);
  console.log(`[Server] Model: ${DEFAULT_MODEL}`);
  console.log(`[Server] Working directory: ${workspace.project}`);
  console.log(`[Server] Continue session: ${shouldContinue}`);
  console.log(`[Server] MCP servers: ${Object.keys(mcpServers).join(", ") || "(none)"}`);

  try {
    // Start the query with the initial prompt
    const q = query({ prompt, options });
    currentQuery = q;

    // Process SDK messages and emit Tymbal frames
    for await (const message of q) {
      idleMonitor.touch();
      await tymbalBridge.processSDKMessage(message);
    }

    // Finalize any pending messages
    await tymbalBridge.finalize();

    console.log(`[Server] Query completed for agent ${agentId}`);
  } catch (error) {
    console.error(`[Server] SDK query error:`, error);

    // Emit error frame
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    // The bridge will handle error emission in handleResult
    throw error;
  } finally {
    currentQuery = null;
    currentAbortController = null;
    currentInput = null;
  }
}

/**
 * Parse JSON body from request.
 */
async function parseBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * Send JSON response.
 */
function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

/**
 * Process a single message through Claude SDK.
 */
async function processMessage(message: QueuedMessage): Promise<void> {
  const { content, agentId, resolvedMcps, systemPrompt } = message;

  // Extract channelId from agentId
  let channelId: string;
  try {
    const parsed = parseAgentId(agentId);
    channelId = parsed.channelId;
  } catch {
    channelId = agentId; // Fallback for backwards compatibility
  }

  // Create Tymbal bridge for this conversation
  const tymbalBridge = new TymbalBridge({
    serverUrl: CAST_API_URL,
    channelId,
    callsign: AGENT_CALLSIGN || undefined,
    authToken: CAST_AUTH_TOKEN || undefined,
  });

  // Check if we should use --continue
  const shouldContinue = continueSession || hasExistingSession(agentId);

  console.log(`[Server] Processing message for agent ${agentId}`);
  console.log(`[Server] Continue session: ${shouldContinue}`);

  try {
    await runClaudeQuery(content, tymbalBridge, shouldContinue, agentId, resolvedMcps, systemPrompt);

    // Mark that we should continue for subsequent messages
    continueSession = true;

    console.log(`[Server] Completed processing for agent ${agentId}`);
  } catch (error) {
    console.error(`[Server] Error processing message:`, error);
    // Error handling is done in the bridge
  }
}

/**
 * Process the message queue.
 */
async function processQueue(): Promise<void> {
  while (messageQueue.length > 0 && !isShuttingDown) {
    const nextMessage = messageQueue.shift();
    if (nextMessage) {
      console.log(`[Server] Processing queued message (${messageQueue.length} remaining)`);
      await processMessage(nextMessage);
    }
  }
  isProcessing = false;
  idleMonitor.touch();
}

/**
 * Handle POST /message - Send message to Claude.
 */
async function handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isShuttingDown) {
    sendJson(res, 503, { error: "Server is shutting down" });
    return;
  }

  // Validate auth token if configured
  if (CAST_AUTH_TOKEN) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      sendJson(res, 401, { error: "Missing or invalid Authorization header" });
      return;
    }
    const token = authHeader.slice(7);
    if (token !== CAST_AUTH_TOKEN) {
      sendJson(res, 401, { error: "Invalid auth token" });
      return;
    }
  }

  // Parse request body
  interface MessageRequest {
    content: string;
    agentId?: string;
    resolvedMcps?: ResolvedMcpConfig[];
    systemPrompt?: string;
  }

  let body: MessageRequest;
  try {
    body = await parseBody<MessageRequest>(req);
  } catch {
    sendJson(res, 400, { error: "Invalid request body" });
    return;
  }

  if (!body.content) {
    sendJson(res, 400, { error: "Missing content field" });
    return;
  }

  const agentId = body.agentId ?? CAST_AGENT_ID;
  if (!agentId) {
    sendJson(res, 400, { error: "Missing agentId" });
    return;
  }

  // Reset idle timer
  idleMonitor.touch();

  const queuedMessage: QueuedMessage = {
    content: body.content,
    agentId,
    resolvedMcps: body.resolvedMcps,
    systemPrompt: body.systemPrompt,
  };

  // If already processing, queue the message
  if (isProcessing) {
    messageQueue.push(queuedMessage);
    console.log(`[Server] Queued message for agent ${agentId} (queue size: ${messageQueue.length})`);
    sendJson(res, 202, { status: "queued", agentId, queuePosition: messageQueue.length });
    return;
  }

  // Start processing immediately
  isProcessing = true;
  sendJson(res, 202, { status: "processing", agentId });

  // Process this message then drain the queue
  await processMessage(queuedMessage);
  await processQueue();
}

/**
 * Handle GET /health - Health check.
 */
function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const workspace = CAST_AGENT_ID ? getAgentWorkspace(CAST_AGENT_ID) : null;
  const hasSession = CAST_AGENT_ID ? hasExistingSession(CAST_AGENT_ID) : false;

  const status = {
    status: isShuttingDown ? "shutting_down" : isProcessing ? "processing" : "healthy",
    agentId: CAST_AGENT_ID,
    idleMs: idleMonitor.getIdleMs(),
    continueSession,
    hasEfsSession: hasSession,
    workspace: workspace?.project ?? null,
    uptime: process.uptime(),
    queueLength: messageQueue.length,
    model: DEFAULT_MODEL,
    protocolVersion: "3.0",
  };

  const statusCode = isShuttingDown ? 503 : 200;
  sendJson(res, statusCode, status);
}

/**
 * Handle POST /shutdown - Graceful shutdown.
 */
async function handleShutdown(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { status: "shutting_down" });
  await gracefulShutdown();
}

/**
 * Register this container with the Cast API (v3.0 protocol).
 */
async function checkin(): Promise<void> {
  if (!CAST_API_URL || !CAST_AGENT_ID) {
    console.log("[Server] Checkin skipped - missing CAST_API_URL or CAST_AGENT_ID");
    return;
  }

  // v3.0: Use CAST_CALLBACK_URL from environment (runtime-computed)
  const endpoint = CAST_CALLBACK_URL;
  if (!endpoint) {
    console.log("[Server] Checkin skipped - missing CAST_CALLBACK_URL");
    return;
  }

  console.log(`[Server] Checking in with Cast API at ${CAST_API_URL}`);
  console.log(`[Server]   Agent ID: ${CAST_AGENT_ID}`);
  console.log(`[Server]   Endpoint: ${endpoint}`);
  console.log(`[Server]   Route hints: ${CAST_ROUTE_HINTS ? JSON.stringify(CAST_ROUTE_HINTS) : "(none)"}`);

  try {
    // v3.0 checkin format
    const response = await fetch(`${CAST_API_URL}/agents/checkin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CAST_AUTH_TOKEN ? { Authorization: `Bearer ${CAST_AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        protocolVersion: "3.0",
        agentId: CAST_AGENT_ID,
        endpoint,
        routeHints: CAST_ROUTE_HINTS,
        capabilities: ["route-hints"],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[Server] Checkin failed: ${response.status} ${errorText}`);
      return;
    }

    console.log("[Server] Checkin successful (protocol v3.0), waiting for messages...");

    // Start heartbeat after successful checkin
    startHeartbeat();
  } catch (error) {
    console.error("[Server] Checkin error:", error);
  }
}

// Heartbeat interval handle (for cleanup on shutdown)
let heartbeatInterval: NodeJS.Timeout | null = null;

// Heartbeat interval in milliseconds (30 seconds)
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Send a single heartbeat to the server (v3.0 protocol).
 * Note: v3.0 heartbeat does NOT include endpoint - only agentId.
 */
async function sendHeartbeat(): Promise<void> {
  try {
    // v3.0 heartbeat format - NO endpoint field
    const response = await fetch(`${CAST_API_URL}/agents/heartbeat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(CAST_AUTH_TOKEN ? { Authorization: `Bearer ${CAST_AUTH_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        agentId: CAST_AGENT_ID,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.warn(`[Server] Heartbeat failed: ${response.status} ${errorText}`);
    }
  } catch (error) {
    console.warn("[Server] Heartbeat error:", error);
  }
}

/**
 * Start periodic heartbeat to keep the server informed we're alive.
 * Sends POST /agents/heartbeat immediately, then every 30s.
 */
async function startHeartbeat(): Promise<void> {
  if (!CAST_API_URL || !CAST_AGENT_ID) {
    console.log("[Server] Heartbeat skipped - missing CAST_API_URL or CAST_AGENT_ID");
    return;
  }

  // Clear any existing heartbeat interval
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
  }

  console.log(`[Server] Starting heartbeat (every ${HEARTBEAT_INTERVAL_MS / 1000}s)`);

  // Send first heartbeat immediately so agent shows online right away
  await sendHeartbeat();

  // Then start the periodic interval
  heartbeatInterval = setInterval(async () => {
    if (isShuttingDown) {
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      return;
    }
    await sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
}

/**
 * Gracefully shut down the server.
 */
async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("[Server] Initiating graceful shutdown...");

  // Stop heartbeat
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    console.log("[Server] Stopped heartbeat");
  }

  // Stop idle monitor
  idleMonitor.stop();

  // Interrupt current query if running
  if (currentAbortController) {
    console.log("[Server] Interrupting current query...");
    currentAbortController.abort();
  }

  // End any pending input stream
  if (currentInput) {
    currentInput.end();
  }

  // Wait for current processing to complete (up to 30 seconds)
  const maxWait = 30_000;
  const startWait = Date.now();

  while (isProcessing && Date.now() - startWait < maxWait) {
    console.log("[Server] Waiting for current message to complete...");
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (isProcessing) {
    console.log("[Server] Timed out waiting for message, forcing shutdown");
  }

  // Close server
  server.close(() => {
    console.log("[Server] Server closed");
    process.exit(0);
  });

  // Force exit after 5 more seconds
  setTimeout(() => {
    console.log("[Server] Force exit");
    process.exit(1);
  }, 5000);
}

/**
 * Request handler.
 */
async function requestHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { method, url } = req;

  console.log(`[Server] ${method} ${url}`);

  try {
    if (method === "POST" && url === "/message") {
      await handleMessage(req, res);
    } else if (method === "GET" && url === "/health") {
      handleHealth(req, res);
    } else if (method === "POST" && url === "/shutdown") {
      await handleShutdown(req, res);
    } else {
      sendJson(res, 404, { error: "Not found" });
    }
  } catch (error) {
    console.error(`[Server] Request error:`, error);
    sendJson(res, 500, { error: "Internal server error" });
  }
}

// Create server
const server = createServer(requestHandler);

// Handle signals
process.on("SIGTERM", () => {
  console.log("[Server] Received SIGTERM");
  gracefulShutdown();
});

process.on("SIGINT", () => {
  console.log("[Server] Received SIGINT");
  gracefulShutdown();
});

// Validate configuration
if (!CAST_API_URL) {
  console.warn("[Server] Warning: CAST_API_URL not set, Tymbal streaming disabled");
}

// Start server
server.listen(PORT, () => {
  console.log(`[Server] Claude Agent SDK server listening on port ${PORT}`);
  console.log(`[Server] Protocol Version: 3.0`);
  console.log(`[Server] Model: ${DEFAULT_MODEL}`);
  console.log(`[Server] Agent ID: ${CAST_AGENT_ID || "(not set)"}`);
  console.log(`[Server] Callback URL: ${CAST_CALLBACK_URL || "(not set)"}`);
  console.log(`[Server] Route hints: ${CAST_ROUTE_HINTS ? JSON.stringify(CAST_ROUTE_HINTS) : "(none)"}`);
  console.log(`[Server] Workspace base: ${WORKSPACE_BASE}`);
  console.log(`[Server] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);

  // MCP artifact tools status
  const mcpEnabled = CAST_API_URL && AGENT_CHANNEL_ID && CAST_AUTH_TOKEN;
  console.log(`[Server] MCP artifact tools: ${mcpEnabled ? "enabled (HTTP)" : "disabled"}`);
  if (mcpEnabled) {
    console.log(`[Server]   URL: ${CAST_API_URL}/mcp/${AGENT_CHANNEL_ID}`);
  }

  // Check for existing session
  if (CAST_AGENT_ID) {
    const workspace = getAgentWorkspace(CAST_AGENT_ID);
    const hasSession = hasExistingSession(CAST_AGENT_ID);
    console.log(`[Server] Agent workspace: ${workspace.project}`);
    console.log(`[Server] Existing session: ${hasSession}`);
    if (hasSession) {
      console.log(`[Server] Will use continue: true for session resume`);
    }
  }

  // Start idle monitor
  idleMonitor.start();

  // Register with Cast API
  checkin().catch((err) => {
    console.error("[Server] Checkin failed:", err);
  });
});
