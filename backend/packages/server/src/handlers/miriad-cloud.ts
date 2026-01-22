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

// =============================================================================
// Config getters - read env vars at runtime, not module load time
// This is critical because dotenv may not have loaded when this module is imported
// =============================================================================

function getRuntimeMode(): 'docker' | 'fly' {
  const mode = process.env.MIRIAD_RUNTIME_MODE;
  if (!mode) {
    throw new Error('MIRIAD_RUNTIME_MODE must be set to "docker" or "fly"');
  }
  if (mode !== 'docker' && mode !== 'fly') {
    throw new Error(`MIRIAD_RUNTIME_MODE must be "docker" or "fly", got "${mode}"`);
  }
  return mode;
}

function getFlyApiToken(): string {
  const token = process.env.FLY_API_TOKEN;
  if (!token) throw new Error('FLY_API_TOKEN is required when MIRIAD_RUNTIME_MODE=fly');
  return token;
}

function getFlyAppName(): string {
  const name = process.env.FLY_APP_NAME;
  if (!name) throw new Error('FLY_APP_NAME is required when MIRIAD_RUNTIME_MODE=fly');
  return name;
}

function getFlyRegion(): string {
  const region = process.env.FLY_REGION;
  if (!region) throw new Error('FLY_REGION is required when MIRIAD_RUNTIME_MODE=fly');
  return region;
}

function getFlyImage(): string {
  const image = process.env.FLY_IMAGE;
  if (!image) throw new Error('FLY_IMAGE is required when MIRIAD_RUNTIME_MODE=fly');
  return image;
}

function getDockerImage(): string {
  const image = process.env.MIRIAD_CLOUD_IMAGE;
  if (!image) throw new Error('MIRIAD_CLOUD_IMAGE is required when MIRIAD_RUNTIME_MODE=docker');
  return image;
}

function useDocker(): boolean {
  return getRuntimeMode() === 'docker';
}

function validateConfig(): void {
  const mode = getRuntimeMode();
  if (mode === 'fly') {
    getFlyApiToken();
    getFlyAppName();
    getFlyRegion();
    getFlyImage();
  }
  if (mode === 'docker') {
    getDockerImage();
  }
}

// Secret for generating server credentials (same as runtime-auth.ts)
const DEV_SECRET = 'cast-dev-server-secret-do-not-use-in-production';

// Helper functions to read env vars at runtime (not module load time)
// This is important because dotenv may not have loaded yet when this module is imported
function getServerSecret(): string {
  return process.env.CAST_SERVER_SECRET ?? DEV_SECRET;
}

function getApiUrl(): string {
  const url = process.env.CAST_API_URL;
  if (!url) {
    throw new Error('CAST_API_URL environment variable is required');
  }
  return url;
}

function getWsUrl(): string {
  const apiUrl = getApiUrl();
  return process.env.CAST_WS_URL || apiUrl.replace('http', 'ws');
}

function getTunnelServerUrl(): string | undefined {
  return process.env.TUNNEL_SERVER_URL;
}

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

