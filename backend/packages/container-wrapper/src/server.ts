/**
 * Claude Code Wrapper Server
 *
 * HTTP server that receives messages from the orchestrator,
 * spawns Claude Code CLI, and streams output via Tymbal.
 *
 * Endpoints:
 * - POST /message - Send message to Claude Code
 * - GET /health - Health check
 * - POST /shutdown - Graceful shutdown
 */

import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { IdleMonitor } from "./idle-monitor.js";
import { TymbalBridge, type ClaudeCodeEvent } from "./tymbal-bridge.js";

// =============================================================================
// Configuration
// =============================================================================

const PORT = parseInt(process.env.PORT ?? "8080", 10);
const THREAD_ID = process.env.THREAD_ID ?? "";
const CAST_API_URL = process.env.CAST_API_URL ?? "";
const CAST_CHANNEL_ID = process.env.CAST_CHANNEL_ID ?? "";
const CAST_CALLSIGN = process.env.CAST_CALLSIGN ?? "";
const CAST_AUTH_TOKEN = process.env.CAST_AUTH_TOKEN ?? "";
const WORKSPACE_BASE = process.env.WORKSPACE_DIR ?? "/workspace";
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS ?? String(10 * 60 * 1000), 10);

// Get path to MCP server (relative to this file's compiled location)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_SERVER_PATH = join(__dirname, "mcp-server.js");

// =============================================================================
// Workspace Management
// =============================================================================

interface ThreadWorkspace {
  root: string;
  project: string;
  claudeConfig: string;
  mcpConfig: string;
}

function getThreadWorkspace(threadId: string): ThreadWorkspace {
  const root = join(WORKSPACE_BASE, "threads", threadId);
  return {
    root,
    project: join(root, "project"),
    claudeConfig: join(root, ".claude"),
    mcpConfig: join(root, "mcp-config.json"),
  };
}

function ensureThreadWorkspace(threadId: string): ThreadWorkspace {
  const workspace = getThreadWorkspace(threadId);

  if (!existsSync(workspace.project)) {
    console.log(`[Server] Creating workspace directories for thread ${threadId}`);
    mkdirSync(workspace.project, { recursive: true });
  }

  return workspace;
}

function hasExistingSession(threadId: string): boolean {
  const workspace = getThreadWorkspace(threadId);
  return existsSync(workspace.claudeConfig);
}

// =============================================================================
// MCP Configuration
// =============================================================================

interface McpServerConfig {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

function generateMcpConfig(workspace: ThreadWorkspace): string | null {
  const mcpServers: Record<string, McpServerConfig> = {};

  // Add built-in cast-tools MCP if configured
  if (CAST_CHANNEL_ID && CAST_CALLSIGN && existsSync(MCP_SERVER_PATH)) {
    mcpServers["cast-tools"] = {
      type: "stdio",
      command: "node",
      args: [MCP_SERVER_PATH],
      env: {
        CAST_API_URL: CAST_API_URL,
        CAST_CHANNEL_ID: CAST_CHANNEL_ID,
        CAST_CALLSIGN: CAST_CALLSIGN,
        CAST_AUTH_TOKEN: CAST_AUTH_TOKEN,
      },
    };
    console.log("[Server] Added cast-tools MCP");
  } else {
    console.log("[Server] cast-tools MCP disabled - missing config or server");
  }

  if (Object.keys(mcpServers).length === 0) {
    console.log("[Server] No MCP servers configured");
    return null;
  }

  const mcpConfig = { mcpServers };
  writeFileSync(workspace.mcpConfig, JSON.stringify(mcpConfig, null, 2));
  console.log(`[Server] Generated MCP config at ${workspace.mcpConfig}`);

  return workspace.mcpConfig;
}

// =============================================================================
// State
// =============================================================================

let isProcessing = false;
let isShuttingDown = false;
let continueSession = false;
let currentProcess: ChildProcess | null = null;

interface QueuedMessage {
  content: string;
  threadId: string;
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

// =============================================================================
// Claude Code Execution
// =============================================================================

async function runClaudeCode(
  prompt: string,
  tymbalBridge: TymbalBridge,
  shouldContinue: boolean,
  threadId: string,
  systemPrompt?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const workspace = ensureThreadWorkspace(threadId);
    const mcpConfigPath = generateMcpConfig(workspace);

    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--permission-mode", "bypassPermissions",
    ];

    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
      console.log(`[Server] Using system prompt (${systemPrompt.length} chars)`);
    }

    if (shouldContinue) {
      args.push("--continue");
    }

    args.push("--", prompt);

    console.log(`[Server] Spawning: claude ${args.join(" ")}`);
    console.log(`[Server] Working directory: ${workspace.project}`);

