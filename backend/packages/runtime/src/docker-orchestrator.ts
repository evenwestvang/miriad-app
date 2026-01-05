/**
 * Docker Orchestrator for Local Development
 *
 * Manages Docker containers for claude-code agents:
 * - Spawns containers on demand
 * - Routes messages to running containers
 * - Handles idle timeout
 * - Tracks state in-memory (production uses SQLite/DynamoDB)
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ContainerOrchestrator,
  ContainerSpawnOptions,
  ContainerState,
  ContainerStatus,
  McpServerConfig,
  OrchestratorEventHandler,
} from './types.js';

// =============================================================================
// Configuration
// =============================================================================

export interface DockerOrchestratorConfig {
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
  onEvent?: OrchestratorEventHandler;
}

// =============================================================================
// Docker Orchestrator
// =============================================================================

export class DockerOrchestrator implements ContainerOrchestrator {
  private readonly config: Required<Omit<DockerOrchestratorConfig, 'onEvent'>> & {
    onEvent?: OrchestratorEventHandler;
  };

  // In-memory state (production uses SQLite/DynamoDB)
  private state: Map<string, ContainerState> = new Map();
  private idleTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(config: DockerOrchestratorConfig) {
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

    console.log(`[DockerOrchestrator] Initialized`);
    console.log(`[DockerOrchestrator] Workspace: ${this.config.workspaceBase}`);
    console.log(`[DockerOrchestrator] Image: ${this.config.imageName}`);
  }

  // ---------------------------------------------------------------------------
  // ContainerOrchestrator Implementation
  // ---------------------------------------------------------------------------

  async spawn(options: ContainerSpawnOptions): Promise<ContainerState> {
    const threadId = this.buildThreadId(options);
    console.log(`[DockerOrchestrator] Spawning container for ${threadId}`);

    // Check if already running
    const existing = this.state.get(threadId);
    if (existing && existing.status === 'running') {
      if (this.isContainerActuallyRunning(existing.containerId)) {
        console.log(`[DockerOrchestrator] Container already running`);
        return existing;
      }
      // Container died, clean up
      this.state.delete(threadId);
    }

    // Emit starting event
    await this.emit({ type: 'container_starting', threadId });

    // Create workspace directory
    const workspacePath = join(
      this.config.workspaceBase,
      options.spaceId,
      `${options.channelId}-${options.callsign}`
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

    // Build docker run command
    const containerName = `cast-agent-${this.hashThreadId(threadId)}`;
    const args = [
      'run',
      '-d',
      '--rm',
      '--name', containerName,
      '-p', `${port}:8080`,
      '-v', `${workspacePath}:/workspace`,
      '-e', `ANTHROPIC_API_KEY=${this.config.anthropicApiKey}`,
      '-e', `CAST_API_URL=${containerApiUrl}`,
      '-e', `CIKADA_API_URL=${containerApiUrl}`,  // Legacy container compat
      '-e', `CAST_SPACE_ID=${options.spaceId}`,
      '-e', `CAST_CHANNEL_ID=${options.channelId}`,
      '-e', `CAST_CALLSIGN=${options.callsign}`,
      '-e', `CAST_AUTH_TOKEN=${options.authToken}`,
      '-e', `THREAD_ID=${threadId}`,
      '-e', `IDLE_TIMEOUT_MS=${this.config.idleTimeoutMs}`,
      this.config.imageName,
    ];

    console.log(`[DockerOrchestrator] Starting container on port ${port}`);

    // Run docker
    const result = execSync(`docker ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();

    const containerId = result.substring(0, 12);
    console.log(`[DockerOrchestrator] Container started: ${containerId}`);

    // Wait for container to be healthy
    await this.waitForHealthy(port);

    // Create state
    const now = new Date().toISOString();
    const containerState: ContainerState = {
      threadId,
      containerId,
      port,
      status: 'running',
      lastActivity: now,
      createdAt: now,
    };

    this.state.set(threadId, containerState);

    // Start idle timer
    this.resetIdleTimer(threadId, containerId);

    // Emit ready event
    await this.emit({ type: 'container_ready', threadId, port });

    return containerState;
  }

  async sendMessage(threadId: string, content: string, systemPrompt?: string): Promise<void> {
    const state = this.state.get(threadId);
    if (!state || state.status !== 'running') {
      throw new Error(`No running container for thread ${threadId}`);
    }

    // Verify container is still running
    if (!this.isContainerActuallyRunning(state.containerId)) {
      this.updateStatus(threadId, 'stopped');
      throw new Error(`Container ${state.containerId} is no longer running`);
    }

    // Forward message
    const url = `http://localhost:${state.port}/message`;
    const body: { content: string; threadId: string; systemPrompt?: string } = {
      content,
      threadId,
    };
    if (systemPrompt) {
      body.systemPrompt = systemPrompt;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to forward message: ${response.status} ${error}`);
    }

    // Update activity and reset idle timer
    this.touchActivity(threadId);
    this.resetIdleTimer(threadId, state.containerId);

    console.log(`[DockerOrchestrator] Message forwarded to container`);
  }

  async stop(threadId: string, reason = 'manual'): Promise<void> {
    const state = this.state.get(threadId);
    if (!state) {
      console.log(`[DockerOrchestrator] No container for thread ${threadId}`);
      return;
    }

    console.log(`[DockerOrchestrator] Stopping ${threadId}: ${reason}`);

    // Clear idle timer
    this.clearIdleTimer(threadId);

    // Stop container
    this.stopContainer(state.containerId);

    // Update state
    this.updateStatus(threadId, 'stopped');

    // Emit event
    await this.emit({ type: 'container_stopped', threadId, reason });
  }

  getStatus(threadId: string): ContainerState | null {
    return this.state.get(threadId) ?? null;
  }

  isRunning(threadId: string): boolean {
    const state = this.state.get(threadId);
    if (!state || state.status !== 'running') {
      return false;
    }
    return this.isContainerActuallyRunning(state.containerId);
  }

  getAllRunning(): ContainerState[] {
    return Array.from(this.state.values()).filter((s) => s.status === 'running');
  }

  async shutdown(): Promise<void> {
    console.log(`[DockerOrchestrator] Shutting down...`);

    // Clear all idle timers
    for (const [threadId] of this.idleTimers) {
      this.clearIdleTimer(threadId);
    }

    // Stop all running containers
    const running = this.getAllRunning();
    for (const state of running) {
      this.stopContainer(state.containerId);
      this.updateStatus(state.threadId, 'stopped');
    }

    console.log(`[DockerOrchestrator] Shutdown complete`);
  }

  // ---------------------------------------------------------------------------
  // Helper: Build thread ID
  // ---------------------------------------------------------------------------

  private buildThreadId(options: ContainerSpawnOptions): string {
    return `${options.spaceId}:${options.channelId}:${options.callsign}`;
  }

  // ---------------------------------------------------------------------------
  // Container Management
  // ---------------------------------------------------------------------------

  private stopContainer(containerId: string): void {
    try {
      execSync(`docker stop ${containerId}`, {
        timeout: 10000,
        stdio: 'ignore',
      });
      console.log(`[DockerOrchestrator] Container stopped: ${containerId}`);
    } catch {
      console.log(`[DockerOrchestrator] Container stop failed (may be already stopped)`);
    }
  }

  private isContainerActuallyRunning(containerId: string): boolean {
    try {
      const result = execSync(`docker inspect -f '{{.State.Running}}' ${containerId}`, {
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

    console.log(`[DockerOrchestrator] Waiting for health at ${healthUrl}`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(healthUrl, { method: 'GET' });
        if (response.ok) {
          console.log(`[DockerOrchestrator] Healthy after ${Date.now() - startTime}ms`);
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

  private updateStatus(threadId: string, status: ContainerStatus): void {
    const state = this.state.get(threadId);
    if (state) {
      state.status = status;
      state.lastActivity = new Date().toISOString();
    }
  }

  private touchActivity(threadId: string): void {
    const state = this.state.get(threadId);
    if (state) {
      state.lastActivity = new Date().toISOString();
    }
  }

  // ---------------------------------------------------------------------------
  // Idle Timer Management
  // ---------------------------------------------------------------------------

  private resetIdleTimer(threadId: string, containerId: string): void {
    this.clearIdleTimer(threadId);

    const timer = setTimeout(() => {
      console.log(`[DockerOrchestrator] Idle timeout for ${threadId}`);
      this.stop(threadId, 'idle timeout');
    }, this.config.idleTimeoutMs);

    this.idleTimers.set(threadId, timer);
  }

  private clearIdleTimer(threadId: string): void {
    const timer = this.idleTimers.get(threadId);
    if (timer) {
      clearTimeout(timer);
      this.idleTimers.delete(threadId);
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  private async emit(event: Parameters<OrchestratorEventHandler>[0]): Promise<void> {
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

  private hashThreadId(threadId: string): string {
    return createHash('sha256').update(threadId).digest('hex').substring(0, 12);
  }
}