function generateServerSecretHmac(serverId: string, spaceId: string): string {
  const data = `${serverId}:${spaceId}`;
  const hmac = createHmac('sha256', getServerSecret()).update(data).digest('base64url');
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
      apiUrl: getApiUrl(),
      wsUrl: getWsUrl(),
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
  config: MiriadConfig,
  anthropicApiKey: string,
  githubToken: string | null
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
  const apiUrl = getApiUrl();
  const wsUrl = getWsUrl();
  const localApiUrl = apiUrl.replace('localhost', 'host.docker.internal');
  const localWsUrl = wsUrl.replace('localhost', 'host.docker.internal');
  const localConfig = {
    ...config,
    credentials: {
      ...config.credentials,
      apiUrl: localApiUrl,
      wsUrl: localWsUrl,
    },
  };

  const tunnelServerUrl = getTunnelServerUrl();
  const args = [
    'run',
    '-d',
    '--rm',
    '--name', containerName,
    '-e', `MIRIAD_CONFIG=${JSON.stringify(localConfig)}`,
    '-e', `ANTHROPIC_API_KEY=${anthropicApiKey}`,
    ...(tunnelServerUrl ? ['-e', `TUNNEL_SERVER_URL=${tunnelServerUrl}`] : []),
    ...(githubToken ? ['-e', `GITHUB_TOKEN=${githubToken}`] : []),
    '-v', `miriad-workspace-${spaceId}:/workspace`,
    getDockerImage(),
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

interface FlyVolume {
  id: string;
  name: string;
  state: string;
  region: string;
  size_gb: number;
}

async function flyRequest<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const baseUrl = `https://api.machines.dev/v1/apps/${getFlyAppName()}`;
  const url = `${baseUrl}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${getFlyApiToken()}`,
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

function getFlyVolumeName(spaceId: string): string {
  // Fly volume names: lowercase alphanumeric and underscores only, max 30 chars
  return `miriad_ws_${spaceId.substring(0, 12).toLowerCase()}`;
}

// Volume size in GB for agent workspaces
const FLY_VOLUME_SIZE_GB = 10;

/**
 * Get an existing volume by ID, or null if not found/destroyed.
 */
async function getFlyVolume(volumeId: string): Promise<FlyVolume | null> {
  try {
    return await flyRequest<FlyVolume>('GET', `/volumes/${volumeId}`);
  } catch (error) {
    // Volume may have been destroyed
    if (error instanceof Error && error.message.includes('404')) {
      return null;
    }
    throw error;
  }
}

/**
 * Find a volume by name in the specified region.
 */
async function findFlyVolumeByName(name: string, region: string): Promise<FlyVolume | null> {
  const volumes = await flyRequest<FlyVolume[]>('GET', '/volumes');
  return volumes.find((v) => v.name === name && v.region === region) ?? null;
}

/**
 * Create a new Fly volume for the space's workspace.
 */
async function createFlyVolume(spaceId: string): Promise<FlyVolume> {
  const volumeName = getFlyVolumeName(spaceId);
  const region = getFlyRegion();

  console.log(`[MiriadCloud] Creating Fly volume ${volumeName} in ${region}`);

  return await flyRequest<FlyVolume>('POST', '/volumes', {
    name: volumeName,
    region,
    size_gb: FLY_VOLUME_SIZE_GB,
    encrypted: true,
  });
}

/**
 * Ensure a volume exists for the space, creating one if needed.
 * Returns the volume ID to use for machine mounting.
 */
async function ensureFlyVolume(spaceId: string, existingVolumeId?: string): Promise<string> {
  // If we have a stored volume ID, verify it still exists
  if (existingVolumeId) {
    const volume = await getFlyVolume(existingVolumeId);
    if (volume) {
      console.log(`[MiriadCloud] Using existing volume ${existingVolumeId}`);
      return existingVolumeId;
    }
    console.log(`[MiriadCloud] Stored volume ${existingVolumeId} not found, will create new`);
  }

  // Check if a volume with our naming convention already exists (recovery case)
  const volumeName = getFlyVolumeName(spaceId);
  const region = getFlyRegion();
  const existingByName = await findFlyVolumeByName(volumeName, region);
  if (existingByName) {
    console.log(`[MiriadCloud] Found existing volume by name: ${existingByName.id}`);
    return existingByName.id;
  }

  // Create new volume
  const volume = await createFlyVolume(spaceId);
  return volume.id;
}

async function findFlyMachine(spaceId: string): Promise<FlyMachine | null> {
  const machineName = getFlyMachineName(spaceId);
  const machines = await flyRequest<FlyMachine[]>('GET', '/machines');
  return machines.find((m) => m.name === machineName) ?? null;
}

async function startFlyMachine(
  spaceId: string,
  config: MiriadConfig,
  volumeId: string,
  anthropicApiKey: string,
  githubToken: string | null
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

  // Create new machine with volume mounted
  console.log(`[MiriadCloud] Creating Fly machine ${machineName} with volume ${volumeId}`);

  const machine = await flyRequest<FlyMachine>('POST', '/machines', {
    name: machineName,
    region: getFlyRegion(),
    config: {
      image: getFlyImage(),
      env: {
        MIRIAD_CONFIG: JSON.stringify(config),
        ANTHROPIC_API_KEY: anthropicApiKey,
        TUNNEL_SERVER_URL: getTunnelServerUrl() ?? '',
        ...(githubToken ? { GITHUB_TOKEN: githubToken } : {}),
      },
      mounts: [{
        volume: volumeId,
        path: '/workspace',
      }],
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
  // Validate config at route creation time (app startup)
  validateConfig();

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

    try {
      // Fetch secrets from space settings
      const anthropicApiKey = await storage.getSpaceSecretValue(spaceId, 'anthropic_api_key');
      const githubToken = await storage.getSpaceSecretValue(spaceId, 'github_token');

      if (!anthropicApiKey) {
        return c.json({ error: 'Claude API key not configured. Please set it in Settings → Cloud.' }, 400);
      }
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
      const secret = generateServerSecretHmac(serverId, spaceId);

      // Store server credentials
      await storage.saveLocalAgentServer({
        serverId,
        spaceId,
        userId,
        secret,
      });

      // Build config for container
      const config = buildMiriadConfig(spaceId, runtimeId, serverId, secret);

      // For Fly deployments, ensure we have a persistent volume
      // TODO: Race condition - concurrent /start requests for same space could create
      // duplicate volumes. Fix: use SELECT FOR UPDATE on runtime record before this block.
      // Low priority since concurrent starts for same space are rare in practice.
      let flyVolumeId: string | undefined;
      if (!useDocker()) {
        const existingVolumeId = runtime?.config?.flyVolumeId;
        flyVolumeId = await ensureFlyVolume(spaceId, existingVolumeId);
      }

      // Create or update runtime record
      // Status starts as 'offline' - will become 'online' when container connects via WS
      const runtimeConfig = {
        wsConnectionId: null,
        machineInfo: { os: 'linux', hostname: 'miriad-cloud' },
        flyVolumeId,
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
      if (useDocker()) {
        await startDockerContainer(spaceId, config, anthropicApiKey, githubToken);
      } else {
        await startFlyMachine(spaceId, config, flyVolumeId!, anthropicApiKey, githubToken);
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
      if (useDocker()) {
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
      if (useDocker()) {
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
          provider: useDocker() ? 'docker' : 'fly',
        },
      });
    } catch (error) {
      console.error('[MiriadCloud] Error getting status:', error);
      return c.json({ error: 'Failed to get status' }, 500);
    }
  });

  return app;
}
