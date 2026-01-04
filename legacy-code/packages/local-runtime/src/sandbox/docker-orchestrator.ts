/**
 * Docker Orchestrator for Local Sandbox
 *
 * Manages Docker containers for claude-code agent type:
 * - Starts containers on first message
 * - Routes messages to running containers
 * - Tracks container state in SQLite
 * - Handles idle timeout and session resume
 */

import { spawn, execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ContainerStateStore, type ContainerState } from "./container-state.js";

// =============================================================================
// MCP Server Config (matches @cikada/core McpServerConfig)
// =============================================================================

/** Pre-resolved MCP server configuration */
export interface McpServerConfig {
  /** Server name for tool namespacing (e.g., 'filesystem' -> mcp__filesystem__read_file) */
  name: string;
  /** MCP server artifact slug (optional, for board-defined servers) */
  slug?: string;
  /** Transport type */
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

// =============================================================================
// MCP Options for sendMessage
// =============================================================================

export interface SendMessageOptions {
  /** Space ID for workspace isolation */
  spaceId?: string;
  channelId?: string;
  callsign?: string;
  /** Pre-resolved MCP server configs to pass to the container */
  mcpServers?: McpServerConfig[];
  /** Auth token for container to use when calling back to API */
  authToken?: string;
  /** System prompt with channel context, roster, and @mention rules */
  systemPrompt?: string;
}

// =============================================================================
// Types
// =============================================================================

export interface DockerOrchestratorOptions {
  /** Base directory for workspaces (default: ~/.cikada/workspaces) */
  workspaceBase?: string;
  /** Docker image to use (default: claude-code:local) */
  imageName?: string;
  /** Idle timeout in ms (default: 10 minutes) */
  idleTimeoutMs?: number;
  /** Port to expose container on (default: auto-assign) */
  containerPort?: number;
  /** Cikada API URL for Tymbal streaming */
  cikadaApiUrl: string;
  /** Anthropic API key */
  anthropicApiKey: string;
  /** Broadcast function for status messages */
  broadcast?: (threadId: string, frame: string) => Promise<void>;
}

export interface ContainerInfo {
  containerId: string;
  port: number;
  status: "starting" | "running" | "stopped";
}

// =============================================================================
// Docker Orchestrator
// =============================================================================

export class DockerOrchestrator {
  private readonly workspaceBase: string;
  private readonly imageName: string;
  private readonly idleTimeoutMs: number;
  private readonly cikadaApiUrl: string;
  private readonly anthropicApiKey: string;
  private readonly stateStore: ContainerStateStore;
  private readonly broadcast?: (threadId: string, frame: string) => Promise<void>;

  // Track active containers and their idle timers
  private idleTimers: Map<string, NodeJS.Timeout> = new Map();

