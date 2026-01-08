/**
 * Rathole Config Management
 *
 * Manages the rathole server configuration file for dynamic client registration.
 * Uses hot-reload: rathole automatically picks up config changes without restart.
 *
 * Config format (TOML):
 * ```
 * [server]
 * bind_addr = "0.0.0.0:2333"
 * heartbeat_interval = 30
 *
 * [server.services.{hash}]
 * token = "{token}"
 * bind_addr = "0.0.0.0:{port}"
 * ```
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// =============================================================================
// Types (defined early for use in module-level variables)
// =============================================================================

export interface ServiceOwner {
  spaceId: string;
  channelId: string;
  callsign: string;
}

// =============================================================================
// Configuration
// =============================================================================

const CONFIG_DIR = process.env.RATHOLE_CONFIG_DIR || '/etc/rathole';
const CONFIG_FILE = join(CONFIG_DIR, 'server.toml');
const CONTROL_PORT = process.env.RATHOLE_CONTROL_PORT || '2333';

// Base port for dynamic service allocation
// Each new service gets the next available port starting from this
const BASE_SERVICE_PORT = parseInt(process.env.BASE_SERVICE_PORT || '10000', 10);

// In-memory owner registry (not persisted to TOML - rathole doesn't need it)
// Lost on restart, but containers will re-register and reclaim ownership
const serviceOwners = new Map<string, ServiceOwner>();

// Multi-service limits
const MAX_SERVICE_NAME_LENGTH = 20;
const MAX_SERVICES_PER_HASH = 10;

// Track service count per hash for limit enforcement
const servicesPerHash = new Map<string, Set<string>>();

/**
 * Build service ID from hash and optional service name.
 * Format: {serviceName}-{hash} or just {hash} for default service.
 */
export function buildServiceId(hash: string, serviceName?: string): string {
  if (serviceName) {
    return `${serviceName}-${hash}`;
  }
  return hash;
}

/**
 * Validate service name.
 * Must be alphanumeric lowercase, max 20 chars.
 */
export function validateServiceName(serviceName?: string): { valid: boolean; error?: string } {
  if (!serviceName) {
    return { valid: true };  // Empty is OK (default service)
  }

  if (serviceName.length > MAX_SERVICE_NAME_LENGTH) {
    return { valid: false, error: `Service name too long (max ${MAX_SERVICE_NAME_LENGTH} chars)` };
  }

  if (!/^[a-z0-9]+$/.test(serviceName)) {
    return { valid: false, error: 'Service name must be alphanumeric lowercase' };
  }

  return { valid: true };
}

// =============================================================================
// Types (continued)
// =============================================================================

export interface ServiceEntry {
  serviceId: string;      // Composite ID: {serviceName}-{hash} or just {hash}
  hash: string;           // Container's tunnel hash
  serviceName?: string;   // Optional service name for multi-map
  token: string;
  port: number;
  owner?: ServiceOwner;   // Who registered this service (for auth on DELETE)
}

export interface RatholeConfig {
  controlPort: string;
  heartbeatInterval: number;
  services: Map<string, ServiceEntry>;
}

// =============================================================================
// Config Management
// =============================================================================

/**
 * Parse existing rathole config file.
 * Returns empty config if file doesn't exist.
 */
export function loadConfig(): RatholeConfig {
  const config: RatholeConfig = {
    controlPort: CONTROL_PORT,
    heartbeatInterval: 30,
    services: new Map(),
  };

  if (!existsSync(CONFIG_FILE)) {
    return config;
  }

  try {
    const content = readFileSync(CONFIG_FILE, 'utf-8');
    // Simple TOML parsing for our known format
    // For production, consider using a proper TOML library

    const lines = content.split('\n');
    let currentService: string | null = null;
    let currentEntry: Partial<ServiceEntry> = {};

    for (const line of lines) {
      const trimmed = line.trim();

      // Parse [server.services.{serviceId}]
      // serviceId is either {serviceName}-{hash} or just {hash}
      const serviceMatch = trimmed.match(/^\[server\.services\.([^\]]+)\]$/);
      if (serviceMatch) {
        // Save previous service if any
        if (currentService && currentEntry.token && currentEntry.port) {
          config.services.set(currentService, {
            serviceId: currentService,
            hash: currentEntry.hash || currentService,
            serviceName: currentEntry.serviceName,
            token: currentEntry.token,
            port: currentEntry.port,
          });
        }
        currentService = serviceMatch[1];
        // Parse serviceId to extract hash and optional serviceName
        // Format: {serviceName}-{hash} where hash is 32+ hex chars
        const idMatch = currentService.match(/^(?:([a-z0-9]+)-)?([a-f0-9]{32,})$/);
        if (idMatch) {
          currentEntry = {
            serviceId: currentService,
            serviceName: idMatch[1] || undefined,
            hash: idMatch[2],
          };
        } else {
          // Fallback for placeholder or legacy entries
          currentEntry = { serviceId: currentService, hash: currentService };
        }
        continue;
      }

      // Parse token = "..."
      const tokenMatch = trimmed.match(/^token\s*=\s*"([^"]+)"$/);
      if (tokenMatch && currentService) {
        currentEntry.token = tokenMatch[1];
        continue;
      }

      // Parse bind_addr = "0.0.0.0:{port}"
      const bindMatch = trimmed.match(/^bind_addr\s*=\s*"0\.0\.0\.0:(\d+)"$/);
      if (bindMatch && currentService) {
        currentEntry.port = parseInt(bindMatch[1], 10);
        continue;
      }
    }

    // Save last service
    if (currentService && currentEntry.token && currentEntry.port) {
      config.services.set(currentService, {
        serviceId: currentService,
        hash: currentEntry.hash || currentService,
        serviceName: currentEntry.serviceName,
        token: currentEntry.token,
        port: currentEntry.port,
      });
    }
  } catch (error) {
    console.error('[Config] Failed to parse config file:', error);
  }

  return config;
}

