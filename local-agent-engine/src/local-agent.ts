#!/usr/bin/env node
/**
 * Local Agent CLI (Stage 1)
 *
 * Single inline agent that connects to CAST via WebSocket.
 * Registers in a channel, receives messages, runs Claude Agent SDK,
 * and streams Tymbal frames back.
 *
 * Usage:
 *   npm run local-agent -- --channel <channelId> --callsign <name> --workspace <path>
 *
 * Environment Variables:
 *   CAST_WS_HOST - WebSocket host (default: localhost:3234)
 *   CAST_WS_SECURE - Use wss:// (default: false for localhost)
 *   ANTHROPIC_API_KEY - Required for Claude Agent SDK
 */

import WebSocket from "ws";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { query, type SDKMessage, type Options } from "@anthropic-ai/claude-agent-sdk";
import { TymbalBridge } from "./tymbal-bridge.js";
import type {
  ServerMessage,
  RegisterMessage,
  IncomingMessage,
  LocalAgentConfig,
} from "./types.js";

// ============================================================================
// Configuration
// ============================================================================

function parseArgs(): LocalAgentConfig {
  const args = process.argv.slice(2);
  let channelId = "";
  let callsign = "";
  let workspace = "";
  let wsHost = process.env.CAST_WS_HOST ?? "localhost:3234";
  let secure = process.env.CAST_WS_SECURE === "true";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--channel":
        channelId = args[++i];
        break;
      case "--callsign":
        callsign = args[++i];
        break;
      case "--workspace":
        workspace = args[++i];
        break;
      case "--ws-host":
        wsHost = args[++i];
        break;
      case "--secure":
        secure = true;
        break;
      case "--help":
        console.log(`
Local Agent - Run a CAST agent on your machine

Usage:
  local-agent --channel <channelId> --callsign <name> --workspace <path>

Options:
  --channel <id>      Channel ID to join (required)
  --callsign <name>   Agent callsign (required)
  --workspace <path>  Local workspace directory (required)
  --ws-host <host>    WebSocket host (default: localhost:3234)
  --secure            Use wss:// instead of ws://
  --help              Show this help message

Environment Variables:
  CAST_WS_HOST        WebSocket host (default: localhost:3234)
  CAST_WS_SECURE      Use wss:// (default: false)
  ANTHROPIC_API_KEY   Required for Claude Agent SDK
`);
        process.exit(0);
    }
  }

  // Validate required args
  if (!channelId) {
    console.error("Error: --channel is required");
    process.exit(1);
  }
  if (!callsign) {
    console.error("Error: --callsign is required");
    process.exit(1);
  }
  if (!workspace) {
    console.error("Error: --workspace is required");
    process.exit(1);
  }

  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required");
    process.exit(1);
  }

  return { channelId, callsign, workspace, wsHost, secure };
}

// ============================================================================
// Workspace Management
// ============================================================================

