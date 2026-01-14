/**
 * Fly.io Runtime for Production
 *
 * Manages Fly Machines for claude-code agents:
 * - Activates containers on demand via Fly Machines API
 * - Routes messages to running containers using routeHints
 * - Uses Planetscale Postgres for state (via Storage interface)
 * - Handles Fly API rate limits with exponential backoff
 *
 * Key differences from DockerRuntime:
 * - Fire-and-forget activation (returns 'activating', container calls /agents/checkin)
 * - State stored in Postgres roster table (not in-memory)
 * - routeHints with fly-force-instance-id for instance routing
 * - 180s activation timeout with machine cleanup
 */

import { createHash, createHmac } from 'node:crypto';
import type {
  AgentRuntime,
  ActivateOptions,
  AgentRuntimeState,
  AgentMessage,
  RuntimeEventHandler,
} from './types.js';
import { parseAgentId } from './types.js';
import type { Storage } from '@cast/storage';
import type { RosterEntry } from '@cast/core';

// =============================================================================
// Configuration
// =============================================================================

export interface FlyRuntimeConfig {
  /** Fly.io app name (e.g., 'cast-agents') */
  flyAppName: string;
  /** Fly.io API token */
  flyApiToken: string;
  /** Fly.io region (e.g., 'iad', 'fra') */
  flyRegion: string;
  /** Docker image to deploy */
  imageName: string;
  /** Cast API URL (public URL, not localhost) */
  castApiUrl: string;
  /** Anthropic API key */
  anthropicApiKey: string;
  /** Storage backend for roster operations */
  storage: Storage;
  /** Default space ID */
  spaceId: string;
  /** Activation timeout in ms (default: 180s per spec) */
  activationTimeoutMs?: number;
  /** Machine memory in MB (default: 8192, minimum for performance CPUs) */
  memoryMb?: number;
  /** Machine CPUs (default: 4) */
  cpus?: number;
  /** CPU type: 'shared' or 'performance' (default: 'performance') */
  cpuKind?: 'shared' | 'performance';
  /** Event handler for status updates */
  onEvent?: RuntimeEventHandler;
}

// =============================================================================
// Fly Machines API Types
// =============================================================================

interface FlyMachineConfig {
  image: string;
  env: Record<string, string>;
  guest: {
    cpu_kind: 'shared' | 'performance';
    cpus: number;
    memory_mb: number;
  };
  services: Array<{
    protocol: 'tcp';
    internal_port: number;
    ports: Array<{
      port: number;
      handlers: string[];
    }>;
  }>;
  restart: {
    policy: 'no' | 'on-failure' | 'always';
  };
  auto_destroy: boolean;
}

interface FlyMachine {
  id: string;
  name: string;
  state: string;
  region: string;
  config: FlyMachineConfig;
}

interface FlyCreateMachineRequest {
  name: string;
  region: string;
  config: FlyMachineConfig;
}

// =============================================================================
// Fly API Client with Rate Limit Handling
// =============================================================================

class FlyClient {
  private readonly baseUrl = 'https://api.machines.dev/v1';
  private readonly appName: string;
  private readonly token: string;

  constructor(appName: string, token: string) {
    this.appName = appName;
    this.token = token;
  }

