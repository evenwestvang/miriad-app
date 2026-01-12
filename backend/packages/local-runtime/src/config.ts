/**
 * Configuration Module
 *
 * Handles reading/writing runtime config from ~/.config/cast/local-runtime.json
 * and API interactions for bootstrap exchange.
 */

import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { homedir, hostname, platform } from 'node:os';
import { dirname, join } from 'node:path';
import type { RuntimeConfig, BootstrapResponse, ParsedConnectionString } from './types.js';

// =============================================================================
// Configuration Paths
// =============================================================================

const CONFIG_DIR = join(homedir(), '.config', 'cast');
const CONFIG_FILE = join(CONFIG_DIR, 'local-runtime.json');
const DEFAULT_WORKSPACE_BASE = '/tmp/cast-agents';

// =============================================================================
// Environment Detection
// =============================================================================

type Environment = 'local' | 'staging' | 'production';

interface EnvironmentConfig {
  apiProtocol: 'http' | 'https';
  wsProtocol: 'ws' | 'wss';
}

function detectEnvironment(host: string): Environment {
  const hostLower = host.toLowerCase();

  if (hostLower.includes('localhost') || hostLower.startsWith('127.')) {
    return 'local';
  }
  if (hostLower.includes('staging')) {
    return 'staging';
  }
  return 'production';
}

function getEnvironmentConfig(env: Environment): EnvironmentConfig {
  switch (env) {
    case 'local':
      return { apiProtocol: 'http', wsProtocol: 'ws' };
    case 'staging':
    case 'production':
    default:
      return { apiProtocol: 'https', wsProtocol: 'wss' };
  }
}

export function getApiProtocol(host: string): 'http' | 'https' {
  return getEnvironmentConfig(detectEnvironment(host)).apiProtocol;
}

export function getWsProtocol(host: string): 'ws' | 'wss' {
  return getEnvironmentConfig(detectEnvironment(host)).wsProtocol;
}

// =============================================================================
// Connection String Parsing
// =============================================================================

/**
 * Parse a CAST connection string.
 * Format: cast://<token>@<host>/<spaceId>
 * Example: cast://bst_abc123@api.cast.dev/space_xyz
 */
export function parseConnectionString(connectionString: string): ParsedConnectionString {
  const match = connectionString.match(/^cast:\/\/([^@]+)@([^/]+)\/(.+)$/);

  if (!match) {
    throw new Error(
      `Invalid connection string format. Expected: cast://<token>@<host>/<spaceId>`
    );
  }

  const [, bootstrapToken, host, spaceId] = match;
  return { host, bootstrapToken, spaceId };
}

// =============================================================================
// Config Storage
// =============================================================================

/**
 * Load runtime config from disk.
 * Returns null if no config file exists.
 */
export async function loadConfig(): Promise<RuntimeConfig | null> {
  try {
    const content = await readFile(CONFIG_FILE, 'utf-8');
    return JSON.parse(content) as RuntimeConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * Save runtime config to disk.
 */
export async function saveConfig(config: RuntimeConfig): Promise<void> {
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });
}

/**
 * Delete stored config.
 */
export async function deleteConfig(): Promise<void> {
  try {
    await unlink(CONFIG_FILE);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Get config file path (for display).
 */
export function getConfigPath(): string {
  return CONFIG_FILE;
}

// =============================================================================
// ULID Generation
// =============================================================================

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function generateId(): string {
  const now = Date.now();

  // Encode timestamp (48 bits -> 10 chars)
  let timestamp = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    timestamp = ENCODING[t % 32] + timestamp;
    t = Math.floor(t / 32);
  }

  // Generate randomness (80 bits -> 16 chars)
  let random = '';
  for (let i = 0; i < 16; i++) {
    random += ENCODING[Math.floor(Math.random() * 32)];
  }

  return timestamp + random;
}

/**
 * Generate a runtime ID (rt_ prefix).
 * Total length must be <= 26 chars to fit VARCHAR(26) column.
 * Format: rt_ (3 chars) + 10 char timestamp + 13 char random = 26 chars
 */
export function generateRuntimeId(): string {
  const now = Date.now();

  // Encode timestamp (48 bits -> 10 chars)
  let timestamp = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    timestamp = ENCODING[t % 32] + timestamp;
    t = Math.floor(t / 32);
  }

  // Generate randomness (52 bits -> 13 chars, to fit in 26 total)
  let random = '';
  for (let i = 0; i < 13; i++) {
    random += ENCODING[Math.floor(Math.random() * 32)];
  }

  return `rt_${timestamp}${random}`;
}

// =============================================================================
// API Interactions
// =============================================================================

/**
 * Exchange a bootstrap token for server credentials.
 */
export async function exchangeBootstrapToken(
  host: string,
  bootstrapToken: string
): Promise<BootstrapResponse> {
  const protocol = getApiProtocol(host);
  const url = `${protocol}://${host}/api/runtimes/auth/bootstrap`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bootstrapToken }),
  });

  if (!response.ok) {
    if (response.status === 400) {
      throw new Error('Invalid bootstrap token format.');
    }
    if (response.status === 401) {
      throw new Error('Bootstrap token is invalid or expired.');
    }
    if (response.status === 409) {
      throw new Error('Bootstrap token has already been used.');
    }
    throw new Error(`Bootstrap exchange failed: ${response.statusText}`);
  }

  return (await response.json()) as BootstrapResponse;
}

// =============================================================================
// Auth Flow
// =============================================================================

/**
 * Initialize runtime config from a connection string.
 * Parses the string, exchanges the bootstrap token, generates runtimeId,
 * and saves config.
 */
export async function initFromConnectionString(
  connectionString: string,
  runtimeName?: string
): Promise<RuntimeConfig> {
  const parsed = parseConnectionString(connectionString);

  console.log(`Connecting to ${parsed.host}...`);

  // Exchange bootstrap token for credentials
  const response = await exchangeBootstrapToken(parsed.host, parsed.bootstrapToken);

  // Generate stable runtime ID
  const runtimeId = generateRuntimeId();

  // Determine runtime name
  const name = runtimeName ?? hostname();

  // Build API and WS URLs
  const apiProtocol = getApiProtocol(response.host);
  const wsProtocol = getWsProtocol(response.wsHost);

  const config: RuntimeConfig = {
    spaceId: response.spaceId,
    name,
    credentials: {
      runtimeId,
      serverId: response.serverId,
      secret: response.secret,
      apiUrl: `${apiProtocol}://${response.host}`,
      wsUrl: `${wsProtocol}://${response.wsHost}`,
    },
    workspace: {
      basePath: DEFAULT_WORKSPACE_BASE,
    },
    createdAt: new Date().toISOString(),
  };

  await saveConfig(config);

  console.log(`Config saved to ${CONFIG_FILE}`);
  console.log(`Runtime ID: ${config.credentials.runtimeId}`);
  console.log(`Runtime name: ${config.name}`);
  console.log(`Space: ${config.spaceId}`);

  return config;
}

// =============================================================================
// Machine Info
// =============================================================================

export function getMachineInfo(): { os: string; hostname: string } {
  return {
    os: platform(),
    hostname: hostname(),
  };
}
