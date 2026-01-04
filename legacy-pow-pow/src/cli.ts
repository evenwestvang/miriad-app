#!/usr/bin/env node
/**
 * Cast CLI - Multi-agent chat for Claude Code
 *
 * Usage:
 *   npx @sanity/cast              Start server + human client
 *   npx @sanity/cast --server     Start server only (headless)
 *   npx @sanity/cast --client     Connect client to existing server
 *   npx @sanity/cast --doctor     Run diagnostics
 *   npx @sanity/cast --help       Show help
 */

import { parseArgs } from 'node:util';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { runDoctor, checkPrerequisites } from './startup/validation.js';
import { configureVpn } from './startup/vpn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Parse CLI arguments
const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: process.env.CAST_PORT || process.env.PORT || '3131' },
    database: { type: 'string', short: 'd', default: process.env.CAST_DATABASE || process.env.POWPOW_DB },
    doctor: { type: 'boolean', default: false },
    server: { type: 'boolean', default: false },
    client: { type: 'boolean', default: false },
    transcript: { type: 'boolean', default: process.env.CAST_TRANSCRIPT === '1' || process.env.POWPOW_TRANSCRIPT === '1' },
    vpn: { type: 'string' },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: true,
  strict: false, // Allow unknown options for subcommand passthrough
});

function showHelp(): void {
  console.log(`
Cast - Multi-agent chat for Claude Code

Usage:
  cast                           Start server + human client
  cast --server                  Start server only (headless)
  cast --client                  Connect client to existing server
  cast --doctor                  Run diagnostics
  cast claude                    Start Claude with Cast wrapper

CLI Operations:
  cast ls                        List all channels
  cast get <channel>             Get messages from channel
  cast send <ch> <name> <msg>    Send a message
  cast watch <channel>           Watch channel live

Options:
  -p, --port <port>              Server port (default: 3131)
  -d, --database <path>          Database path (default: ~/.cast/cast.db)
  --transcript                   Log messages to files
  --vpn <provider>               Expose on VPN network (e.g., --vpn tailscale)
  -h, --help                     Show this help
  -v, --version                  Show version

Environment Variables:
  CAST_PORT                      Server port (fallback: PORT)
  CAST_DATABASE                  Database path (fallback: POWPOW_DB)
  CAST_TRANSCRIPT                Enable transcript logging (fallback: POWPOW_TRANSCRIPT)
`);
}

function showVersion(): void {
  try {
    const pkg = require('../package.json');
    console.log(`cast v${pkg.version}`);
  } catch {
    console.log('cast v0.0.0');
  }
}

// Handle --help
if (values.help) {
  showHelp();
  process.exit(0);
}

// Handle --version
if (values.version) {
  showVersion();
  process.exit(0);
}

// Build environment variables for child processes
const childEnv: Record<string, string> = {
  ...process.env as Record<string, string>,
  PORT: values.port as string,
};

if (values.database) {
  childEnv.CAST_DATABASE = values.database as string;
}

if (values.transcript) {
  childEnv.POWPOW_TRANSCRIPT = '1';
}

// Paths to server and client (these will be .js in dist after compilation)
const serverPath = path.join(__dirname, 'server', 'index.js');
const clientPath = path.join(__dirname, 'client', 'index.js');
const wrapperPath = path.join(__dirname, 'wrapper', 'index.js');

// ─── CLI Operations ──────────────────────────────────────────────────────────

const CAST_URL = process.env.CAST_URL || process.env.POWPOW_URL || `http://localhost:${values.port}`;

interface Channel { name: string; createdAt: string; }
interface Message { id: string; channel: string; sender: string; timestamp: string; content: string; }

async function apiCall<T>(method: string, apiPath: string, body?: unknown): Promise<T> {
  const response = await fetch(`${CAST_URL}${apiPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`API error: ${response.status} - ${error}`);
  }
  return response.json();
}

async function cliListChannels(): Promise<void> {
  const channels = await apiCall<Channel[]>('GET', '/api/channels');
  if (channels.length === 0) {
    console.log('No channels yet.');
    return;
  }
  console.log('Channels:');
  for (const ch of channels) {
    console.log(`  #${ch.name}`);
  }
}

async function cliGetMessages(channel: string, limit: number): Promise<void> {
  const query = limit ? `?limit=${limit}` : '';
  const messages = await apiCall<Message[]>(
    'GET',
    `/api/channels/${encodeURIComponent(channel)}/messages${query}`
  );
  if (messages.length === 0) {
    console.log(`No messages in #${channel}`);
    return;
  }
  for (const msg of messages) {
    const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    console.log(`[${time}] ${msg.sender}: ${msg.content}`);
  }
}

async function cliSendMessage(channel: string, sender: string, content: string): Promise<void> {
  await apiCall<Message>(
    'POST',
    `/api/channels/${encodeURIComponent(channel)}/messages`,
    { sender, content }
  );
  console.log(`Sent to #${channel}`);
}