function ensureWorkspace(workspace: string): void {
  if (!existsSync(workspace)) {
    console.log(`[LocalAgent] Creating workspace: ${workspace}`);
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

  console.log(`[LocalAgent] Starting SDK query`);
  console.log(`[LocalAgent] Working directory: ${workspace}`);
  console.log(`[LocalAgent] Continue session: ${shouldContinue}`);

  const options: Options = {
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

    // Permissions (user trusts their local environment)
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,

    // Streaming
    includePartialMessages: true,

    // Session management
    continue: shouldContinue,

    // Working directory
    cwd: workspace,

    // Environment for session persistence
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
    console.log(`[LocalAgent] Query completed`);
  } catch (error) {
    console.error(`[LocalAgent] SDK query error:`, error);
    throw error;
  }
}

// ============================================================================
// WebSocket Client
// ============================================================================

class LocalAgentClient {
  private ws: WebSocket | null = null;
  private bridge: TymbalBridge | null = null;
  private config: LocalAgentConfig;
  private isRegistered = false;
  private isProcessing = false;

  constructor(config: LocalAgentConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    const protocol = this.config.secure ? "wss" : "ws";
    const url = `${protocol}://${this.config.wsHost}/local-agents/connect`;

    console.log(`[LocalAgent] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        console.log(`[LocalAgent] Connected`);
        resolve();
      });

      this.ws.on("message", (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on("close", (code, reason) => {
        console.log(`[LocalAgent] Disconnected: ${code} ${reason}`);
        this.cleanup();
      });

      this.ws.on("error", (error) => {
        console.error(`[LocalAgent] WebSocket error:`, error);
        reject(error);
      });
    });
  }

  private handleMessage(data: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(data);
    } catch {
      console.error(`[LocalAgent] Invalid JSON:`, data);
      return;
    }

    console.log(`[LocalAgent] Received: ${message.type}`);

    switch (message.type) {
      case "connected":
        console.log(`[LocalAgent] Protocol version: ${message.version}`);
        this.register();
        break;

      case "registered":
        console.log(`[LocalAgent] Registered as ${message.callsign} in ${message.channelId}`);
        this.isRegistered = true;
        // Initialize bridge after registration
        this.bridge = new TymbalBridge({
          ws: this.ws!,
          channelId: this.config.channelId,
          callsign: this.config.callsign,
        });
        break;

      case "message":
        this.handleIncomingMessage(message);
        break;

      case "error":
        console.error(`[LocalAgent] Error: ${message.code} - ${message.message}`);
        if (!this.isRegistered) {
          // Fatal error during registration
          process.exit(1);
        }
        break;
    }
  }

  private register(): void {
    if (!this.ws) return;

    const message: RegisterMessage = {
      type: "register",
      channelId: this.config.channelId,
      callsign: this.config.callsign,
      workspace: this.config.workspace,
    };

    console.log(`[LocalAgent] Registering as ${this.config.callsign} in ${this.config.channelId}`);
    this.ws.send(JSON.stringify(message));
  }

  private async handleIncomingMessage(message: IncomingMessage): Promise<void> {
    if (!this.bridge) {
      console.error(`[LocalAgent] Bridge not initialized`);
      return;
    }

    if (this.isProcessing) {
      console.log(`[LocalAgent] Already processing, queueing message`);
      // For Stage 1, we don't queue - just log
      // Stage 2 will add proper message queuing
      return;
    }

    this.isProcessing = true;
    console.log(`[LocalAgent] Processing message from ${message.sender}: ${message.content.substring(0, 100)}...`);

    try {
      await runClaudeQuery(
        message.content,
        this.bridge,
        this.config.workspace,
        message.systemPrompt
      );
    } catch (error) {
      console.error(`[LocalAgent] Error processing message:`, error);
    } finally {
      this.isProcessing = false;
    }
  }

  private cleanup(): void {
    this.ws = null;
    this.bridge = null;
    this.isRegistered = false;
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.cleanup();
    }
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();

  console.log(`[LocalAgent] Starting local agent`);
  console.log(`[LocalAgent]   Channel: ${config.channelId}`);
  console.log(`[LocalAgent]   Callsign: ${config.callsign}`);
  console.log(`[LocalAgent]   Workspace: ${config.workspace}`);
  console.log(`[LocalAgent]   WebSocket: ${config.secure ? "wss" : "ws"}://${config.wsHost}`);

  // Ensure workspace exists
  ensureWorkspace(config.workspace);

  // Create client and connect
  const client = new LocalAgentClient(config);

  // Handle shutdown signals
  const shutdown = async () => {
    console.log(`\n[LocalAgent] Shutting down...`);
    await client.disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await client.connect();
    console.log(`[LocalAgent] Ready, waiting for messages...`);
    // Keep process alive
  } catch (error) {
    console.error(`[LocalAgent] Failed to connect:`, error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`[LocalAgent] Fatal error:`, error);
  process.exit(1);
});