    const proc = spawn("claude", args, {
      cwd: workspace.project,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        CLAUDE_CONFIG_DIR: workspace.claudeConfig,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    currentProcess = proc;
    proc.stdin?.end();

    const rl = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", async (line) => {
      idleMonitor.touch();

      if (!line.trim()) return;

      try {
        const event = JSON.parse(line) as ClaudeCodeEvent;
        console.log(`[Server] Claude event type: ${event.type}`);
        await tymbalBridge.processEvent(event);
      } catch (error) {
        console.error(`[Server] Failed to parse Claude output: ${line}`);
      }
    });

    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      console.error(`[Claude stderr] ${data.toString().trim()}`);
    });

    proc.on("close", async (code) => {
      currentProcess = null;

      if (code === 0) {
        await tymbalBridge.finalize();
        resolve();
      } else {
        console.error(`[Server] Claude exited with code ${code}`);
        reject(new Error(`Claude exited with code ${code}: ${stderr}`));
      }
    });

    proc.on("error", (error) => {
      currentProcess = null;
      console.error(`[Server] Failed to spawn Claude:`, error);
      reject(error);
    });
  });
}

// =============================================================================
// Message Processing
// =============================================================================

async function processMessage(message: QueuedMessage): Promise<void> {
  const { content, threadId, systemPrompt } = message;

  const tymbalBridge = new TymbalBridge({
    castApiUrl: CAST_API_URL,
    threadId,
    callsign: CAST_CALLSIGN || undefined,
  });

  const shouldContinue = continueSession || hasExistingSession(threadId);

  console.log(`[Server] Processing message for thread ${threadId}`);
  console.log(`[Server] Continue session: ${shouldContinue}`);

  try {
    await runClaudeCode(content, tymbalBridge, shouldContinue, threadId, systemPrompt);
    continueSession = true;
    console.log(`[Server] Completed processing for thread ${threadId}`);
  } catch (error) {
    console.error(`[Server] Error processing message:`, error);

    await tymbalBridge.processEvent({
      type: "error",
      error: {
        message: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
}

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

// =============================================================================
// HTTP Handlers
// =============================================================================

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

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isShuttingDown) {
    sendJson(res, 503, { error: "Server is shutting down" });
    return;
  }

  // Validate auth token
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

  interface MessageRequest {
    content: string;
    threadId?: string;
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

  const threadId = body.threadId ?? THREAD_ID;
  if (!threadId) {
    sendJson(res, 400, { error: "Missing threadId" });
    return;
  }

  idleMonitor.touch();

  const queuedMessage: QueuedMessage = {
    content: body.content,
    threadId,
    systemPrompt: body.systemPrompt,
  };

  if (isProcessing) {
    messageQueue.push(queuedMessage);
    console.log(`[Server] Queued message for thread ${threadId} (queue size: ${messageQueue.length})`);
    sendJson(res, 202, { status: "queued", threadId, queuePosition: messageQueue.length });
    return;
  }

  isProcessing = true;
  sendJson(res, 202, { status: "processing", threadId });

  await processMessage(queuedMessage);
  await processQueue();
}

function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const workspace = THREAD_ID ? getThreadWorkspace(THREAD_ID) : null;
  const hasSession = THREAD_ID ? hasExistingSession(THREAD_ID) : false;

  const status = {
    status: isShuttingDown ? "shutting_down" : isProcessing ? "processing" : "healthy",
    threadId: THREAD_ID,
    idleMs: idleMonitor.getIdleMs(),
    continueSession,
    hasSession,
    workspace: workspace?.project ?? null,
    uptime: process.uptime(),
    queueLength: messageQueue.length,
  };

  const statusCode = isShuttingDown ? 503 : 200;
  sendJson(res, statusCode, status);
}

async function handleShutdown(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  sendJson(res, 200, { status: "shutting_down" });
  await gracefulShutdown();
}

// =============================================================================
// Server Lifecycle
// =============================================================================

async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("[Server] Initiating graceful shutdown...");

  idleMonitor.stop();

  const maxWait = 30_000;
  const startWait = Date.now();

  while (isProcessing && Date.now() - startWait < maxWait) {
    console.log("[Server] Waiting for current message to complete...");
    await new Promise((r) => setTimeout(r, 1000));
  }

  if (isProcessing) {
    console.log("[Server] Timed out waiting for message, forcing shutdown");
  }

  server.close(() => {
    console.log("[Server] Server closed");
    process.exit(0);
  });

  setTimeout(() => {
    console.log("[Server] Force exit");
    process.exit(1);
  }, 5000);
}

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
  console.log(`[Server] Claude Code wrapper listening on port ${PORT}`);
  console.log(`[Server] Thread ID: ${THREAD_ID || "(not set)"}`);
  console.log(`[Server] Workspace base: ${WORKSPACE_BASE}`);
  console.log(`[Server] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);

  const mcpEnabled = CAST_CHANNEL_ID && CAST_CALLSIGN;
  console.log(`[Server] MCP tools: ${mcpEnabled ? "enabled" : "disabled"}`);
  if (mcpEnabled) {
    console.log(`[Server]   Channel: ${CAST_CHANNEL_ID}`);
    console.log(`[Server]   Callsign: ${CAST_CALLSIGN}`);
    console.log(`[Server]   Server path: ${MCP_SERVER_PATH}`);
  }

  if (THREAD_ID) {
    const workspace = getThreadWorkspace(THREAD_ID);
    const hasSession = hasExistingSession(THREAD_ID);
    console.log(`[Server] Thread workspace: ${workspace.project}`);
    console.log(`[Server] Existing session: ${hasSession}`);
    if (hasSession) {
      console.log(`[Server] Will use --continue for session resume`);
    }
  }

  idleMonitor.start();
});