  constructor(options: DockerOrchestratorOptions) {
    this.workspaceBase = options.workspaceBase ?? join(homedir(), ".cikada", "workspaces");
    this.imageName = options.imageName ?? "claude-code:local";
    this.idleTimeoutMs = options.idleTimeoutMs ?? 10 * 60 * 1000; // 10 min
    this.cikadaApiUrl = options.cikadaApiUrl;
    this.anthropicApiKey = options.anthropicApiKey;
    this.broadcast = options.broadcast;

    // Initialize state store
    const dbPath = join(homedir(), ".cikada", "container-state.db");
    this.stateStore = new ContainerStateStore(dbPath);

    // Ensure workspace base exists
    if (!existsSync(this.workspaceBase)) {
      mkdirSync(this.workspaceBase, { recursive: true });
    }

    console.log(`[DockerOrchestrator] Workspace base: ${this.workspaceBase}`);
    console.log(`[DockerOrchestrator] Image: ${this.imageName}`);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Send a message to a thread's container.
   * Starts container if not running.
   * @param threadId - Thread identifier (usually channelId:agentName)
   * @param content - Message content
   * @param options - Optional channel/callsign and MCP configuration
   */
  async sendMessage(
    threadId: string,
    content: string,
    options?: SendMessageOptions
  ): Promise<void> {
    console.log(`[DockerOrchestrator] Processing message for thread ${threadId}`);

    // Get current container state
    let state = this.stateStore.getState(threadId);

    // Check if container is running
    if (state && state.status === "running") {
      // Verify container is still actually running
      if (this.isContainerRunning(state.containerId)) {
        console.log(`[DockerOrchestrator] Container running, forwarding message`);
        await this.forwardMessage(state.port, threadId, content, options?.mcpServers, options?.systemPrompt);
        this.resetIdleTimer(threadId, state.containerId);
        return;
      } else {
        // Container died - mark as stopped
        console.log(`[DockerOrchestrator] Container ${state.containerId} not running, cleaning up`);
        this.stateStore.setStatus(threadId, "stopped");
        state = this.stateStore.getState(threadId);
      }
    }

    // Need to start a new container
    console.log(`[DockerOrchestrator] Starting new container for thread ${threadId}`);

    // Broadcast status
    await this.broadcastStatus(threadId, "container_starting");

    // Clean up old container if exists
    if (state?.containerId) {
      this.stopContainer(state.containerId);
    }

    // Start new container with MCP options
    const info = await this.startContainer(threadId, options);

    // Wait for container to be healthy
    await this.waitForHealthy(info.port);

    // Update state
    this.stateStore.setState(threadId, {
      containerId: info.containerId,
      port: info.port,
      status: "running",
    });

    // Broadcast ready
    await this.broadcastStatus(threadId, "container_ready");

    // Forward message with MCP configs and system prompt
    await this.forwardMessage(info.port, threadId, content, options?.mcpServers, options?.systemPrompt);

    // Start idle timer
    this.resetIdleTimer(threadId, info.containerId);
  }

  /**
   * Stop a thread's container.
   */
  async stopThread(threadId: string, reason?: string): Promise<void> {
    const state = this.stateStore.getState(threadId);
    if (!state) {
      console.log(`[DockerOrchestrator] No container for thread ${threadId}`);
      return;
    }

    console.log(`[DockerOrchestrator] Stopping container for ${threadId}: ${reason ?? "manual"}`);

    // Clear idle timer
    this.clearIdleTimer(threadId);

    // Stop container
    this.stopContainer(state.containerId);

    // Update state
    this.stateStore.setStatus(threadId, "stopped");
  }

  /**
   * Get container status for a thread.
   */
  getStatus(threadId: string): ContainerState | null {
    return this.stateStore.getState(threadId);
  }

  /**
   * Clean up all resources.
   */
  async shutdown(): Promise<void> {
    console.log(`[DockerOrchestrator] Shutting down...`);

    // Clear all idle timers
    for (const [threadId] of this.idleTimers) {
      this.clearIdleTimer(threadId);
    }

    // Stop all running containers
    const states = this.stateStore.getAllRunning();
    for (const state of states) {
      this.stopContainer(state.containerId);
      this.stateStore.setStatus(state.threadId, "stopped");
    }

    // Close database
    this.stateStore.close();
  }

  // ---------------------------------------------------------------------------
  // Container Management
  // ---------------------------------------------------------------------------

  private async startContainer(
    threadId: string,
    options?: { spaceId?: string; channelId?: string; callsign?: string; authToken?: string }
  ): Promise<ContainerInfo> {
    // Create workspace directory with space isolation
    // Path: workspaceBase / spaceId / channelId-callsign (or sanitized threadId fallback)
    let workspacePath: string;
    if (options?.spaceId && options?.channelId && options?.callsign) {
      // Structured path for multi-tenancy: spaceId/channelId-callsign
      workspacePath = join(this.workspaceBase, options.spaceId, `${options.channelId}-${options.callsign}`);
    } else {
      // Fallback: sanitize threadId (colons are interpreted as volume mode specifiers by Docker)
      const sanitizedThreadId = threadId.replace(/:/g, '-');
      workspacePath = join(this.workspaceBase, sanitizedThreadId);
    }

    if (!existsSync(workspacePath)) {
      mkdirSync(workspacePath, { recursive: true });
    }

    // Find available port
    const port = await this.findAvailablePort();

    // Transform localhost to host.docker.internal for container networking
    // This allows the container to call back to the host machine
    const containerApiUrl = this.cikadaApiUrl.replace(
      /localhost|127\.0\.0\.1/,
      "host.docker.internal"
    );

    // Build docker run command
    const args = [
      "run",
      "-d", // detached
      "--rm", // remove on exit
      "--name", `claude-code-${this.hashThreadId(threadId)}`,
      "-p", `${port}:8080`,
      "-v", `${workspacePath}:/workspace`,
      "-e", `ANTHROPIC_API_KEY=${this.anthropicApiKey}`,
      "-e", `CIKADA_API_URL=${containerApiUrl}`,
      "-e", `THREAD_ID=${threadId}`,
      "-e", `IDLE_TIMEOUT_MS=${this.idleTimeoutMs}`,
    ];

    // Add space and channel context for cikada-artifacts MCP
    if (options?.spaceId) {
      args.push("-e", `CIKADA_SPACE_ID=${options.spaceId}`);
    }
    if (options?.channelId) {
      args.push("-e", `CIKADA_CHANNEL_ID=${options.channelId}`);
    }
    if (options?.callsign) {
      args.push("-e", `CIKADA_CALLSIGN=${options.callsign}`);
    }
    // Auth token for container to authenticate with server
    if (options?.authToken) {
      args.push("-e", `CIKADA_AUTH_TOKEN=${options.authToken}`);
    }

    // Add image name at the end
    args.push(this.imageName);

    console.log(`[DockerOrchestrator] Starting container on port ${port}`);

    // Run docker
    const result = execSync(`docker ${args.join(" ")}`, {
      encoding: "utf-8",
      timeout: 30000,
    }).trim();

    const containerId = result.substring(0, 12);

    console.log(`[DockerOrchestrator] Container started: ${containerId}`);

    return {
      containerId,
      port,
      status: "starting",
    };
  }

  private stopContainer(containerId: string): void {
    try {
      execSync(`docker stop ${containerId}`, {
        timeout: 10000,
        stdio: "ignore",
      });
      console.log(`[DockerOrchestrator] Container stopped: ${containerId}`);
    } catch (error) {
      // Container may already be stopped
      console.log(`[DockerOrchestrator] Container stop failed (may be already stopped): ${containerId}`);
    }
  }

  private isContainerRunning(containerId: string): boolean {
    try {
      const result = execSync(`docker inspect -f '{{.State.Running}}' ${containerId}`, {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "ignore"],
      }).trim();
      return result === "true";
    } catch {
      return false;
    }
  }

