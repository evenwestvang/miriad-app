/**
 * Docker Runtime for Local Development
 *
 * Manages Docker containers for claude-code agents:
 * - Activates containers on demand
 * - Routes messages to running containers
 * - Handles idle timeout
 * - Tracks state in-memory (production uses SQLite/DynamoDB)
 */

import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  AgentRuntime,
  ActivateOptions,
  AgentRuntimeState,
  AgentStatus,
  AgentMessage,
  RuntimeEventHandler,
} from './types.js';
import { parseAgentId } from './types.js';

// =============================================================================
// Configuration
// =============================================================================

export interface DockerRuntimeConfig {
  /** Base directory for workspaces (default: ~/.cast/workspaces) */
  workspaceBase?: string;
  /** Docker image to use (default: claude-code:local) */
  imageName?: string;
  /** Idle timeout in ms (default: 10 minutes) */
  idleTimeoutMs?: number;
  /** Cast API URL for Tymbal streaming */
  castApiUrl: string;
  /** Anthropic API key */
  anthropicApiKey: string;
  /** Event handler for status updates */
  onEvent?: RuntimeEventHandler;
}

// =============================================================================
// Docker Runtime
// =============================================================================

export class DockerRuntime implements AgentRuntime {
  private readonly config: Required<Omit<DockerRuntimeConfig, 'onEvent'>> & {
    onEvent?: RuntimeEventHandler;
  };