async function cliWatchChannel(channel: string): Promise<void> {
  console.log(`Watching #${channel} (Ctrl+C to stop)...`);
  const seenIds = new Set<string>();
  let initialized = false;

  const connect = async (): Promise<void> => {
    try {
      const response = await fetch(
        `${CAST_URL}/api/channels/${encodeURIComponent(channel)}/stream`
      );
      const reader = response.body?.getReader();
      if (!reader) {
        setTimeout(connect, 3000);
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.error('Stream ended, reconnecting...');
          setTimeout(connect, 1000);
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';
        for (const line of lines) {
          if (line.startsWith('event: ')) {
            currentEvent = line.slice(7);
          } else if (line.startsWith('data: ') && currentEvent === 'messages') {
            try {
              const messages: Message[] = JSON.parse(line.slice(6));
              if (!initialized) {
                messages.forEach((m) => seenIds.add(m.id));
                initialized = true;
                const recent = messages.slice(-3);
                for (const msg of recent) {
                  const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                  console.log(`[${time}] ${msg.sender}: ${msg.content}`);
                }
                console.log('--- live ---');
                continue;
              }
              for (const msg of messages) {
                if (!seenIds.has(msg.id)) {
                  seenIds.add(msg.id);
                  const time = new Date(msg.timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
                  console.log(`[${time}] ${msg.sender}: ${msg.content}`);
                }
              }
            } catch {
              // Ignore parse errors
            }
          }
        }
      }
    } catch {
      console.error('Connection error, reconnecting...');
      setTimeout(connect, 3000);
    }
  };
  connect();
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = positionals;
  const port = parseInt(values.port as string) || 3131;
  const databasePath = values.database as string | undefined;

  // Handle --doctor
  if (values.doctor) {
    await runDoctor({ port, databasePath });
    return;
  }

  // CLI commands (ls, get, send, watch, claude)
  if (args[0] === 'ls' || args[0] === 'list-channels') {
    await cliListChannels();
    return;
  }

  if (args[0] === 'get' || args[0] === 'get-messages' || args[0] === 'messages') {
    const channel = args[1];
    if (!channel) {
      console.error('Usage: cast get <channel> [--limit N]');
      process.exit(1);
    }
    // Parse --limit from remaining args
    const rawArgs = process.argv.slice(2);
    const limitIdx = rawArgs.indexOf('--limit');
    const limit = limitIdx !== -1 ? parseInt(rawArgs[limitIdx + 1]) || 50 : 50;
    await cliGetMessages(channel, limit);
    return;
  }

  if (args[0] === 'send') {
    const channel = args[1];
    const sender = args[2];
    const content = args.slice(3).join(' ');
    if (!channel || !sender || !content) {
      console.error('Usage: cast send <channel> <sender> <message>');
      process.exit(1);
    }
    await cliSendMessage(channel, sender, content);
    return;
  }

  if (args[0] === 'watch') {
    const channel = args[1];
    if (!channel) {
      console.error('Usage: cast watch <channel>');
      process.exit(1);
    }
    await cliWatchChannel(channel);
    return;
  }

  // cast claude [...args] → run the wrapper
  if (args[0] === 'claude') {
    const wrapperArgs = args.slice(1);

    const child = spawn('node', [wrapperPath, ...wrapperArgs], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: childEnv,
    });

    child.on('exit', (code) => process.exit(code || 0));
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    return;
  }

  // Handle --vpn flag
  let vpnUrl: string | undefined;
  if (values.vpn) {
    const result = await configureVpn(values.vpn as string, port);
    if (!result.ok) {
      console.error(`❌ ${result.error}`);
      process.exit(1);
    }
    childEnv.HOST = result.config.bindHost;
    vpnUrl = result.config.vpnUrl;
  }

  // cast --client → client only
  if (values.client) {
    const child = spawn('node', [clientPath], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: childEnv,
    });

    child.on('exit', (code) => process.exit(code || 0));
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    return;
  }

  // cast --server → server only (headless, no banner)
  if (values.server) {
    // Check prerequisites before starting server
    const prereqResult = await checkPrerequisites({ port, databasePath });
    if (!prereqResult.ok) {
      console.error(prereqResult.message);
      console.error('\nRun `npx @sanity/cast --doctor` for detailed diagnostics.');
      process.exit(1);
    }

    const child = spawn('node', [serverPath], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: childEnv,
    });

    child.on('exit', (code) => process.exit(code || 0));
    process.on('SIGINT', () => child.kill('SIGINT'));
    process.on('SIGTERM', () => child.kill('SIGTERM'));
    return;
  }

  // cast → start server with web UI (default)
  if (args.length === 0) {
    // Check prerequisites before starting server
    const prereqResult = await checkPrerequisites({ port, databasePath });
    if (!prereqResult.ok) {
      console.error(prereqResult.message);
      console.error('\nRun `npx @sanity/cast --doctor` for detailed diagnostics.');
      process.exit(1);
    }

    // Print startup banner
    console.log('');
    console.log('  🎭 Cast is running!');
    console.log('');
    console.log(`     Local:   http://localhost:${port}`);
    if (vpnUrl) {
      console.log(`     Network: ${vpnUrl}`);
    }
    console.log('');
    console.log('     Press Ctrl+C to stop');
    console.log('');

    // Start server in foreground
    const server = spawn('node', [serverPath], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: childEnv,
    });

    server.on('exit', (code) => {
      process.exit(code || 0);
    });

    process.on('SIGINT', () => {
      server.kill('SIGINT');
    });
    process.on('SIGTERM', () => {
      server.kill('SIGTERM');
    });
    return;
  }

  console.error(`Unknown command: ${args[0]}`);
  console.error("Run 'cast --help' for usage");
  process.exit(1);
}

// Run main
main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
