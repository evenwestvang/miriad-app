/**
 * Claude Code Wrapper Server
 *
 * HTTP server that receives messages from the orchestrator,
 * spawns Claude Code CLI, and streams output via Tymbal.
 *
 * Endpoints:
 * - POST /message - Send message to Claude Code
 * - GET /health - Health check for ECS
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

// Inline types and converter from @cikada/mcp to avoid workspace dependency in Docker
interface McpServerConfig {
  type: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

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

function convertToMcpServerConfig(resolved: ResolvedMcpConfig): McpServerConfig {
  if (resolved.transport === "stdio") {
    return {
      type: "stdio",
      command: resolved.command,
      args: resolved.args,
      env: resolved.env,
      cwd: resolved.cwd,
    };
  } else {
    return {
      type: "http",
      url: resolved.url,
      headers: resolved.headers,
    };
  }
}

// Configuration from environment
const PORT = parseInt(process.env.PORT ?? "8080", 10);
const THREAD_ID = process.env.THREAD_ID ?? "";
const CIKADA_API_URL = process.env.CIKADA_API_URL ?? "";
const CIKADA_CHANNEL_ID = process.env.CIKADA_CHANNEL_ID ?? "";
const CIKADA_CALLSIGN = process.env.CIKADA_CALLSIGN ?? "";
const CIKADA_AUTH_TOKEN = process.env.CIKADA_AUTH_TOKEN ?? "";
const WORKSPACE_BASE = process.env.WORKSPACE_DIR ?? "/workspace";
const IDLE_TIMEOUT_MS = parseInt(process.env.IDLE_TIMEOUT_MS ?? String(10 * 60 * 1000), 10);

// Get path to MCP artifact server (relative to this file's compiled location)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const MCP_ARTIFACT_SERVER_PATH = join(__dirname, "mcp-artifact-server.js");

// Per-thread directory structure:
// /workspace/threads/{threadId}/
//   ├── project/     # Working directory for code
//   ├── .claude/     # Claude Code session state
//   └── mcp-config.json  # MCP server configuration
function getThreadWorkspace(threadId: string): {
  root: string;
  project: string;
  claudeConfig: string;
  mcpConfig: string;
} {
  const root = join(WORKSPACE_BASE, "threads", threadId);
  return {
    root,
    project: join(root, "project"),
    claudeConfig: join(root, ".claude"),
    mcpConfig: join(root, "mcp-config.json"),
  };
}

/**
 * Ensure thread workspace directories exist.
 */
function ensureThreadWorkspace(threadId: string): ReturnType<typeof getThreadWorkspace> {
  const workspace = getThreadWorkspace(threadId);

  // Create directories if they don't exist
  if (!existsSync(workspace.project)) {
    console.log(`[Server] Creating workspace directories for thread ${threadId}`);
    mkdirSync(workspace.project, { recursive: true });
  }

  // .claude directory is created by Claude Code itself
  // but we check for its existence to determine if we should use --continue

  return workspace;
}

/**
 * Check if a previous Claude session exists for this thread.
 */
function hasExistingSession(threadId: string): boolean {
  const workspace = getThreadWorkspace(threadId);
  return existsSync(workspace.claudeConfig);
}

/**
 * Generate MCP config file for Claude Code.
 * This configures the artifact server with per-agent channel/callsign,
 * plus any additional MCPs resolved by the orchestrator.
 */
function generateMcpConfig(
  workspace: ReturnType<typeof getThreadWorkspace>,
  resolvedMcps?: ResolvedMcpConfig[]
): string | null {
  const mcpServers: Record<string, McpServerConfig> = {};

  // Add built-in cikada-artifacts MCP if configured
  if (CIKADA_CHANNEL_ID && CIKADA_CALLSIGN && existsSync(MCP_ARTIFACT_SERVER_PATH)) {
    mcpServers["cikada-artifacts"] = {
      type: "stdio",
      command: "node",
      args: [MCP_ARTIFACT_SERVER_PATH],
      env: {
        CIKADA_API_URL: CIKADA_API_URL,
        CIKADA_CHANNEL_ID: CIKADA_CHANNEL_ID,
        CIKADA_CALLSIGN: CIKADA_CALLSIGN,
        CIKADA_AUTH_TOKEN: CIKADA_AUTH_TOKEN,
      },
    };
    console.log("[Server] Added built-in cikada-artifacts MCP");
  } else {
    console.log("[Server] Built-in cikada-artifacts MCP disabled - missing config or server");
  }

  // Add resolved MCPs from orchestrator (already have env vars resolved)
  if (resolvedMcps && resolvedMcps.length > 0) {
    for (const resolved of resolvedMcps) {
      mcpServers[resolved.slug] = convertToMcpServerConfig(resolved);
      console.log(`[Server] Added resolved MCP: ${resolved.slug} (${resolved.transport})`);
    }
  }

  // If no MCPs configured at all, skip config file
  if (Object.keys(mcpServers).length === 0) {
    console.log("[Server] No MCP servers configured");
    return null;
  }

  const mcpConfig = { mcpServers };
  writeFileSync(workspace.mcpConfig, JSON.stringify(mcpConfig, null, 2));
  console.log(`[Server] Generated MCP config at ${workspace.mcpConfig} with ${Object.keys(mcpServers).length} server(s)`);

  return workspace.mcpConfig;
}

