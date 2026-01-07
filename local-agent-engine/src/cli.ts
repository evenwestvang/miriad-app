#!/usr/bin/env node
/**
 * Cast Local Agent CLI (Stage 5)
 *
 * Unified entry point for local agent server.
 * Supports running via npx:
 *   npx @anthropic/cast-local-agent init "cast://..."
 *   npx @anthropic/cast-local-agent
 *   npx @anthropic/cast-local-agent connect --channel ch_xxx --callsign fox
 *
 * Commands:
 *   init <connection-string>  Initialize with CAST credentials
 *   server                    Start the local agent server (default)
 *   connect                   Add an agent to the running server
 *   status                    Show server status
 *   list                      List connected agents
 *   disconnect                Remove an agent
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// =============================================================================
// CLI Configuration
// =============================================================================

const VERSION = "0.2.0";

const HELP = `
Cast Local Agent v${VERSION}
Run CAST agents on your local machine.

Usage:
  cast-local-agent [command] [options]

Commands:
  init <connection-string>   Initialize with CAST credentials
  server                     Start the local agent server (default)
  connect                    Add an agent to the running server
  status                     Show server status
  list                       List connected agents
  disconnect                 Remove an agent from the server

Server Options:
  --ws-host <host>           WebSocket host (overrides auto-detect)
  --api-host <host>          API host (overrides auto-detect)
  --profile <name>           Use named profile (local, staging)
  --socket <path>            IPC socket path

Connect Options:
  --channel <id>             Channel ID (required)
  --callsign <name>          Agent callsign (required)
  --workspace <path>         Workspace directory (default: /tmp/agents/<callsign>)

Disconnect Options:
  --channel <id>             Channel ID (required)
  --callsign <name>          Agent callsign (required)

Environment Variables:
  ANTHROPIC_API_KEY          Required for Claude Agent SDK
  CAST_WS_HOST               WebSocket host override
  CAST_API_HOST              API host override
  CAST_PROFILE               Profile name

Examples:
  # Initialize from CAST UI connection string
  cast-local-agent init "cast://bst_xxx@api.cast.dev/space_yyy"

  # Start the server
  cast-local-agent

  # Add an agent to a channel
  cast-local-agent connect --channel ch_123 --callsign fox

  # Check status
  cast-local-agent status

  # List agents
  cast-local-agent list

  # Remove an agent
  cast-local-agent disconnect --channel ch_123 --callsign fox

Documentation:
  https://github.com/simen/cast-app/tree/main/local-agent-engine
`;

// =============================================================================
// Helpers
// =============================================================================

function getScriptPath(script: string): string {
  // In development (tsx), scripts are .ts files
  // In production (compiled), they're .js files
  const ext = process.env.NODE_ENV === "development" ? ".ts" : ".js";
  return join(__dirname, `${script}${ext}`);
}

function runScript(script: string, args: string[]): void {
  const scriptPath = getScriptPath(script);

  // Use tsx in development, node in production
  const runner = process.env.NODE_ENV === "development" ? "tsx" : "node";

  const child = spawn(runner, [scriptPath, ...args], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("close", (code) => {
    process.exit(code ?? 0);
  });

  child.on("error", (error) => {
    console.error(`Failed to run ${script}:`, error);
    process.exit(1);
  });
}

// =============================================================================
// Command Handlers
// =============================================================================

function handleInit(args: string[]): void {
  if (args.length === 0) {
    console.error("Error: Connection string required");
    console.error('Usage: cast-local-agent init "cast://..."');
    process.exit(1);
  }

  runScript("local-agent-server", ["init", args[0]]);
}

function handleServer(args: string[]): void {
  runScript("local-agent-server", args);
}

function handleConnect(args: string[]): void {
  runScript("connect-local-agent", ["add", ...args]);
}

function handleStatus(args: string[]): void {
  runScript("connect-local-agent", ["status", ...args]);
}

function handleList(args: string[]): void {
  runScript("connect-local-agent", ["list", ...args]);
}

function handleDisconnect(args: string[]): void {
  runScript("connect-local-agent", ["remove", ...args]);
}

// =============================================================================
// Main
// =============================================================================

function main(): void {
  const args = process.argv.slice(2);

  // Handle help and version
  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  // Parse command
  const command = args[0];
  const commandArgs = args.slice(1);

  switch (command) {
    case "init":
      handleInit(commandArgs);
      break;

    case "server":
      handleServer(commandArgs);
      break;

    case "connect":
      handleConnect(commandArgs);
      break;

    case "status":
      handleStatus(commandArgs);
      break;

    case "list":
      handleList(commandArgs);
      break;

    case "disconnect":
      handleDisconnect(commandArgs);
      break;

    case undefined:
      // Default: start server
      handleServer([]);
      break;

    default:
      // If it looks like a connection string, treat as init
      if (command.startsWith("cast://")) {
        handleInit([command, ...commandArgs]);
      } else if (command.startsWith("-")) {
        // Flags without command = server with flags
        handleServer(args);
      } else {
        console.error(`Unknown command: ${command}`);
        console.error("Run 'cast-local-agent --help' for usage");
        process.exit(1);
      }
  }
}

main();
