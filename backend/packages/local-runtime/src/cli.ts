#!/usr/bin/env node
/**
 * Local Runtime CLI
 *
 * Run CAST agents on your local machine.
 *
 * Commands:
 *   auth <connection-string>  - Authenticate with CAST
 *   start [--name <name>]     - Start the runtime
 *   status                    - Show runtime status
 *   agents                    - List active agents
 */

import { RuntimeClient } from './runtime-client.js';
import {
  loadConfig,
  initFromConnectionString,
  getConfigPath,
} from './config.js';

// =============================================================================
// Help Text
// =============================================================================

const HELP = `
Miriad Backend - Run CAST agents on your local machine

Usage:
  npx @miriad-systems/backend auth <connection-string>   Authenticate with CAST
  npx @miriad-systems/backend start [options]            Start the runtime
  npx @miriad-systems/backend status                     Show runtime status
  npx @miriad-systems/backend agents                     List active agents
  npx @miriad-systems/backend help                       Show this help message

Commands:
  auth <connection-string>
    Authenticate with CAST using a connection string from the UI.
    Example: npx @miriad-systems/backend auth "cast://bst_xxx@api.cast.dev/space_abc"

  start [--name <name>]
    Start the runtime and connect to CAST.
    Options:
      --name <name>    Runtime name (default: hostname)

  status
    Show the runtime configuration and connection status.

  agents
    List all active agents on this runtime.

Configuration:
  Config is stored at: ~/.config/miriad/config.json

Environment Variables:
  ANTHROPIC_API_KEY    Required for Claude Agent SDK
`;

// =============================================================================
// Commands
// =============================================================================

async function cmdAuth(args: string[]): Promise<void> {
  const connectionString = args[0];

  if (!connectionString) {
    console.error('Error: Connection string required');
    console.error('Usage: npx @miriad-systems/backend auth "cast://bst_xxx@api.cast.dev/space_abc"');
    process.exit(1);
  }

  // Check for --name flag
  let name: string | undefined;
  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    name = args[nameIdx + 1];
  }

  try {
    await initFromConnectionString(connectionString, name);
    console.log('\nAuthentication successful!');
    console.log('Run "npx @miriad-systems/backend start" to connect.');
  } catch (error) {
    console.error('Authentication failed:', (error as Error).message);
    process.exit(1);
  }
}

async function cmdStart(args: string[]): Promise<void> {
  // Validate API key
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('Error: ANTHROPIC_API_KEY environment variable is required');
    process.exit(1);
  }

  // Load config
  const config = await loadConfig();
  if (!config) {
    console.error('Error: Not authenticated. Run "npx @miriad-systems/backend auth" first.');
    process.exit(1);
  }

  // Check for --name flag to override
  const nameIdx = args.indexOf('--name');
  if (nameIdx !== -1 && args[nameIdx + 1]) {
    config.name = args[nameIdx + 1];
  }

  console.log('Starting local runtime...');
  console.log(`  Runtime: ${config.name} (${config.credentials.runtimeId})`);
  console.log(`  Space: ${config.spaceId}`);
  console.log(`  Workspace: ${config.workspace.basePath}`);
  console.log();

  // Create and connect runtime client
  const client = new RuntimeClient({
    config,
    onConnected: () => {
      console.log('Runtime ready. Waiting for agents...');
    },
    onDisconnected: (code, reason) => {
      console.log(`Disconnected: ${code} ${reason}`);
    },
    onError: () => {
      // Error already logged by RuntimeClient with clean formatting
    },
  });

  // Handle shutdown signals
  const shutdown = async () => {
    console.log('\nShutting down...');
    await client.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await client.connect();
    // Keep process alive
    console.log('Press Ctrl+C to stop.');
  } catch {
    // Error already logged by RuntimeClient
    // Don't exit - let reconnection handle it
  }
}

async function cmdStatus(): Promise<void> {
  const config = await loadConfig();

  if (!config) {
    console.log('Status: Not configured');
    console.log(`Config file: ${getConfigPath()}`);
    console.log('\nRun "npx @miriad-systems/backend auth" to configure.');
    return;
  }

  console.log('Local Runtime Status');
  console.log('====================');
  console.log();
  console.log(`Runtime ID:    ${config.credentials.runtimeId}`);
  console.log(`Runtime Name:  ${config.name}`);
  console.log(`Space:         ${config.spaceId}`);
  console.log(`Server:        ${config.credentials.serverId}`);
  console.log(`API URL:       ${config.credentials.apiUrl}`);
  console.log(`WebSocket URL: ${config.credentials.wsUrl}`);
  console.log(`Workspace:     ${config.workspace.basePath}`);
  console.log(`Configured:    ${config.createdAt}`);
  console.log();
  console.log(`Config file: ${getConfigPath()}`);
  console.log();
  console.log('Note: To see active agents, start the runtime and check the UI.');
}

async function cmdAgents(): Promise<void> {
  const config = await loadConfig();

  if (!config) {
    console.error('Error: Not configured. Run "npx @miriad-systems/backend auth" first.');
    process.exit(1);
  }

  console.log('Active Agents');
  console.log('=============');
  console.log();
  console.log('Note: This command shows agents only when the runtime is running.');
  console.log('Use "npx @miriad-systems/backend start" to start the runtime first.');
  console.log();
  console.log('To see agent status, check the CAST UI or runtime logs.');
}

function cmdHelp(): void {
  console.log(HELP);
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    cmdHelp();
    process.exit(0);
  }

  switch (command) {
    case 'auth':
      await cmdAuth(args.slice(1));
      break;

    case 'start':
      await cmdStart(args.slice(1));
      break;

    case 'status':
      await cmdStatus();
      break;

    case 'agents':
      await cmdAgents();
      break;

    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "npx @miriad-systems/backend help" for usage.');
      process.exit(1);
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