  /**
   * Make a request to the Fly Machines API with rate limit retry.
   * Implements exponential backoff: 1s, 2s, 4s
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    maxRetries = 3
  ): Promise<T> {
    const url = `${this.baseUrl}/apps/${this.appName}${path}`;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method,
          headers: {
            'Authorization': `Bearer ${this.token}`,
            'Content-Type': 'application/json',
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        // Rate limited - retry with backoff
        if (response.status === 429 && attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
          console.log(`[FlyClient] Rate limited, retrying in ${backoffMs}ms`);
          await this.sleep(backoffMs);
          continue;
        }

        // Server error - retry with backoff
        if (response.status >= 500 && attempt < maxRetries) {
          const backoffMs = Math.pow(2, attempt) * 1000;
          console.log(`[FlyClient] Server error ${response.status}, retrying in ${backoffMs}ms`);
          await this.sleep(backoffMs);
          continue;
        }

        if (!response.ok) {
          const error = await response.text();
          const flyError = new Error(`Fly API error ${response.status}: ${error}`);
          // Mark client errors (4xx) as non-retryable
          (flyError as Error & { statusCode?: number }).statusCode = response.status;
          throw flyError;
        }

        // Handle 204 No Content (e.g., DELETE responses)
        if (response.status === 204) {
          return undefined as T;
        }

        return await response.json() as T;
      } catch (error) {
        // Don't retry client errors (4xx) - they're not transient
        const statusCode = (error as Error & { statusCode?: number }).statusCode;
        if (statusCode && statusCode >= 400 && statusCode < 500) {
          throw error;
        }
        if (attempt === maxRetries) {
          throw error;
        }
        // Network error - retry
        const backoffMs = Math.pow(2, attempt) * 1000;
        console.log(`[FlyClient] Network error, retrying in ${backoffMs}ms:`, error);
        await this.sleep(backoffMs);
      }
    }

    throw new Error('Max retries exceeded');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async createMachine(req: FlyCreateMachineRequest): Promise<FlyMachine> {
    return this.request<FlyMachine>('POST', '/machines', req);
  }

  async getMachine(machineId: string): Promise<FlyMachine | null> {
    try {
      return await this.request<FlyMachine>('GET', `/machines/${machineId}`);
    } catch (error) {
      if (error instanceof Error && error.message.includes('404')) {
        return null;
      }
      throw error;
    }
  }

  async startMachine(machineId: string): Promise<void> {
    await this.request<void>('POST', `/machines/${machineId}/start`);
  }

  async stopMachine(machineId: string): Promise<void> {
    try {
      await this.request<void>('POST', `/machines/${machineId}/stop`);
    } catch (error) {
      // Ignore errors if machine is already stopped
      console.log(`[FlyClient] Stop machine error (may be already stopped):`, error);
    }
  }

  async deleteMachine(machineId: string, force = false): Promise<void> {
    try {
      const path = force ? `/machines/${machineId}?force=true` : `/machines/${machineId}`;
      await this.request<void>('DELETE', path);
    } catch (error) {
      // Ignore 404 - machine already deleted
      if (error instanceof Error && error.message.includes('404')) {
        return;
      }
      throw error;
    }
  }

  async waitForState(
    machineId: string,
    targetState: string,
    timeoutMs = 60000
  ): Promise<boolean> {
    try {
      await this.request<FlyMachine>(
        'GET',
        `/machines/${machineId}/wait?state=${targetState}&timeout=${timeoutMs}`
      );
      return true;
    } catch {
      return false;
    }
  }
}

// =============================================================================
// Heartbeat Staleness (matches checkin.ts)
// =============================================================================

const HEARTBEAT_STALE_MS = 60_000;

function isHeartbeatStale(lastHeartbeat: string | null | undefined): boolean {
  if (!lastHeartbeat) return true;
  const lastTime = new Date(lastHeartbeat).getTime();
  return Date.now() - lastTime > HEARTBEAT_STALE_MS;
}

// =============================================================================
// Fly Runtime
// =============================================================================

export class FlyRuntime implements AgentRuntime {
  private readonly config: Required<Omit<FlyRuntimeConfig, 'onEvent' | 'activationTimeoutMs' | 'memoryMb' | 'cpus' | 'cpuKind'>> & {
    onEvent?: RuntimeEventHandler;
    activationTimeoutMs: number;
    memoryMb: number;
    cpus: number;
    cpuKind: 'shared' | 'performance';
  };

  private readonly flyClient: FlyClient;

  // Track pending activations for timeout cleanup
  private activationTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: FlyRuntimeConfig) {
    this.config = {
      flyAppName: config.flyAppName,
      flyApiToken: config.flyApiToken,
      flyRegion: config.flyRegion,
      imageName: config.imageName,
      castApiUrl: config.castApiUrl,
      anthropicApiKey: config.anthropicApiKey,
      storage: config.storage,
      spaceId: config.spaceId,
      activationTimeoutMs: config.activationTimeoutMs ?? 180_000, // 180s per spec
      memoryMb: config.memoryMb ?? 8192, // 8GB minimum for performance CPUs
      cpus: config.cpus ?? 4,
      cpuKind: config.cpuKind ?? 'performance',
      onEvent: config.onEvent,
    };

    this.flyClient = new FlyClient(config.flyAppName, config.flyApiToken);

    console.log(`[FlyRuntime] Initialized`);
    console.log(`[FlyRuntime] App: ${this.config.flyAppName}`);
    console.log(`[FlyRuntime] Region: ${this.config.flyRegion}`);
    console.log(`[FlyRuntime] Image: ${this.config.imageName}`);
    console.log(`[FlyRuntime] Machine spec: ${this.config.cpus} ${this.config.cpuKind} CPUs, ${this.config.memoryMb}MB RAM`);
  }

  // ---------------------------------------------------------------------------
  // AgentRuntime Implementation
  // ---------------------------------------------------------------------------

  async activate(options: ActivateOptions): Promise<AgentRuntimeState> {
    const { agentId } = options;
    console.log(`[FlyRuntime] Activating container for ${agentId}`);

    // Parse agentId
    const { spaceId, channelId, callsign } = parseAgentId(agentId);

    // Check roster for existing state
    const rosterEntry = await this.config.storage.getRosterByCallsign(channelId, callsign);
    if (!rosterEntry) {
      throw new Error(`Agent ${callsign} not found in roster for channel ${channelId}`);
    }

    // Check if already online (idempotent)
    if (rosterEntry.callbackUrl && !isHeartbeatStale(rosterEntry.lastHeartbeat)) {
      console.log(`[FlyRuntime] Agent already online`);
      return this.rosterToState(agentId, rosterEntry, 'online');
    }

    // Compute deterministic machine ID from agentId
    const machineId = this.computeMachineId(agentId);

    // Check if machine already exists (getMachine accepts name or ID)
    const existingMachine = await this.flyClient.getMachine(machineId);
    if (existingMachine) {
      // Use the real Fly machine ID for API operations
      const flyMachineId = existingMachine.id;

      // Machine exists - check its state
      if (existingMachine.state === 'started') {
        console.log(`[FlyRuntime] Machine ${flyMachineId} already running, waiting for checkin`);
        return this.rosterToState(agentId, rosterEntry, 'activating');
      }

      if (existingMachine.state === 'stopped') {
        // Start the existing machine using real Fly ID
        console.log(`[FlyRuntime] Starting stopped machine ${flyMachineId}`);
        await this.flyClient.startMachine(flyMachineId);

        // Update routeHints in roster with real Fly machine ID (in case it was cleared)
        const routeHints = { 'fly-force-instance-id': flyMachineId };
        await this.config.storage.updateRosterEntry(channelId, rosterEntry.id, { routeHints });

        this.startActivationTimeout(agentId);
        await this.emit({ type: 'agent_activating', agentId });
        return this.rosterToState(agentId, rosterEntry, 'activating');
      }

      // Machine in transient state - wait for it
      console.log(`[FlyRuntime] Machine ${flyMachineId} in state ${existingMachine.state}, waiting`);
      return this.rosterToState(agentId, rosterEntry, 'activating');
    }

    // Create new machine
    console.log(`[FlyRuntime] Creating new machine with name ${machineId}`);

    // Compute callback URL (routeHints set after machine creation with real Fly ID)
    const callbackUrl = `https://${this.config.flyAppName}.fly.dev`;

    // Build environment variables (v3.0 protocol)
    // Note: CAST_ROUTE_HINTS not set here - we'll update roster with real Fly machine ID after creation
    const env: Record<string, string> = {
      ANTHROPIC_API_KEY: this.config.anthropicApiKey,
      CAST_API_URL: this.config.castApiUrl,
      CAST_AGENT_ID: agentId,
      CAST_AUTH_TOKEN: options.authToken,
      CAST_CALLBACK_URL: callbackUrl,
    };

    // Add MCP servers if provided
    if (options.mcpServers && options.mcpServers.length > 0) {
      env.MCP_SERVERS = JSON.stringify(options.mcpServers);
      console.log(`[FlyRuntime] Passing ${options.mcpServers.length} MCP server(s) to container`);
    }

    // Add tunnel configuration if provided
    if (options.tunnelHash) {
      env.TUNNEL_HASH = options.tunnelHash;
    }
    if (options.tunnelServerUrl) {
      env.TUNNEL_SERVER_URL = options.tunnelServerUrl;
    }

    // Create machine config
    const machineConfig: FlyMachineConfig = {
      image: this.config.imageName,
      env,
      guest: {
        cpu_kind: this.config.cpuKind,
        cpus: this.config.cpus,
        memory_mb: this.config.memoryMb,
      },
      services: [
        {
          protocol: 'tcp',
          internal_port: 8080,
          ports: [
            { port: 443, handlers: ['tls', 'http'] },
            { port: 80, handlers: ['http'] },
          ],
        },
      ],
      restart: {
        policy: 'no', // Don't auto-restart - let activation timeout handle failures
      },
      auto_destroy: true, // Clean up on stop
    };

    try {
      const createdMachine = await this.flyClient.createMachine({
        name: machineId,
        region: this.config.flyRegion,
        config: machineConfig,
      });

      // Fly assigns its own machine ID - use that for routing
      const flyMachineId = createdMachine.id;
      console.log(`[FlyRuntime] Machine created: name=${machineId}, flyId=${flyMachineId}`);

      // Pre-populate routeHints in roster with real Fly machine ID
      // This ensures correct routing even if container doesn't send routeHints
      const routeHints = { 'fly-force-instance-id': flyMachineId };
      await this.config.storage.updateRosterEntry(channelId, rosterEntry.id, {
        routeHints,
      });
      console.log(`[FlyRuntime] Pre-populated routeHints in roster: ${JSON.stringify(routeHints)}`);

      // Start activation timeout
      this.startActivationTimeout(agentId);

      // Emit activating event
      await this.emit({ type: 'agent_activating', agentId });

      // Return immediately with activating status (fire-and-forget)
      // Container will call /agents/checkin when ready
      return this.rosterToState(agentId, rosterEntry, 'activating');
    } catch (error) {
      // Handle 409 Conflict (machine already exists) - idempotent
      if (error instanceof Error && error.message.includes('409')) {
        console.log(`[FlyRuntime] Machine ${machineId} already exists (409), treating as activating`);
        this.startActivationTimeout(agentId);
        return this.rosterToState(agentId, rosterEntry, 'activating');
      }
      throw error;
    }
  }

  async sendMessage(agentId: string, message: AgentMessage): Promise<void> {
    const { channelId, callsign } = parseAgentId(agentId);

    // Get roster entry with callback URL and route hints
    const rosterEntry = await this.config.storage.getRosterByCallsign(channelId, callsign);
    if (!rosterEntry) {
      throw new Error(`Agent ${callsign} not found in roster`);
    }

    if (!rosterEntry.callbackUrl) {
      throw new Error(`Agent ${agentId} has no callback URL (not online)`);
    }

    if (isHeartbeatStale(rosterEntry.lastHeartbeat)) {
      throw new Error(`Agent ${agentId} heartbeat is stale (offline)`);
    }

    // Build request
    const url = `${rosterEntry.callbackUrl}/message`;
    const body: { content: string; agentId: string; systemPrompt?: string } = {
      content: message.content,
      agentId,
    };
    if (message.systemPrompt) {
      body.systemPrompt = message.systemPrompt;
    }

    // Build headers with auth and route hints
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.generateAuthToken(agentId)}`,
    };

    // Echo routeHints as HTTP headers (for Fly instance routing)
    if (rosterEntry.routeHints) {
      for (const [key, value] of Object.entries(rosterEntry.routeHints)) {
        headers[key] = value;
      }
    }

    console.log(`[FlyRuntime] Sending message to ${url}`);

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to send message: ${response.status} ${error}`);
    }

    console.log(`[FlyRuntime] Message sent successfully`);
  }

  async suspend(agentId: string, reason = 'manual'): Promise<void> {
    const { channelId, callsign } = parseAgentId(agentId);
    console.log(`[FlyRuntime] Suspending ${agentId}: ${reason}`);

    // Clear activation timeout if any
    this.clearActivationTimeout(agentId);

    // Get roster entry to find the real Fly machine ID
    const rosterEntry = await this.config.storage.getRosterByCallsign(channelId, callsign);

    // Get real Fly machine ID from routeHints (set by activate() after machine creation)
    // Note: computeMachineId() returns our deterministic hash used as machine NAME,
    // but Fly API needs the real machine ID assigned by Fly
    const flyMachineId = rosterEntry?.routeHints?.['fly-force-instance-id'] as string | undefined;

    if (flyMachineId) {
      // Stop and delete the machine using real Fly ID
      try {
        await this.flyClient.stopMachine(flyMachineId);
        // With auto_destroy: true, machine will be deleted after stop
        // But we delete explicitly for immediate cleanup
        await this.flyClient.deleteMachine(flyMachineId, true);
        console.log(`[FlyRuntime] Machine ${flyMachineId} deleted`);
      } catch (error) {
        console.log(`[FlyRuntime] Machine cleanup error (may be already gone):`, error);
      }
    } else {
      console.log(`[FlyRuntime] No Fly machine ID in roster, skipping machine cleanup`);
    }

    // Clear roster callback (marks as offline)
    if (rosterEntry) {
      await this.config.storage.updateRosterEntry(channelId, rosterEntry.id, {
        callbackUrl: undefined,
        routeHints: null,
      });
    }

    // Emit event
    await this.emit({ type: 'agent_offline', agentId, reason });
  }

  getState(agentId: string): AgentRuntimeState | null {
    // FlyRuntime uses async storage, so this sync method can't provide real state
    // Return null - callers should use isOnline() or check roster directly
    return null;
  }

  isOnline(agentId: string): boolean {
    // Sync method can't check async storage
    // This is called by checkin handler which should check roster directly
    return false;
  }

  getAllOnline(): AgentRuntimeState[] {
    // Would need async roster query
    // For Fly, the checkin handler manages state via roster
    return [];
  }

  async shutdown(): Promise<void> {
    console.log(`[FlyRuntime] Shutting down...`);

    // Clear all activation timers
    for (const [agentId, timer] of this.activationTimers) {
      clearTimeout(timer);
    }
    this.activationTimers.clear();

    // Note: We don't stop all Fly machines on shutdown
    // They continue running and can serve requests via the API
    // Machines are stopped via suspend() or activation timeout

    console.log(`[FlyRuntime] Shutdown complete`);
  }

  // ---------------------------------------------------------------------------
  // Activation Timeout
  // ---------------------------------------------------------------------------

  private startActivationTimeout(agentId: string): void {
    this.clearActivationTimeout(agentId);

    const timer = setTimeout(async () => {
      console.log(`[FlyRuntime] Activation timeout for ${agentId}`);

      // Check if agent came online (roster has callbackUrl with fresh heartbeat)
      const { channelId, callsign } = parseAgentId(agentId);
      const rosterEntry = await this.config.storage.getRosterByCallsign(channelId, callsign);

      if (rosterEntry?.callbackUrl && !isHeartbeatStale(rosterEntry.lastHeartbeat)) {
        console.log(`[FlyRuntime] Agent ${agentId} is online, timeout cleared`);
        return;
      }

      // Agent didn't come online - clean up machine
      // Get real Fly machine ID from routeHints (set by activate() after machine creation)
      const flyMachineId = rosterEntry?.routeHints?.['fly-force-instance-id'] as string | undefined;

      if (flyMachineId) {
        console.log(`[FlyRuntime] Agent ${agentId} failed to activate, cleaning up machine ${flyMachineId}`);
        try {
          await this.flyClient.deleteMachine(flyMachineId, true);
          console.log(`[FlyRuntime] Orphaned machine ${flyMachineId} deleted`);
        } catch (error) {
          console.error(`[FlyRuntime] Failed to delete orphaned machine ${flyMachineId}:`, error);
        }
      } else {
        console.log(`[FlyRuntime] Agent ${agentId} failed to activate, no Fly machine ID to clean up`);
      }

      // Emit error event
      await this.emit({ type: 'agent_error', agentId, error: 'Activation timeout' });
    }, this.config.activationTimeoutMs);

    this.activationTimers.set(agentId, timer);
  }

  private clearActivationTimeout(agentId: string): void {
    const timer = this.activationTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.activationTimers.delete(agentId);
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private async emit(event: Parameters<RuntimeEventHandler>[0]): Promise<void> {
    if (this.config.onEvent) {
      await this.config.onEvent(event);
    }
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  /**
   * Compute deterministic machine ID from agentId.
   * Uses SHA256 hash truncated to 14 chars (Fly machine ID format).
   */
  private computeMachineId(agentId: string): string {
    // Fly machine IDs are 14-char hex
    return createHash('sha256').update(agentId).digest('hex').substring(0, 14);
  }