  private async waitForHealthy(port: number, timeoutMs = 60000): Promise<void> {
    const startTime = Date.now();
    const healthUrl = `http://localhost:${port}/health`;

    console.log(`[DockerOrchestrator] Waiting for container health at ${healthUrl}`);

    while (Date.now() - startTime < timeoutMs) {
      try {
        const response = await fetch(healthUrl, { method: "GET" });
        if (response.ok) {
          console.log(`[DockerOrchestrator] Container healthy after ${Date.now() - startTime}ms`);
          return;
        }
      } catch {
        // Not ready yet
      }
      await this.sleep(500);
    }

    throw new Error(`Container health check timed out after ${timeoutMs}ms`);
  }

  private async forwardMessage(
    port: number,
    threadId: string,
    content: string,
    mcpServers?: McpServerConfig[],
    systemPrompt?: string
  ): Promise<void> {
    const url = `http://localhost:${port}/message`;

    // Build request body - include resolvedMcps and systemPrompt if provided
    const body: { content: string; threadId: string; resolvedMcps?: McpServerConfig[]; systemPrompt?: string } = {
      content,
      threadId,
    };
    if (mcpServers && mcpServers.length > 0) {
      body.resolvedMcps = mcpServers;
    }
    if (systemPrompt) {
      body.systemPrompt = systemPrompt;
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to forward message: ${response.status} ${error}`);
    }

    console.log(`[DockerOrchestrator] Message forwarded to container`);
  }

  // ---------------------------------------------------------------------------
  // Idle Timer Management
  // ---------------------------------------------------------------------------

  private resetIdleTimer(threadId: string, containerId: string): void {
    this.clearIdleTimer(threadId);

    const timer = setTimeout(() => {
      console.log(`[DockerOrchestrator] Idle timeout for thread ${threadId}`);
      this.stopThread(threadId, "idle timeout");
    }, this.idleTimeoutMs);

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
  // Status Broadcasting
  // ---------------------------------------------------------------------------

  private async broadcastStatus(
    threadId: string,
    status: "container_starting" | "container_ready" | "container_error"
  ): Promise<void> {
    if (!this.broadcast) return;

    const frame = JSON.stringify({
      i: this.generateUlid(),
      t: new Date().toISOString(),
      v: {
        type: "status",
        content: status,
      },
    });

    await this.broadcast(threadId, frame);
  }

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  private async findAvailablePort(): Promise<number> {
    // Start from 8081 and find an available port
    for (let port = 8081; port < 9000; port++) {
      try {
        const response = await fetch(`http://localhost:${port}/`, {
          method: "HEAD",
          signal: AbortSignal.timeout(100),
        });
        // Port is in use
      } catch (error) {
        // Port is likely available (connection refused)
        if (error instanceof Error && error.name === "AbortError") {
          continue; // Timeout, try next
        }
        return port;
      }
    }
    throw new Error("No available ports in range 8081-9000");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private generateUlid(): string {
    const timestamp = Date.now().toString(36).padStart(10, "0");
    const random = Math.random().toString(36).substring(2, 10);
    return `${timestamp}${random}`.toUpperCase();
  }

  /**
   * Hash thread ID to create a unique container name suffix.
   * Uses SHA-256 and takes first 12 chars of hex output.
   * This avoids ULID prefix collisions since ULIDs share timestamp prefixes.
   */
  private hashThreadId(threadId: string): string {
    return createHash("sha256").update(threadId).digest("hex").substring(0, 12);
  }
}
