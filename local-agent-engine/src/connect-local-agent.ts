#!/usr/bin/env node
/**
 * Connect Local Agent CLI (Stage 2)
 *
 * CLI tool to add/remove/list agents in the local-agent-server.
 * Communicates via IPC (Unix socket or TCP).
 *
 * Usage:
 *   pnpm connect-local-agent add --channel <id> --callsign <name> --workspace <path>
 *   pnpm connect-local-agent remove --channel <id> --callsign <name>
 *   pnpm connect-local-agent list
 *   pnpm connect-local-agent status
 *
 * Environment Variables:
 *   LOCAL_AGENT_SOCK - IPC socket path (default: /tmp/local-agent.sock)
 */

import { connect, type Socket } from "node:net";
import type { IPCCommand, IPCResponse, IPCAgentInfo } from "./types.js";

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_SOCKET_PATH = "/tmp/local-agent.sock";

interface CLIConfig {
  command: "add" | "remove" | "list" | "status" | "help";
  channelId?: string;
  callsign?: string;
  workspace?: string;
  socketPath: string;
}

function parseArgs(): CLIConfig {
  const args = process.argv.slice(2);
  const socketPath = process.env.LOCAL_AGENT_SOCK ?? DEFAULT_SOCKET_PATH;

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { command: "help", socketPath };
  }

  const command = args[0] as CLIConfig["command"];
  let channelId: string | undefined;
  let callsign: string | undefined;
  let workspace: string | undefined;

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--channel":
      case "-c":
        channelId = args[++i];
        break;
      case "--callsign":
      case "-n":
        callsign = args[++i];
        break;
      case "--workspace":
      case "-w":
        workspace = args[++i];
        break;
    }
  }

  return { command, channelId, callsign, workspace, socketPath };
}

function printHelp(): void {
  console.log(`
Connect Local Agent - Manage agents in local-agent-server

Usage:
  connect-local-agent <command> [options]

Commands:
  add       Add a new agent to the server
  remove    Remove an agent from the server
  list      List all registered agents
  status    Show server status

Options for 'add':
  --channel, -c <id>      Channel ID to join (required)
  --callsign, -n <name>   Agent callsign (required)
  --workspace, -w <path>  Local workspace directory (required)

Options for 'remove':
  --channel, -c <id>      Channel ID (required)
  --callsign, -n <name>   Agent callsign (required)

Environment Variables:
  LOCAL_AGENT_SOCK    IPC socket path (default: /tmp/local-agent.sock)

Examples:
  connect-local-agent add -c ch_123 -n fox -w /tmp/fox
  connect-local-agent remove -c ch_123 -n fox
  connect-local-agent list
  connect-local-agent status
`);
}

// ============================================================================
// IPC Client
// ============================================================================

function sendCommand(socketPath: string, command: IPCCommand): Promise<IPCResponse> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect(socketPath);
    let buffer = "";
    let resolved = false;

    // Timeout after 10 seconds
    const timeoutId = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        reject(new Error("Request timed out"));
      }
    }, 10000);

    const cleanup = () => {
      clearTimeout(timeoutId);
      socket.destroy();
    };

    socket.on("connect", () => {
      socket.write(JSON.stringify(command) + "\n");
    });

    socket.on("data", (data) => {
      buffer += data.toString();

      // Look for complete response (newline-delimited)
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1 && !resolved) {
        resolved = true;
        const responseStr = buffer.slice(0, newlineIndex);
        try {
          const response = JSON.parse(responseStr) as IPCResponse;
          cleanup();
          resolve(response);
        } catch {
          cleanup();
          reject(new Error("Invalid response from server"));
        }
      }
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
          reject(new Error("Server not running. Start local-agent-server first."));
        } else {
          reject(error);
        }
      }
    });

    socket.on("close", () => {
      if (!resolved && !buffer.includes("\n")) {
        resolved = true;
        cleanup();
        reject(new Error("Connection closed without response"));
      }
    });
  });
}