  /**
   * Convert roster entry to AgentRuntimeState.
   */
  private rosterToState(
    agentId: string,
    rosterEntry: RosterEntry,
    status: 'offline' | 'activating' | 'online'
  ): AgentRuntimeState {
    const machineId = this.computeMachineId(agentId);
    const isOnline = status === 'online';

    return {
      agentId,
      container: isOnline || status === 'activating' ? {
        containerId: machineId,
        runtime: 'fly',
      } : null,
      port: null, // Fly uses HTTPS, not local ports
      status,
      endpoint: isOnline ? rosterEntry.callbackUrl ?? null : null,
      routeHints: isOnline ? rosterEntry.routeHints ?? null : null,
      activatedAt: isOnline && rosterEntry.lastHeartbeat ? rosterEntry.lastHeartbeat : null,
      lastActivity: rosterEntry.lastHeartbeat ?? new Date().toISOString(),
    };
  }

  /**
   * Generate a container auth token from agentId.
   * Duplicates logic from @cast/server/auth/container-token.ts for package isolation.
   */
  private generateAuthToken(agentId: string): string {
    const secret = process.env.CAST_CONTAINER_SECRET ?? 'cast-dev-container-secret-do-not-use-in-production';
    const encodedData = Buffer.from(agentId).toString('base64url');
    const hmac = createHmac('sha256', secret).update(agentId).digest('base64url');
    return `${encodedData}.${hmac}`;
  }
}
