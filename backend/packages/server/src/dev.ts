/**
 * Local development server
 *
 * Run with: pnpm dev
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env from backend root (two levels up from packages/server/src)
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '../../../.env');
console.log(`[dev] Loading .env from: ${envPath}`);
const result = config({ path: envPath });
if (result.error) {
  console.log(`[dev] .env load error: ${result.error.message}`);
} else {
  console.log(`[dev] .env loaded successfully`);
}

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { createConnectionManager } from './websocket/index.js';
import { createPostgresStorage } from '@cast/storage';
import { DockerOrchestrator } from '@cast/runtime';

// =============================================================================
// Configuration
// =============================================================================

const port = parseInt(process.env.PORT ?? '3001', 10);
const spaceId = process.env.SPACE_ID ?? 'default-space';

// Database connection
const connectionString =
  process.env.PLANETSCALE_URL ??
  process.env.DATABASE_URL ??
  (() => {
    // Default local dev connection (PlanetScale)
    const host = 'us-east-2.pg.psdb.cloud';
    const port = '6432';
    const user = process.env.PS_USER ?? '';
    const pass = process.env.PS_PASS ?? '';
    const db = 'postgres';
    if (!user || !pass) {
      console.warn('⚠️  No database credentials found. Set PLANETSCALE_URL or PS_USER/PS_PASS');
      return '';
    }
    return `postgres://${user}:${pass}@${host}:${port}/${db}`;
  })();

// =============================================================================
// Main
// =============================================================================

async function main() {
  console.log(`Starting Cast backend on http://localhost:${port}`);

  // ---------------------------------------------------------------------------
  // Initialize Storage
  // ---------------------------------------------------------------------------

  if (!connectionString) {
    console.error('❌ No database connection string. Set PLANETSCALE_URL environment variable.');
    process.exit(1);
  }

  const storage = createPostgresStorage({ connectionString });
  await storage.initialize();
  console.log('✅ Storage initialized');

  // ---------------------------------------------------------------------------
  // Initialize WebSocket Connection Manager
  // ---------------------------------------------------------------------------

  const connectionManager = createConnectionManager();
  console.log('✅ Connection manager initialized');

  // ---------------------------------------------------------------------------
  // Initialize Container Orchestrator (Docker for local dev)
  // ---------------------------------------------------------------------------

  const orchestrator = new DockerOrchestrator({
    imageName: process.env.AGENT_IMAGE ?? 'claude-code:local',
    castApiUrl: process.env.CAST_API_URL ?? `http://host.docker.internal:${port}`,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
  });
  console.log('✅ Docker orchestrator initialized');

  // ---------------------------------------------------------------------------
  // Create App
  // ---------------------------------------------------------------------------

  const app = createApp({
    storage,
    orchestrator,
    connectionManager,
    spaceId,
  });

  // ---------------------------------------------------------------------------
  // Start Server
  // ---------------------------------------------------------------------------

  serve({
    fetch: app.fetch,
    port,
  });

  console.log(`✅ Server running at http://localhost:${port}`);
  console.log(`   Health check: http://localhost:${port}/health`);
  console.log(`   Space ID: ${spaceId}`);

  // ---------------------------------------------------------------------------
  // Graceful Shutdown
  // ---------------------------------------------------------------------------

  const shutdown = async () => {
    console.log('\n🛑 Shutting down...');
    await storage.close();
    console.log('✅ Storage closed');
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});
