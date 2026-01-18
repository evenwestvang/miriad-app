/**
 * Miriad Cloud Provisioning Handler
 *
 * Manages the lifecycle of Miriad Cloud containers - one per space.
 * Containers run @miriad-systems/backend (local runtime) to serve multiple agents.
 *
 * Endpoints:
 * - POST /api/runtimes/miriad-cloud/start   - Start Miriad Cloud container
 * - POST /api/runtimes/miriad-cloud/stop    - Stop Miriad Cloud container
 * - GET  /api/runtimes/miriad-cloud/status  - Get current status
 */

import { Hono } from 'hono';
import { createHmac } from 'node:crypto';
import { ulid } from 'ulid';
import { execFileSync, execFile } from 'node:child_process';
import type { Storage } from '@cast/storage';
import { parseSession } from '../auth/index.js';

// =============================================================================
// Configuration
// =============================================================================

// Runtime name used for idempotency (one per space)
const MIRIAD_CLOUD_NAME = 'Miriad Cloud';

// Container image
const MIRIAD_CLOUD_IMAGE = process.env.MIRIAD_CLOUD_IMAGE || 'miriad-cloud:latest';

// Fly.io configuration
const FLY_API_TOKEN = process.env.FLY_API_TOKEN;
const FLY_APP_NAME = process.env.FLY_APP_NAME || 'miriad-cloud';
const FLY_REGION = process.env.FLY_REGION || 'iad';

// Docker configuration (local dev)
const USE_DOCKER = process.env.USE_DOCKER === 'true' || !FLY_API_TOKEN;

// Secret for generating server credentials (same as runtime-auth.ts)
const DEV_SECRET = 'cast-dev-server-secret-do-not-use-in-production';
const SERVER_SECRET = process.env.CAST_SERVER_SECRET ?? DEV_SECRET;

// API URLs for container config
const API_URL = process.env.CAST_API_URL || 'http://localhost:8080';
const WS_URL = process.env.CAST_WS_URL || API_URL.replace('http', 'ws');

// Anthropic API key to pass to containers
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// =============================================================================
// Types
// =============================================================================

export interface MiriadCloudOptions {
  storage: Storage;
}

interface MiriadConfig {
  spaceId: string;
  name: string;
  credentials: {
    runtimeId: string;
    serverId: string;
    secret: string;
    apiUrl: string;
    wsUrl: string;
  };
  workspace: {
    basePath: string;
  };
  createdAt: string;
}

// =============================================================================
// Helper Functions
// =============================================================================

function generateServerId(): string {
  return `srv_${ulid()}`;
}

function generateRuntimeId(): string {
  // Match local-runtime's format: rt_ + 23 char ULID fragment
  return `rt_${ulid().substring(0, 23)}`;
}

function generateServerSecret(serverId: string, spaceId: string): string {
  const data = `${serverId}:${spaceId}`;
  const hmac = createHmac('sha256', SERVER_SECRET).update(data).digest('base64url');
  return `sk_cast_${hmac}`;
}

function buildMiriadConfig(
  spaceId: string,
  runtimeId: string,
  serverId: string,
  secret: string
): MiriadConfig {
  return {
    spaceId,
    name: MIRIAD_CLOUD_NAME,
    credentials: {
      runtimeId,
      serverId,
      secret,
      apiUrl: API_URL,
      wsUrl: WS_URL,
    },
    workspace: {
      basePath: '/workspace',
    },
    createdAt: new Date().toISOString(),
  };
}

// =============================================================================
// Docker Container Management (Local Dev)
// =============================================================================

function getDockerContainerName(spaceId: string): string {
  return `miriad-cloud-${spaceId.substring(0, 12)}`;
}

async function startDockerContainer(
  spaceId: string,
  config: MiriadConfig
): Promise<{ containerId: string }> {
  const containerName = getDockerContainerName(spaceId);

  // Check if container already exists
  try {
    const existing = execFileSync('docker', ['ps', '-aq', '-f', `name=${containerName}`], {
      encoding: 'utf-8',
    }).trim();

    if (existing) {
      // Container exists - check if running
      const running = execFileSync('docker', ['ps', '-q', '-f', `name=${containerName}`], {
        encoding: 'utf-8',
      }).trim();

      if (running) {
        console.log(`[MiriadCloud] Container ${containerName} already running`);
        return { containerId: running };
      }

      // Container exists but stopped - remove it
      console.log(`[MiriadCloud] Removing stopped container ${containerName}`);
      execFileSync('docker', ['rm', containerName]);
    }
  } catch {
    // Container doesn't exist, continue to create
  }

  // For local dev, we need to use host.docker.internal for API access
  const localApiUrl = API_URL.replace('localhost', 'host.docker.internal');
  const localWsUrl = WS_URL.replace('localhost', 'host.docker.internal');
  const localConfig = {
    ...config,
    credentials: {
      ...config.credentials,
      apiUrl: localApiUrl,
      wsUrl: localWsUrl,
    },
  };

  const args = [
    'run',
    '-d',
    '--rm',
    '--name', containerName,
    '-e', `MIRIAD_CONFIG=${JSON.stringify(localConfig)}`,
    '-e', `ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}`,
    '-v', `miriad-workspace-${spaceId}:/workspace`,
    MIRIAD_CLOUD_IMAGE,
  ];

  console.log(`[MiriadCloud] Starting Docker container: ${containerName}`);
  const containerId = execFileSync('docker', args, { encoding: 'utf-8' }).trim().substring(0, 12);

  return { containerId };
}