  // In-memory state (production uses SQLite/DynamoDB)
  private state: Map<string, AgentRuntimeState> = new Map();
  private idleTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: DockerRuntimeConfig) {
    this.config = {
      workspaceBase: config.workspaceBase ?? join(homedir(), '.cast', 'workspaces'),
      imageName: config.imageName ?? 'claude-code:local',
      idleTimeoutMs: config.idleTimeoutMs ?? 10 * 60 * 1000, // 10 min
      castApiUrl: config.castApiUrl,
      anthropicApiKey: config.anthropicApiKey,
      onEvent: config.onEvent,
    };

    // Ensure workspace base exists
    if (!existsSync(this.config.workspaceBase)) {
      mkdirSync(this.config.workspaceBase, { recursive: true });
    }

    console.log(`[DockerRuntime] Initialized`);
    console.log(`[DockerRuntime] Workspace: ${this.config.workspaceBase}`);
    console.log(`[DockerRuntime] Image: ${this.config.imageName}`);
  }

  // ---------------------------------------------------------------------------
  // AgentRuntime Implementation
  // ---------------------------------------------------------------------------

  async activate(options: ActivateOptions): Promise<AgentRuntimeState> {
    const { agentId } = options;
    console.log(`[DockerRuntime] Activating container for ${agentId}`);

    // Check if already running (idempotent)
    const existing = this.state.get(agentId);
    if (existing && (existing.status === 'online' || existing.status === 'activating')) {
      if (existing.container && this.isContainerActuallyRunning(existing.container.containerId)) {
        console.log(`[DockerRuntime] Container already running`);
        return existing;
      }
      // Container died, clean up
      this.state.delete(agentId);
    }

    // Parse agentId to get components for workspace path
    const { spaceId, channelId, callsign } = parseAgentId(agentId);

    // Emit activating event
    await this.emit({ type: 'agent_activating', agentId });

    // Create workspace directory
    const workspacePath = join(
      this.config.workspaceBase,
      spaceId,
      `${channelId}-${callsign}`
    );
    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
    }

    // Find available port
    const port = await this.findAvailablePort();

    // Transform localhost for container networking
    const containerApiUrl = this.config.castApiUrl.replace(
      /localhost|127\.0\.0\.1/,
      'host.docker.internal'
    );

    // Compute callback URL for this container
    // Use localhost because the backend (running on host) will connect to the mapped port
    const callbackUrl = `http://localhost:${port}`;

    // Build docker run command with v3.0 env vars
    const containerName = `cast-agent-${this.hashAgentId(agentId)}`;
    const args = [
      'run',
      '-d',
      '--rm',
      '--name', containerName,
      '-p', `${port}:8080`,
      '-v', `${workspacePath}:/workspace`,
      '-e', `ANTHROPIC_API_KEY=${this.config.anthropicApiKey}`,
      '-e', `CAST_API_URL=${containerApiUrl}`,
      '-e', `CAST_AGENT_ID=${agentId}`,
      '-e', `CAST_AUTH_TOKEN=${options.authToken}`,
      '-e', `CAST_CALLBACK_URL=${callbackUrl}`,
      // Docker doesn't need route hints - containers are directly addressable
      '-e', `CAST_ROUTE_HINTS=`,
      '-e', `IDLE_TIMEOUT_MS=${this.config.idleTimeoutMs}`,
    ];

    // Add MCP servers if provided
    if (options.mcpServers && options.mcpServers.length > 0) {
      const mcpServersJson = JSON.stringify(options.mcpServers);
      args.push('-e', `MCP_SERVERS=${mcpServersJson}`);
      console.log(`[DockerRuntime] Passing ${options.mcpServers.length} MCP server(s) to container`);

      // Extract GITHUB_TOKEN from MCP server env vars for git shim
      // The git credential helper needs it as a direct env var
      for (const server of options.mcpServers) {
        if (server.env?.GITHUB_TOKEN) {
          args.push('-e', `GITHUB_TOKEN=${server.env.GITHUB_TOKEN}`);
          console.log(`[DockerRuntime] Passing GITHUB_TOKEN to container for git auth`);
          break; // Only need one token
        }
      }
    }

    // Add tunnel configuration if provided
    if (options.tunnelHash) {
      args.push('-e', `TUNNEL_HASH=${options.tunnelHash}`);
    }
    if (options.tunnelServerUrl) {
      args.push('-e', `TUNNEL_SERVER_URL=${options.tunnelServerUrl}`);
    }

    args.push(this.config.imageName);

    console.log(`[DockerRuntime] Starting container on port ${port}`);

    // Run docker using execFileSync to avoid shell escaping issues with JSON env vars
    const result = execFileSync('docker', args, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();

    const containerId = result.substring(0, 12);
    console.log(`[DockerRuntime] Container started: ${containerId}`);

    // Wait for container to be healthy
    await this.waitForHealthy(port);

    // Create state
    const now = new Date().toISOString();
    const runtimeState: AgentRuntimeState = {
      agentId,
      container: {
        containerId,
        runtime: 'docker',
      },
      port,
      status: 'online',
      endpoint: `http://localhost:${port}`,
      routeHints: null, // Docker doesn't use route hints
      activatedAt: now,
      lastActivity: now,
    };

    this.state.set(agentId, runtimeState);

    // Start idle timer
    this.resetIdleTimer(agentId, containerId);

    // Emit online event
    await this.emit({ type: 'agent_online', agentId, endpoint: runtimeState.endpoint! });

    return runtimeState;
  }

  async sendMessage(agentId: string, message: AgentMessage): Promise<void> {
    const state = this.state.get(agentId);
    if (!state || state.status !== 'online') {
      throw new Error(`No online container for agent ${agentId}`);
    }

    // Verify container is still running
    if (!state.container || !this.isContainerActuallyRunning(state.container.containerId)) {
      this.updateStatus(agentId, 'offline');
      throw new Error(`Container ${state.container?.containerId} is no longer running`);
    }

    // Forward message
    const url = `http://localhost:${state.port}/message`;
    const body: { content: string; agentId: string; systemPrompt?: string } = {
      content: message.content,
      agentId,
    };
    if (message.systemPrompt) {
      body.systemPrompt = message.systemPrompt;
    }

    // Generate auth token from agentId (deterministic - same as container received at activate)
    const authToken = this.generateAuthToken(agentId);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to forward message: ${response.status} ${error}`);
    }

    // Update activity and reset idle timer
    this.touchActivity(agentId);
    this.resetIdleTimer(agentId, state.container.containerId);

    console.log(`[DockerRuntime] Message forwarded to container`);
  }

  async suspend(agentId: string, reason = 'manual'): Promise<void> {
    const state = this.state.get(agentId);
    if (!state) {
      console.log(`[DockerRuntime] No container for agent ${agentId}`);
      return;
    }

    // Idempotent: no-op if already offline/suspending
    if (state.status === 'offline' || state.status === 'suspending') {
      console.log(`[DockerRuntime] Agent ${agentId} already ${state.status}`);
      return;
    }

    console.log(`[DockerRuntime] Suspending ${agentId}: ${reason}`);

    // Clear idle timer
    this.clearIdleTimer(agentId);

    // Update status to suspending
    this.updateStatus(agentId, 'suspending');

    // Stop container
    if (state.container) {
      this.stopContainer(state.container.containerId);
    }

    // Update state to offline
    this.updateStatus(agentId, 'offline');

    // Emit event
    await this.emit({ type: 'agent_offline', agentId, reason });
  }

  getState(agentId: string): AgentRuntimeState | null {
    return this.state.get(agentId) ?? null;
  }

  isOnline(agentId: string): boolean {
    const state = this.state.get(agentId);
    if (!state || state.status !== 'online') {
      return false;
    }
    return state.container ? this.isContainerActuallyRunning(state.container.containerId) : false;
  }

  getAllOnline(): AgentRuntimeState[] {
    return Array.from(this.state.values()).filter((s) => s.status === 'online');
  }

  async shutdown(): Promise<void> {
    console.log(`[DockerRuntime] Shutting down...`);

    // Clear all idle timers
    for (const [agentId] of this.idleTimers) {
      this.clearIdleTimer(agentId);
    }

    // Suspend all online agents
    const online = this.getAllOnline();
    for (const state of online) {
      if (state.container) {
        this.stopContainer(state.container.containerId);
      }
      this.updateStatus(state.agentId, 'offline');
    }

    console.log(`[DockerRuntime] Shutdown complete`);
  }

  // ---------------------------------------------------------------------------
  // Container Management
  // ---------------------------------------------------------------------------

  private stopContainer(containerId: string): void {
    try {
      execFileSync('docker', ['stop', containerId], {
        timeout: 10000,
        stdio: 'ignore',
      });
      console.log(`[DockerRuntime] Container stopped: ${containerId}`);
    } catch {
      console.log(`[DockerRuntime] Container stop failed (may be already stopped)`);
    }
  }

  private isContainerActuallyRunning(containerId: string): boolean {
    try {
      const result = execFileSync('docker', ['inspect', '-f', '{{.State.Running}}', containerId], {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      return result === 'true';
    } catch {
      return false;
    }
  }

  private async waitForHealthy(port: number, timeoutMs = 60000): Promise<void> {
    const startTime = Date.now();
    const healthUrl = `http://localhost:${port}/health`;

    console.log(`[DockerRuntime] Waiting for health at ${healthUrl}`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(healthUrl, { method: 'GET' });
        if (response.ok) {
          console.log(`[DockerRuntime] Healthy after ${Date.now() - startTime}ms`);
          return;
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(500);
    }

    throw new Error(`Container health check timed out after ${timeoutMs}ms`);
  }

  // ---------------------------------------------------------------------------
  // State Management
  // ---------------------------------------------------------------------------

  private updateStatus(agentId: string, status: AgentStatus): void {
    const state = this.state.get(agentId);
    if (state) {
      state.status = status;
      state.lastActivity = new Date().toISOString();
      // Clear routing info when going offline
      if (status === 'offline') {
        state.endpoint = null;
        state.routeHints = null;
        state.container = null;
      }
    }
  }

  private touchActivity(agentId: string): void {
    const state = this.state.get(agentId);
    if (state) {
      state.lastActivity = new Date().toISOString();
    }
  }

  // ---------------------------------------------------------------------------
  // Idle Timer Management
  // ---------------------------------------------------------------------------

  private resetIdleTimer(agentId: string, containerId: string): void {
    this.clearIdleTimer(agentId);

    const timer = setTimeout(() => {
      console.log(`[DockerRuntime] Idle timeout for ${agentId}`);
      this.suspend(agentId, 'idle timeout');
    }, this.config.idleTimeoutMs);

    this.idleTimers.set(agentId, timer);
  }

  private clearIdleTimer(agentId: string): void {
    const timer = this.idleTimers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(agentId);
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

  private async findAvailablePort(): Promise<number> {
    for (let port = 8081; port < 9000; port++) {
      try {
        await fetch(`http://localhost:${port}/`, {
          method: 'HEAD',
          signal: AbortSignal.timeout(100),
        });
        // Port is in use
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          continue;
        }
        return port;
      }
    }
    throw new Error('No available ports in range 8081-9000');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private hashAgentId(agentId: string): string {
    return createHash('sha256').update(agentId).digest('hex').substring(0, 12);
  }

  /**
   * Generate a container auth token from agentId.
   * Duplicates logic from @cast/server/auth/container-token.ts for package isolation.
   * Token format: base64url(spaceId:channelId:callsign).hmac
   */
  private generateAuthToken(agentId: string): string {
    const secret = process.env.CAST_CONTAINER_SECRET ?? 'cast-dev-container-secret-do-not-use-in-production';
    const encodedData = Buffer.from(agentId).toString('base64url');
    const hmac = createHmac('sha256', secret).update(agentId).digest('base64url');
    return `${encodedData}.${hmac}`;
  }
}