// ============================================================================
// Command Handlers
// ============================================================================

async function handleAdd(config: CLIConfig): Promise<void> {
  if (!config.channelId) {
    console.error("Error: --channel is required");
    process.exit(1);
  }
  if (!config.callsign) {
    console.error("Error: --callsign is required");
    process.exit(1);
  }
  if (!config.workspace) {
    console.error("Error: --workspace is required");
    process.exit(1);
  }

  const command: IPCCommand = {
    type: "add",
    channelId: config.channelId,
    callsign: config.callsign,
    workspace: config.workspace,
  };

  const response = await sendCommand(config.socketPath, command);

  if (response.type === "ok") {
    console.log(`✓ ${response.message}`);
  } else if (response.type === "error") {
    console.error(`✗ ${response.message}`);
    process.exit(1);
  }
}

async function handleRemove(config: CLIConfig): Promise<void> {
  if (!config.channelId) {
    console.error("Error: --channel is required");
    process.exit(1);
  }
  if (!config.callsign) {
    console.error("Error: --callsign is required");
    process.exit(1);
  }

  const command: IPCCommand = {
    type: "remove",
    channelId: config.channelId,
    callsign: config.callsign,
  };

  const response = await sendCommand(config.socketPath, command);

  if (response.type === "ok") {
    console.log(`✓ ${response.message}`);
  } else if (response.type === "error") {
    console.error(`✗ ${response.message}`);
    process.exit(1);
  }
}

async function handleList(config: CLIConfig): Promise<void> {
  const command: IPCCommand = { type: "list" };
  const response = await sendCommand(config.socketPath, command);

  if (response.type === "agents") {
    const agents = response.agents;

    if (agents.length === 0) {
      console.log("No agents registered");
      return;
    }

    console.log(`\nRegistered Agents (${agents.length}):\n`);
    console.log("  CHANNEL          CALLSIGN    STATUS      WORKSPACE");
    console.log("  ───────────────  ──────────  ──────────  ─────────────────────────");

    for (const agent of agents) {
      const status = formatStatus(agent.status);
      const channel = agent.channelId.padEnd(15);
      const callsign = agent.callsign.padEnd(10);
      const workspace = agent.workspace;
      console.log(`  ${channel}  ${callsign}  ${status}  ${workspace}`);
    }
    console.log();
  } else if (response.type === "error") {
    console.error(`✗ ${response.message}`);
    process.exit(1);
  }
}

async function handleStatus(config: CLIConfig): Promise<void> {
  const command: IPCCommand = { type: "status" };
  const response = await sendCommand(config.socketPath, command);

  if (response.type === "status") {
    const connected = response.connected ? "✓ Connected" : "✗ Disconnected";
    const uptime = formatUptime(response.uptime);

    console.log(`
Local Agent Server Status
─────────────────────────
  WebSocket:  ${connected} (${response.wsHost})
  Agents:     ${response.agentCount}
  Uptime:     ${uptime}
`);
  } else if (response.type === "error") {
    console.error(`✗ ${response.message}`);
    process.exit(1);
  }
}

function formatStatus(status: IPCAgentInfo["status"]): string {
  switch (status) {
    case "idle":
      return "idle      ".slice(0, 10);
    case "processing":
      return "processing".slice(0, 10);
    case "disconnected":
      return "offline   ".slice(0, 10);
    default:
      return "unknown   ".slice(0, 10);
  }
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h ${minutes % 60}m`;
  } else if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const config = parseArgs();

  switch (config.command) {
    case "help":
      printHelp();
      break;

    case "add":
      await handleAdd(config);
      break;

    case "remove":
      await handleRemove(config);
      break;

    case "list":
      await handleList(config);
      break;

    case "status":
      await handleStatus(config);
      break;

    default:
      console.error(`Unknown command: ${config.command}`);
      printHelp();
      process.exit(1);
  }
}

main().catch((error) => {
  console.error(`Error: ${error.message}`);
  process.exit(1);
});
