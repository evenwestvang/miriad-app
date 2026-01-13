/**
 * Runtime Client
 *
 * Manages the WebSocket connection to the CAST backend.
 * Handles the LocalRuntime protocol: authentication, message routing,
 * and agent lifecycle coordination.
 */

import WebSocket from 'ws';
import { AgentManager } from './agent-manager.js';
import { getMachineInfo } from './config.js';
import type {
  RuntimeConfig,
  BackendToRuntimeMessage,
  RuntimeToBackendMessage,
  RuntimeReadyMessage,
  AgentCheckinMessage,
  AgentFrameMessage,
  PongMessage,
  ActivateAgentMessage,
  DeliverMessageMessage,
  SuspendAgentMessage,
} from './types.js';

// =============================================================================
// Types
// =============================================================================

export interface RuntimeClientConfig {
  config: RuntimeConfig;
  onConnected?: () => void;
  onDisconnected?: (code: number, reason: string) => void;
  onError?: (error: Error) => void;
}

export type RuntimeStatus = 'disconnected' | 'connecting' | 'connected' | 'ready';

// =============================================================================
// Runtime Client
// =============================================================================

export class RuntimeClient {
  private readonly runtimeConfig: RuntimeConfig;
  private readonly agentManager: AgentManager;

  private ws: WebSocket | null = null;
  private status: RuntimeStatus = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  private readonly onConnected?: () => void;
  private readonly onDisconnected?: (code: number, reason: string) => void;
  private readonly onError?: (error: Error) => void;

  constructor(config: RuntimeClientConfig) {
    this.runtimeConfig = config.config;
    this.onConnected = config.onConnected;
    this.onDisconnected = config.onDisconnected;
    this.onError = config.onError;

    // Create agent manager
    this.agentManager = new AgentManager({
      workspaceBasePath: this.runtimeConfig.workspace.basePath,
      onFrame: (message) => this.sendFrame(message),
      onCheckin: (agentId) => this.sendCheckin(agentId),
      onError: (agentId, error) => {
        console.error(`[RuntimeClient] Agent ${agentId} error:`, error);
      },
    });
  }

  /**
   * Get current runtime status.
   */
  getStatus(): RuntimeStatus {
    return this.status;
  }

  /**
   * Get agent manager for status queries.
   */
  getAgentManager(): AgentManager {
    return this.agentManager;
  }

  /**
   * Connect to the backend.
   */
  async connect(): Promise<void> {
    if (this.ws) {
      console.log('[RuntimeClient] Already connected');
      return;
    }

    this.status = 'connecting';
    const { credentials } = this.runtimeConfig;
    const url = `${credentials.wsUrl}/runtimes/connect`;

    console.log(`[RuntimeClient] Connecting to ${url}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Server ${credentials.secret}`,
        },
      });

      this.ws.on('open', () => {
        console.log('[RuntimeClient] Connected');
        this.status = 'connected';
        this.reconnectAttempts = 0;
        this.sendRuntimeReady();
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('close', (code, reason) => {
        console.log(`[RuntimeClient] Disconnected: ${code} ${reason.toString()}`);
        this.status = 'disconnected';
        this.ws = null;
        this.onDisconnected?.(code, reason.toString());
        this.scheduleReconnect();
      });

      this.ws.on('error', (error) => {
        console.error('[RuntimeClient] WebSocket error:', error);
        this.onError?.(error);
        if (this.status === 'connecting') {
          reject(error);
        }
      });
    });
  }

  /**
   * Disconnect from the backend.
   */
  async disconnect(): Promise<void> {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }

    // Suspend all agents
    await this.agentManager.suspendAll();

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }

    this.status = 'disconnected';
  }

  // ===========================================================================
  // Message Handling
  // ===========================================================================

  private handleMessage(data: string): void {
    let message: BackendToRuntimeMessage;
    try {
      message = JSON.parse(data);
    } catch {
      console.error('[RuntimeClient] Invalid JSON:', data);
      return;
    }

    switch (message.type) {
      case 'runtime_connected':
        console.log(`[RuntimeClient] Runtime connected: ${message.runtimeId} (protocol ${message.protocolVersion})`);
        this.status = 'ready';
        this.onConnected?.();
        // Re-checkin all active agents on reconnect
        // This ensures backend knows about agents that survived the disconnect
        this.reCheckinActiveAgents();
        break;

      case 'activate':
        this.handleActivate(message);
        break;

      case 'message':
        this.handleDeliverMessage(message);
        break;

      case 'suspend':
        this.handleSuspend(message);
        break;

      case 'ping':
        this.sendPong(message.timestamp);
        break;

      case 'error':
        console.error(`[RuntimeClient] Backend error: ${message.code} - ${message.message}`);
        break;

      default:
        console.log(`[RuntimeClient] Unknown message type: ${(message as { type: string }).type}`);
    }
  }

  private async handleActivate(message: ActivateAgentMessage): Promise<void> {
    console.log(`[RuntimeClient] Activate agent: ${message.agentId}`);
    await this.agentManager.activate(message);
  }

  private async handleDeliverMessage(message: DeliverMessageMessage): Promise<void> {
    console.log(`[RuntimeClient] Message for agent: ${message.agentId}`);
    await this.agentManager.deliverMessage(message);
  }

  private async handleSuspend(message: SuspendAgentMessage): Promise<void> {
    console.log(`[RuntimeClient] Suspend agent: ${message.agentId}`);
    await this.agentManager.suspend(message);
  }

  // ===========================================================================
  // Outgoing Messages
  // ===========================================================================

  private send(message: RuntimeToBackendMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      console.error('[RuntimeClient] Cannot send: WebSocket not open');
    }
  }

  private sendRuntimeReady(): void {
    const { credentials, spaceId, name } = this.runtimeConfig;
    const machineInfo = getMachineInfo();

    const message: RuntimeReadyMessage = {
      type: 'runtime_ready',
      runtimeId: credentials.runtimeId,
      spaceId,
      name,
      machineInfo,
    };

    console.log(`[RuntimeClient] Sending runtime_ready: ${name} (${credentials.runtimeId})`);
    this.send(message);
  }

  private sendCheckin(agentId: string): void {
    const message: AgentCheckinMessage = {
      type: 'agent_checkin',
      agentId,
    };
    console.log(`[RuntimeClient] Agent checkin: ${agentId}`);
    this.send(message);
  }

  private sendFrame(frameMessage: AgentFrameMessage): void {
    this.send(frameMessage);
  }

  private sendPong(timestamp: string): void {
    const message: PongMessage = {
      type: 'pong',
      timestamp,
    };
    this.send(message);
  }

  /**
   * Re-checkin all active agents after reconnection.
   * This notifies the backend about agents that survived the disconnect.
   */
  private reCheckinActiveAgents(): void {
    const agents = this.agentManager.getAgents();
    const activeAgents = agents.filter((a) => a.status !== 'offline');

    if (activeAgents.length === 0) {
      console.log('[RuntimeClient] No active agents to re-checkin');
      return;
    }

    console.log(`[RuntimeClient] Re-checking in ${activeAgents.length} active agent(s)`);
    for (const agent of activeAgents) {
      this.sendCheckin(agent.agentId);
    }
  }

  // ===========================================================================
  // Reconnection
  // ===========================================================================

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    console.log(`[RuntimeClient] Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      try {
        await this.connect();
      } catch (error) {
        console.error('[RuntimeClient] Reconnection failed:', error);
        // Will be scheduled again by close handler
      }
    }, delay);
  }
}