// State
let isProcessing = false;
let isShuttingDown = false;
let continueSession = false; // Set to true after first message OR if session exists on EFS
let currentProcess: ChildProcess | null = null;

// Message queue for handling messages while busy
interface QueuedMessage {
  content: string;
  threadId: string;
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
 * Spawn Claude Code CLI and stream output.
 */
async function runClaudeCode(
  prompt: string,
  tymbalBridge: TymbalBridge,
  shouldContinue: boolean,
  threadId: string,
  resolvedMcps?: ResolvedMcpConfig[],
  systemPrompt?: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Ensure workspace directories exist
    const workspace = ensureThreadWorkspace(threadId);

    // Generate MCP config for artifact tools + resolved MCPs from orchestrator
    const mcpConfigPath = generateMcpConfig(workspace, resolvedMcps);

    // Build CLI arguments
    // Note: --verbose is required when using --output-format stream-json
    // --dangerously-skip-permissions + --permission-mode bypassPermissions = full sandbox mode
    const args = [
      "--print",
      "--verbose",
      "--output-format", "stream-json",
      "--dangerously-skip-permissions",
      "--permission-mode", "bypassPermissions",
    ];

    // Add MCP config if available
    if (mcpConfigPath) {
      args.push("--mcp-config", mcpConfigPath);
    }

    // Add system prompt if provided (channel context, roster, @mention rules)
    if (systemPrompt) {
      args.push("--system-prompt", systemPrompt);
      console.log(`[Server] Using system prompt (${systemPrompt.length} chars)`);
    }

    if (shouldContinue) {
      args.push("--continue");
    }

    // Add the prompt with -- separator to prevent it from being parsed as flags
    args.push("--", prompt);

    console.log(`[Server] Spawning: claude ${args.join(" ")}`);
    console.log(`[Server] Working directory: ${workspace.project}`);
    console.log(`[Server] Claude config dir: ${workspace.claudeConfig}`);

    const proc = spawn("claude", args, {
      cwd: workspace.project,
      env: {
        ...process.env,
        // Ensure Claude Code uses the right API key
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        // Set Claude config directory to per-thread path on EFS
        // This is where Claude Code stores session state for --continue
        CLAUDE_CONFIG_DIR: workspace.claudeConfig,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    currentProcess = proc;

    // Close stdin immediately since we pass prompt as argument
    // Without this, Claude CLI waits for stdin EOF
    proc.stdin?.end();

    // Parse JSON lines from stdout
    const rl = createInterface({
      input: proc.stdout,
      crlfDelay: Infinity,
    });

    rl.on("line", async (line) => {
      idleMonitor.touch();

      if (!line.trim()) return;

      try {
        const event = JSON.parse(line) as ClaudeCodeEvent;
        // Debug: log all event types
        console.log(`[Server] Claude event type: ${event.type}`);
        await tymbalBridge.processEvent(event);
      } catch (error) {
        console.error(`[Server] Failed to parse Claude output: ${line}`);
      }
    });

    // Capture stderr for debugging
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
 * Process a single message through Claude Code.
 * Called for both immediate messages and queued messages.
 */
async function processMessage(message: QueuedMessage): Promise<void> {
  const { content, threadId, resolvedMcps, systemPrompt } = message;

  // Create Tymbal bridge for this conversation
  // Pass callsign so frames include correct sender for routing
  const tymbalBridge = new TymbalBridge({
    cikadaApiUrl: CIKADA_API_URL,
    threadId,
    callsign: CIKADA_CALLSIGN || undefined,
  });

  // Check if we should use --continue:
  // 1. If we've already processed a message in this container session
  // 2. OR if a previous session exists on EFS (container restart resume)
  const shouldContinue = continueSession || hasExistingSession(threadId);

  console.log(`[Server] Processing message for thread ${threadId}`);
  console.log(`[Server] Continue session: ${shouldContinue} (in-memory: ${continueSession}, EFS session exists: ${hasExistingSession(threadId)})`);

  try {
    // Run Claude Code CLI with any resolved MCPs and system prompt from the orchestrator
    await runClaudeCode(content, tymbalBridge, shouldContinue, threadId, resolvedMcps, systemPrompt);

    // Mark that we should continue for subsequent messages in this container
    continueSession = true;

    console.log(`[Server] Completed processing for thread ${threadId}`);
  } catch (error) {
    console.error(`[Server] Error processing message:`, error);

    // Emit error via Tymbal
    await tymbalBridge.processEvent({
      type: "error",
      error: {
        message: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
}

/**
 * Process the message queue.
 * Called after each message completes to check for queued messages.
 */
async function processQueue(): Promise<void> {
  while (messageQueue.length > 0 && !isShuttingDown) {
    const nextMessage = messageQueue.shift();
    if (nextMessage) {
      console.log(`[Server] Processing queued message (${messageQueue.length} remaining in queue)`);
      await processMessage(nextMessage);
    }
  }
  isProcessing = false;
  idleMonitor.touch();
}

/**
 * Handle POST /message - Send message to Claude Code.
 * If busy, messages are queued and processed in order.
 */
async function handleMessage(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (isShuttingDown) {
    sendJson(res, 503, { error: "Server is shutting down" });
    return;
  }

  // Parse request body
  interface MessageRequest {
    content: string;
    threadId?: string;
    resolvedMcps?: ResolvedMcpConfig[];  // Pre-resolved MCP configs from orchestrator
    systemPrompt?: string;  // System prompt with channel context, roster, @mention rules
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

  // Reset idle timer
  idleMonitor.touch();

  const queuedMessage: QueuedMessage = {
    content: body.content,
    threadId,
    resolvedMcps: body.resolvedMcps,
    systemPrompt: body.systemPrompt,
  };

  // If already processing, queue the message
  if (isProcessing) {
    messageQueue.push(queuedMessage);
    console.log(`[Server] Queued message for thread ${threadId} (queue size: ${messageQueue.length})`);
    sendJson(res, 202, { status: "queued", threadId, queuePosition: messageQueue.length });
    return;
  }

  // Start processing immediately
  isProcessing = true;
  sendJson(res, 202, { status: "processing", threadId });

  // Process this message then drain the queue
  await processMessage(queuedMessage);
  await processQueue();
}

/**
 * Handle GET /health - Health check for ECS.
 */
function handleHealth(_req: IncomingMessage, res: ServerResponse): void {
  const workspace = THREAD_ID ? getThreadWorkspace(THREAD_ID) : null;
  const hasSession = THREAD_ID ? hasExistingSession(THREAD_ID) : false;

  const status = {
    status: isShuttingDown ? "shutting_down" : isProcessing ? "processing" : "healthy",
    threadId: THREAD_ID,
    idleMs: idleMonitor.getIdleMs(),
    continueSession,
    hasEfsSession: hasSession,
    workspace: workspace?.project ?? null,
    uptime: process.uptime(),
    queueLength: messageQueue.length,
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
 * Gracefully shut down the server.
 */
async function gracefulShutdown(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log("[Server] Initiating graceful shutdown...");

  // Stop idle monitor
  idleMonitor.stop();

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
if (!CIKADA_API_URL) {
  console.warn("[Server] Warning: CIKADA_API_URL not set, Tymbal streaming disabled");
}

// Start server
server.listen(PORT, () => {
  console.log(`[Server] Claude Code wrapper listening on port ${PORT}`);
  console.log(`[Server] Thread ID: ${THREAD_ID || "(not set)"}`);
  console.log(`[Server] Workspace base: ${WORKSPACE_BASE}`);
  console.log(`[Server] Idle timeout: ${IDLE_TIMEOUT_MS / 1000}s`);

  // MCP artifact tools status
  const mcpEnabled = CIKADA_CHANNEL_ID && CIKADA_CALLSIGN;
  console.log(`[Server] MCP artifact tools: ${mcpEnabled ? "enabled" : "disabled"}`);
  if (mcpEnabled) {
    console.log(`[Server]   Channel: ${CIKADA_CHANNEL_ID}`);
    console.log(`[Server]   Callsign: ${CIKADA_CALLSIGN}`);
    console.log(`[Server]   Server path: ${MCP_ARTIFACT_SERVER_PATH}`);
  }

  // Check for existing session on EFS (for resume after container restart)
  if (THREAD_ID) {
    const workspace = getThreadWorkspace(THREAD_ID);
    const hasSession = hasExistingSession(THREAD_ID);
    console.log(`[Server] Thread workspace: ${workspace.project}`);
    console.log(`[Server] Existing EFS session: ${hasSession}`);
    if (hasSession) {
      console.log(`[Server] Will use --continue for session resume`);
    }
  }

  // Start idle monitor
  idleMonitor.start();
});