async function stopDockerContainer(spaceId: string): Promise<void> {
  const containerName = getDockerContainerName(spaceId);

  try {
    execFileSync('docker', ['stop', containerName], { encoding: 'utf-8' });
    console.log(`[MiriadCloud] Stopped container ${containerName}`);
  } catch {
    // Container not running or doesn't exist
    console.log(`[MiriadCloud] Container ${containerName} not running`);
  }
}

function getDockerContainerStatus(spaceId: string): 'running' | 'stopped' | 'not_found' {
  const containerName = getDockerContainerName(spaceId);

  try {
    const running = execFileSync('docker', ['ps', '-q', '-f', `name=${containerName}`], {
      encoding: 'utf-8',
    }).trim();

    if (running) {
      return 'running';
    }

    const exists = execFileSync('docker', ['ps', '-aq', '-f', `name=${containerName}`], {
      encoding: 'utf-8',
    }).trim();

    return exists ? 'stopped' : 'not_found';
  } catch {
    return 'not_found';
  }
}

// =============================================================================
// Fly.io Machine Management (Production)
// =============================================================================

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
}

async function flyRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const baseUrl = `https://api.machines.dev/v1/apps/${FLY_APP_NAME}`;
  const url = `${baseUrl}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${FLY_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Fly API error ${response.status}: ${text}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json() as Promise<T>;
}

function getFlyMachineName(spaceId: string): string {
  return `miriad-cloud-${spaceId.substring(0, 12)}`;
}

async function findFlyMachine(spaceId: string): Promise<FlyMachine | null> {
  const machineName = getFlyMachineName(spaceId);
  const machines = await flyRequest<FlyMachine[]>('GET', '/machines');
  return machines.find((m) => m.name === machineName) ?? null;
}

async function startFlyMachine(
  spaceId: string,
  config: MiriadConfig
): Promise<{ machineId: string }> {
  const machineName = getFlyMachineName(spaceId);

  // Check if machine already exists
  const existing = await findFlyMachine(spaceId);

  if (existing) {
    if (existing.state === 'started') {
      console.log(`[MiriadCloud] Fly machine ${machineName} already running`);
      return { machineId: existing.id };
    }

    // Machine exists but stopped - start it
    console.log(`[MiriadCloud] Starting existing Fly machine ${machineName}`);
    await flyRequest('POST', `/machines/${existing.id}/start`);
    return { machineId: existing.id };
  }

  // Create new machine
  console.log(`[MiriadCloud] Creating Fly machine ${machineName}`);

  const machine = await flyRequest<FlyMachine>('POST', '/machines', {
    name: machineName,
    region: FLY_REGION,
    config: {
      image: MIRIAD_CLOUD_IMAGE,
      env: {
        MIRIAD_CONFIG: JSON.stringify(config),
        ANTHROPIC_API_KEY: ANTHROPIC_API_KEY,
      },
      guest: {
        cpu_kind: 'shared',
        cpus: 2,
        memory_mb: 4096,
      },
      restart: {
        policy: 'no',
      },
      auto_destroy: true,
    },
  });

  return { machineId: machine.id };
}

async function stopFlyMachine(spaceId: string): Promise<void> {
  const existing = await findFlyMachine(spaceId);

  if (!existing) {
    console.log(`[MiriadCloud] No Fly machine found for space ${spaceId}`);
    return;
  }

  if (existing.state !== 'started') {
    console.log(`[MiriadCloud] Fly machine ${existing.name} not running (state: ${existing.state})`);
    return;
  }

  console.log(`[MiriadCloud] Stopping Fly machine ${existing.name}`);
  await flyRequest('POST', `/machines/${existing.id}/stop`);
}

async function getFlyMachineStatus(spaceId: string): Promise<'running' | 'stopped' | 'not_found'> {
  const machine = await findFlyMachine(spaceId);

  if (!machine) {
    return 'not_found';
  }

  return machine.state === 'started' ? 'running' : 'stopped';
}

// =============================================================================
// Route Factory
// =============================================================================

export function createMiriadCloudRoutes(options: MiriadCloudOptions): Hono {
  const { storage } = options;
  const app = new Hono();

  // ---------------------------------------------------------------------------
  // POST /start - Start Miriad Cloud container
  // ---------------------------------------------------------------------------
  app.post('/start', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const { userId, spaceId } = session;

    if (!ANTHROPIC_API_KEY) {
      return c.json({ error: 'ANTHROPIC_API_KEY not configured on server' }, 500);
    }

    try {
      // Check if runtime already exists for this space
      let runtime = await storage.getRuntimeByName(spaceId, MIRIAD_CLOUD_NAME);

      if (runtime && runtime.status === 'online') {
        // Already running
        return c.json({
          status: 'already_running',
          runtime: {
            id: runtime.id,
            name: runtime.name,
            status: runtime.status,
          },
        });
      }

      // Generate credentials
      const serverId = generateServerId();
      const runtimeId = generateRuntimeId();
      const secret = generateServerSecret(serverId, spaceId);

      // Store server credentials
      await storage.saveLocalAgentServer({
        serverId,
        spaceId,
        userId,
        secret,
      });

      // Build config for container
      const config = buildMiriadConfig(spaceId, runtimeId, serverId, secret);

      // Create or update runtime record
      // Status starts as 'offline' - will become 'online' when container connects via WS
      const runtimeConfig = {
        wsConnectionId: null,
        machineInfo: { os: 'linux', hostname: 'miriad-cloud' },
      };

      if (runtime) {
        // Runtime exists but offline - update it with new credentials
        await storage.updateRuntime(runtime.id, {
          status: 'offline',
          config: runtimeConfig,
        });
      } else {
        // Create new runtime record
        runtime = await storage.createRuntime({
          spaceId,
          serverId,
          name: MIRIAD_CLOUD_NAME,
          type: 'local',
          status: 'offline',
          config: runtimeConfig,
        });
      }

      // Start container (Docker or Fly)
      if (USE_DOCKER) {
        await startDockerContainer(spaceId, config);
      } else {
        await startFlyMachine(spaceId, config);
      }

      console.log(`[MiriadCloud] Started for space ${spaceId}, runtime ${runtime.id}`);

      // Note: status is 'starting' in response to indicate container is spinning up
      // It will become 'online' when the container connects via WebSocket
      return c.json({
        status: 'starting',
        runtime: {
          id: runtime.id,
          name: runtime.name,
          status: 'offline',
        },
      }, 201);
    } catch (error) {
      console.error('[MiriadCloud] Error starting:', error);
      return c.json({ error: 'Failed to start Miriad Cloud' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // POST /stop - Stop Miriad Cloud container
  // ---------------------------------------------------------------------------
  app.post('/stop', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const { spaceId } = session;

    try {
      // Stop container
      if (USE_DOCKER) {
        await stopDockerContainer(spaceId);
      } else {
        await stopFlyMachine(spaceId);
      }

      // Update runtime status
      const runtime = await storage.getRuntimeByName(spaceId, MIRIAD_CLOUD_NAME);
      if (runtime) {
        await storage.updateRuntime(runtime.id, { status: 'offline' });
      }

      console.log(`[MiriadCloud] Stopped for space ${spaceId}`);

      return c.json({ status: 'stopped' });
    } catch (error) {
      console.error('[MiriadCloud] Error stopping:', error);
      return c.json({ error: 'Failed to stop Miriad Cloud' }, 500);
    }
  });

  // ---------------------------------------------------------------------------
  // GET /status - Get Miriad Cloud status
  // ---------------------------------------------------------------------------
  app.get('/status', async (c) => {
    const session = await parseSession(c);
    if (!session) {
      return c.json({ error: 'Authentication required' }, 401);
    }

    const { spaceId } = session;

    try {
      // Get runtime record
      const runtime = await storage.getRuntimeByName(spaceId, MIRIAD_CLOUD_NAME);

      // Get container status
      let containerStatus: 'running' | 'stopped' | 'not_found';
      if (USE_DOCKER) {
        containerStatus = getDockerContainerStatus(spaceId);
      } else {
        containerStatus = await getFlyMachineStatus(spaceId);
      }

      return c.json({
        available: true,
        runtime: runtime
          ? {
              id: runtime.id,
              name: runtime.name,
              status: runtime.status,
              lastSeenAt: runtime.lastSeenAt,
            }
          : null,
        container: {
          status: containerStatus,
          provider: USE_DOCKER ? 'docker' : 'fly',
        },
      });
    } catch (error) {
      console.error('[MiriadCloud] Error getting status:', error);
      return c.json({ error: 'Failed to get status' }, 500);
    }
  });

  return app;
}