/**
 * Write rathole config to file.
 * rathole will automatically pick up changes via hot-reload.
 */
export function saveConfig(config: RatholeConfig): void {
  const lines: string[] = [
    '# Rathole Server Configuration',
    '# Auto-generated by cast-tunnel-server',
    '# Changes are hot-reloaded automatically',
    '',
    '[server]',
    `bind_addr = "0.0.0.0:${config.controlPort}"`,
    `heartbeat_interval = ${config.heartbeatInterval}`,
    '',
  ];

  // Add service entries
  for (const [serviceId, service] of config.services) {
    lines.push(`[server.services.${serviceId}]`);
    lines.push(`token = "${service.token}"`);
    lines.push(`bind_addr = "0.0.0.0:${service.port}"`);
    lines.push('');
  }

  writeFileSync(CONFIG_FILE, lines.join('\n'), 'utf-8');
  console.log(`[Config] Saved config with ${config.services.size} services`);
}

/**
 * Register a new tunnel client.
 * Assigns a port and adds to config file.
 *
 * @param hash - Container's tunnel hash
 * @param token - Auth token for this service
 * @param owner - Identity of the container registering (for auth on DELETE)
 * @param serviceName - Optional service name for multi-map (e.g., "web", "api")
 * @returns The assigned service entry or error
 */
export function registerService(
  hash: string,
  token: string,
  owner: ServiceOwner,
  serviceName?: string
): ServiceEntry | { error: string } {
  // Validate service name
  const validation = validateServiceName(serviceName);
  if (!validation.valid) {
    return { error: validation.error! };
  }

  const config = loadConfig();
  const serviceId = buildServiceId(hash, serviceName);

  // Check if already registered
  const existing = config.services.get(serviceId);
  if (existing) {
    console.log(`[Config] Service ${serviceId} already registered on port ${existing.port}`);
    // Update owner in case container restarted with same hash
    serviceOwners.set(serviceId, owner);
    return existing;
  }

  // Check service limit per hash
  const hashServices = servicesPerHash.get(hash) || new Set<string>();
  if (hashServices.size >= MAX_SERVICES_PER_HASH) {
    return { error: `Maximum services per container reached (${MAX_SERVICES_PER_HASH})` };
  }

  // Find next available port
  let port = BASE_SERVICE_PORT;
  const usedPorts = new Set([...config.services.values()].map((s) => s.port));
  while (usedPorts.has(port)) {
    port++;
  }

  const entry: ServiceEntry = { serviceId, hash, serviceName, token, port, owner };
  config.services.set(serviceId, entry);
  saveConfig(config);

  // Store owner in memory for auth verification
  serviceOwners.set(serviceId, owner);

  // Track services per hash
  hashServices.add(serviceId);
  servicesPerHash.set(hash, hashServices);

  console.log(`[Config] Registered service ${serviceId} on port ${port} for ${owner.callsign}`);
  return entry;
}

/**
 * Get the owner of a registered service.
 *
 * @param serviceId - Service ID ({serviceName}-{hash} or just {hash})
 * @returns Owner info if found, null otherwise
 */
export function getServiceOwner(serviceId: string): ServiceOwner | null {
  return serviceOwners.get(serviceId) || null;
}

/**
 * Unregister a tunnel client.
 * Removes from config file.
 *
 * @param serviceId - Service ID ({serviceName}-{hash} or just {hash})
 * @returns true if removed, false if not found
 */
export function unregisterService(serviceId: string): boolean {
  const config = loadConfig();

  const service = config.services.get(serviceId);
  if (!service) {
    console.log(`[Config] Service ${serviceId} not found`);
    return false;
  }

  config.services.delete(serviceId);
  saveConfig(config);

  // Clear owner from memory
  serviceOwners.delete(serviceId);

  // Update services per hash tracking
  const hashServices = servicesPerHash.get(service.hash);
  if (hashServices) {
    hashServices.delete(serviceId);
    if (hashServices.size === 0) {
      servicesPerHash.delete(service.hash);
    }
  }

  console.log(`[Config] Unregistered service ${serviceId}`);
  return true;
}

/**
 * Get service entry by service ID.
 *
 * @param serviceId - Service ID ({serviceName}-{hash} or just {hash})
 */
export function getService(serviceId: string): ServiceEntry | null {
  const config = loadConfig();
  return config.services.get(serviceId) || null;
}

/**
 * List all registered services.
 */
export function listServices(): ServiceEntry[] {
  const config = loadConfig();
  return [...config.services.values()];
}

/**
 * Initialize config file with base server settings.
 * Called on startup to ensure config exists.
 *
 * Note: rathole requires at least one service in the config to start.
 * We add a placeholder service that binds to localhost only (unreachable).
 */
export function initializeConfig(): void {
  if (existsSync(CONFIG_FILE)) {
    console.log(`[Config] Using existing config at ${CONFIG_FILE}`);
    return;
  }

  const config: RatholeConfig = {
    controlPort: CONTROL_PORT,
    heartbeatInterval: 30,
    services: new Map(),
  };

  // Add placeholder service - rathole requires at least one service to start
  // This binds to localhost only and uses an unusable token, so it's harmless
  config.services.set('_placeholder', {
    serviceId: '_placeholder',
    hash: '_placeholder',
    token: 'placeholder-not-used-token',
    port: 19999,
  });

  saveConfig(config);
  console.log(`[Config] Initialized new config at ${CONFIG_FILE}`);
}
