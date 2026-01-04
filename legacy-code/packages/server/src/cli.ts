#!/usr/bin/env node
/**
 * Cikada Server CLI
 *
 * Usage: cikada-server [options]
 *
 * Options:
 *   --port, -p      Port to listen on (default: 3001)
 *   --db            SQLite database path (default: ~/.cikada/cikada.db)
 *   --memory        Use in-memory database
 *   --no-sandbox    Disable Docker sandbox (sandbox is enabled by default)
 *   --mock-auth     Enable mock authentication (direct login bypass, for testing)
 *   --sanity-auth   Force real Sanity OAuth (default: mock OAuth in dev, real in production)
 */

// Load .env file for local development
import 'dotenv/config';

import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createServer } from './index.js';
import { createSqliteStorage } from '@cikada/storage/sqlite';
import { bootstrap } from './bootstrap.js';

// =============================================================================
// Default Paths
// =============================================================================

const CIKADA_DIR = path.join(os.homedir(), '.cikada');
const DEFAULT_DB_PATH = path.join(CIKADA_DIR, 'cikada.db');

// =============================================================================
// Parse Arguments
// =============================================================================

const args = process.argv.slice(2);

function getArg(name: string, short?: string): string | undefined {
  const longIndex = args.indexOf(`--${name}`);
  if (longIndex !== -1 && args[longIndex + 1]) {
    return args[longIndex + 1];
  }
  if (short) {
    const shortIndex = args.indexOf(`-${short}`);
    if (shortIndex !== -1 && args[shortIndex + 1]) {
      return args[shortIndex + 1];
    }
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

// =============================================================================
// Configuration
// =============================================================================

const port = parseInt(getArg('port', 'p') ?? '3001', 10);
const useMemory = hasFlag('memory');
const dbPath = useMemory ? ':memory:' : (getArg('db') ?? DEFAULT_DB_PATH);
// Sandbox is enabled by default, use --no-sandbox or DISABLE_SANDBOX=true to disable
const enableSandbox = !hasFlag('no-sandbox') && process.env.DISABLE_SANDBOX !== 'true';
const mockAuth = hasFlag('mock-auth') || process.env.MOCK_AUTH === 'true';
const useSanityOAuth = hasFlag('sanity-auth') || process.env.USE_SANITY_OAUTH === 'true';

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log('[Cikada] Starting server...');
  const absoluteDbPath = useMemory ? ':memory:' : path.resolve(dbPath);

  // Ensure database directory exists
  if (!useMemory) {
    const dbDir = path.dirname(absoluteDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`[Cikada] Created directory: ${dbDir}`);
    }
  }

  console.log(`[Cikada] Storage: ${absoluteDbPath}`);
  if (enableSandbox) {
    console.log('[Cikada] Docker sandbox enabled for Claude Code agents');
  }
  if (mockAuth) {
    console.log('[Cikada] Mock authentication enabled (direct login bypass)');
  } else if (useSanityOAuth || process.env.NODE_ENV === 'production') {
    console.log('[Cikada] Authentication: real Sanity OAuth');
  } else {
    console.log('[Cikada] Authentication: mock OAuth (use --sanity-auth for real Sanity)');
  }

  // Create storage
  const storage = createSqliteStorage({ path: dbPath });
  await storage.initialize();

  // Bootstrap system (create root channel, default focus areas, etc.)
  await bootstrap(storage);

  // Create and start server
  // Auth is always enabled (mock OAuth in dev, real Sanity in production)
  // --mock-auth bypasses OAuth for testing, --sanity-auth forces real Sanity in dev
  const server = createServer({ storage, port, enableSandbox, mockAuth, sanityAuth: true, useSanityOAuth });
  await server.start();

  // Handle shutdown
  process.on('SIGINT', async () => {
    console.log('\n[Cikada] Shutting down...');
    await server.stop();
    await storage.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    console.log('\n[Cikada] Shutting down...');
    await server.stop();
    await storage.close();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error('[Cikada] Fatal error:', err);
  process.exit(1);
});
