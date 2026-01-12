/**
 * Runtime Connection Manager
 *
 * Manages WebSocket connections from local runtimes.
 * Handles the WS transport layer for LocalRuntime - connection lifecycle,
 * message routing, and runtime/agent state updates.
 *
 * Protocol: See [[local-provider-spec]] section 2.2
 *
 * Deployment Note:
 * This requires a persistent WebSocket server (long-running process).
 * Works with: Node.js server (dev.ts), EC2, ECS, Fargate
 * Does NOT work with: AWS Lambda (Lambda's invoke model is incompatible
 * with persistent bidirectional WebSocket connections)
 */

import type { WebSocket } from 'ws';
import {
  isSetFrame,
  tymbal,
  generateMessageId,
  type TymbalFrame,
  type SetFrame,
} from '@cast/core';
import type { Storage } from '@cast/storage';
import type { StoredRuntime, LocalRuntimeConfig } from '@cast/core';
import { AgentStateManager, parseAgentId, LocalRuntime, createLocalRuntime } from '@cast/runtime';
import type { ConnectionManager } from '../websocket/index.js';
import { createServerAuthVerifier, type ServerAuthResult } from '../handlers/runtime-auth.js';
import type { RuntimeRegistry } from '../agents/runtime-registry.js';

// =============================================================================
// Protocol Message Types (from spec section 2.2)
// =============================================================================

/** Protocol version */
const PROTOCOL_VERSION = '1.0';

// Backend → Runtime (Commands)

export interface RuntimeConnectedMessage {
  type: 'runtime_connected';
  runtimeId: string;
  protocolVersion: string;
}

export interface ActivateAgentMessage {
  type: 'activate';
  agentId: string;
  systemPrompt: string;
  mcpServers?: McpServerConfig[];
  workspacePath: string;
}

export interface DeliverMessageMessage {
  type: 'message';
  agentId: string;
  messageId: string;
  content: string;
  sender: string;
  systemPrompt?: string;
}

export interface SuspendAgentMessage {
  type: 'suspend';
  agentId: string;
  reason?: string;
}

export interface PingMessage {
  type: 'ping';
  timestamp: string;
}

export type BackendToRuntimeMessage =
  | RuntimeConnectedMessage
  | ActivateAgentMessage
  | DeliverMessageMessage
  | SuspendAgentMessage
  | PingMessage;

// Runtime → Backend (Responses & Events)

export interface RuntimeReadyMessage {
  type: 'runtime_ready';
  runtimeId: string;
  spaceId: string;
  name: string;
  machineInfo?: {
    os: string;
    hostname: string;
  };
}

export interface AgentCheckinMessage {
  type: 'agent_checkin';
  agentId: string;
}

export interface AgentFrameMessage {
  type: 'frame';
  agentId: string;
  frame: TymbalFrame;
}

export interface PongMessage {
  type: 'pong';
  timestamp: string;
}

export type RuntimeToBackendMessage =
  | RuntimeReadyMessage
  | AgentCheckinMessage
  | AgentFrameMessage
  | PongMessage;

// MCP Server Config (matches @cast/runtime)
interface McpServerConfig {
  name: string;
  slug?: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

// =============================================================================
// Connection State
// =============================================================================

interface RuntimeConnection {
  ws: WebSocket;
  runtimeId: string | null;
  spaceId: string | null;
  serverAuth: ServerAuthResult | null;
  connectedAt: Date;
  lastPong: Date;
}

// =============================================================================
// RuntimeConnectionManager Interface
// =============================================================================

export interface RuntimeConnectionManagerOptions {
  storage: Storage;
  connectionManager: ConnectionManager;
  agentStateManager: AgentStateManager;
  runtimeRegistry?: RuntimeRegistry;
  requireAuth?: boolean;
  pingIntervalMs?: number;
}

export interface RuntimeConnectionManager {
  /** Handle new WS connection from local runtime */
  handleConnection(ws: WebSocket, authHeader?: string): Promise<void>;

  /** Send command to runtime's WS connection */
  sendCommand(runtimeId: string, command: BackendToRuntimeMessage): boolean;

  /** Get online runtimes for a space */
  getOnlineRuntimes(spaceId: string): StoredRuntime[];

  /** Check if specific runtime is online */
  isRuntimeOnline(runtimeId: string): boolean;

  /** Get agent state manager (for LocalRuntime to use) */
  getAgentStateManager(): AgentStateManager;

  /** Close all connections (for shutdown) */
  closeAll(): void;
}

// =============================================================================
// Implementation
// =============================================================================

export function createRuntimeConnectionManager(
  options: RuntimeConnectionManagerOptions
): RuntimeConnectionManager {
  const {
    storage,
    connectionManager,
    agentStateManager,
    runtimeRegistry,
    requireAuth = false,
    pingIntervalMs = 30000,
  } = options;

  // Auth verifier
  const verifyServerAuth = createServerAuthVerifier(storage);

  // Track connections by runtimeId
  const runtimeConnections = new Map<string, RuntimeConnection>();

  // Track pending connections (before runtime_ready)
  const pendingConnections = new Set<RuntimeConnection>();

  // Ping interval handle
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  // Self-reference for LocalRuntime's connectionManager requirement
  // These are defined before the object is returned, allowing LocalRuntime to call them
  const selfRef = {
    sendCommand: (runtimeId: string, command: BackendToRuntimeMessage): boolean => {
      const connection = runtimeConnections.get(runtimeId);
      if (!connection) return false;
      return send(connection.ws, command);
    },
    isRuntimeOnline: (runtimeId: string): boolean => {
      return runtimeConnections.has(runtimeId);
    },
  };

  // ==========================================================================
  // Helper Functions
  // ==========================================================================

  function send(ws: WebSocket, message: BackendToRuntimeMessage): boolean {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function sendError(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', code, message }));
    }
  }

  // ==========================================================================
  // Message Handlers
  // ==========================================================================

  async function handleRuntimeReady(
    connection: RuntimeConnection,
    message: RuntimeReadyMessage
  ): Promise<void> {
    const { runtimeId, spaceId, name, machineInfo } = message;

    // Validate required fields
    if (!runtimeId || !spaceId || !name) {
      sendError(connection.ws, 'INVALID_MESSAGE', 'runtimeId, spaceId, and name are required');
      return;
    }

    // If auth required, verify server credentials match space
    if (requireAuth && connection.serverAuth) {
      if (connection.serverAuth.spaceId !== spaceId) {
        sendError(connection.ws, 'SPACE_MISMATCH', 'Server credentials do not match spaceId');
        connection.ws.close(4003, 'Space mismatch');
        return;
      }
    }

    try {
      // Check if runtime already exists
      let runtime = await storage.getRuntime(runtimeId);

      const config: LocalRuntimeConfig = {
        wsConnectionId: `ws_${Date.now()}`,
        machineInfo,
      };

      if (runtime) {
        // Update existing runtime
        await storage.updateRuntime(runtimeId, {
          name,
          status: 'online',
          config,
          lastSeenAt: new Date().toISOString(),
        });
        console.log(`[RuntimeConnectionManager] Runtime reconnected: ${runtimeId} (${name})`);
      } else {
        // Create new runtime
        runtime = await storage.createRuntime({
          id: runtimeId,
          spaceId,
          serverId: connection.serverAuth?.serverId,
          name,
          type: 'local',
          status: 'online',
          config,
        });
        console.log(`[RuntimeConnectionManager] New runtime registered: ${runtimeId} (${name})`);
      }

      // Update connection state
      connection.runtimeId = runtimeId;
      connection.spaceId = spaceId;

      // Move from pending to active
      pendingConnections.delete(connection);
      runtimeConnections.set(runtimeId, connection);

      // Create and register LocalRuntime instance if registry provided
      if (runtimeRegistry) {
        const localRuntime = createLocalRuntime({
          runtimeId,
          spaceId,
          connectionManager: selfRef,
          stateManager: agentStateManager,
        });
        runtimeRegistry.registerLocalRuntime(runtimeId, localRuntime);
      }

      // Send confirmation
      send(connection.ws, {
        type: 'runtime_connected',
        runtimeId,
        protocolVersion: PROTOCOL_VERSION,
      });
    } catch (error) {
      console.error('[RuntimeConnectionManager] Error handling runtime_ready:', error);
      sendError(connection.ws, 'REGISTRATION_FAILED', 'Failed to register runtime');
    }
  }

  async function handleAgentCheckin(
    connection: RuntimeConnection,
    message: AgentCheckinMessage
  ): Promise<void> {
    const { agentId } = message;

    if (!connection.runtimeId) {
      sendError(connection.ws, 'NOT_REGISTERED', 'Must send runtime_ready first');
      return;
    }

    try {
      // Update agent state
      const newState = agentStateManager.handleCheckin(agentId);

      // Parse agent ID to get channel
      const { channelId, callsign } = parseAgentId(agentId);

      // Broadcast status to channel
      const statusFrame = tymbal.set(generateMessageId(), {
        type: 'status',
        sender: callsign,
        senderType: 'agent',
        content: `online`,
      });
      await connectionManager.broadcast(channelId, JSON.stringify(statusFrame));

      console.log(`[RuntimeConnectionManager] Agent checkin: ${agentId} -> ${newState.status}`);
    } catch (error) {
      console.error('[RuntimeConnectionManager] Error handling agent_checkin:', error);
    }
  }

  async function handleFrame(
    connection: RuntimeConnection,
    message: AgentFrameMessage
  ): Promise<void> {
    const { agentId, frame } = message;

    if (!connection.runtimeId) {
      sendError(connection.ws, 'NOT_REGISTERED', 'Must send runtime_ready first');
      return;
    }

    try {
      const { channelId, callsign } = parseAgentId(agentId);

      // Determine if this is an idle frame
      const isIdle = isIdleFrame(frame);

      // Update agent state (busy/online based on frame type)
      agentStateManager.handleFrame(agentId, isIdle);

      // Broadcast frame to channel
      const serialized = JSON.stringify(frame);
      await connectionManager.broadcast(channelId, serialized);

      // Persist SetFrames as messages (skip cost frames)
      if (isSetFrame(frame)) {
        await persistSetFrame(connection, channelId, callsign, frame);
      }
    } catch (error) {
      console.error('[RuntimeConnectionManager] Error handling frame:', error);
    }
  }

  function handlePong(connection: RuntimeConnection, _message: PongMessage): void {
    connection.lastPong = new Date();
  }

  // ==========================================================================
  // Frame Persistence
  // ==========================================================================

  async function persistSetFrame(
    connection: RuntimeConnection,
    channelId: string,
    callsign: string,
    frame: SetFrame
  ): Promise<void> {
    try {
      const channel = await storage.getChannelById(channelId);
      if (!channel || !frame.v || typeof frame.v !== 'object') return;

      const value = frame.v as Record<string, unknown>;
      const messageType = (value.type as string) ?? 'agent';

      // Handle cost frames - persist to costs table
      if (messageType === 'cost') {
        await storage.saveCostRecord({
          spaceId: channel.spaceId,
          channelId,
          callsign: (value.sender as string) ?? callsign,
          costUsd: value.totalCostUsd as number,
          durationMs: value.durationMs as number,
          numTurns: value.numTurns as number,
          usage: value.usage as {
            inputTokens: number;
            outputTokens: number;
            cacheReadInputTokens: number;
            cacheCreationInputTokens: number;
          },
          modelUsage: value.modelUsage as
            | Record<
                string,
                {
                  inputTokens: number;
                  outputTokens: number;
                  cacheReadInputTokens: number;
                  cacheCreationInputTokens: number;
                  costUsd: number;
                }
              >
            | undefined,
        });
        return;
      }

      // For tool_call and tool_result, store full value as JSON
      let messageContent: string | Record<string, unknown>;
      if (messageType === 'tool_call' || messageType === 'tool_result') {
        messageContent = JSON.stringify(value);
      } else {
        messageContent = (value.content as string | Record<string, unknown>) ?? value;
      }

      await storage.saveMessage({
        id: frame.i,
        spaceId: channel.spaceId,
        channelId,
        sender: (value.sender as string) ?? callsign,
        senderType: 'agent',
        type: messageType as
          | 'user'
          | 'agent'
          | 'tool_call'
          | 'tool_result'
          | 'thinking'
          | 'status'
          | 'error'
          | 'idle',
        content: messageContent,
        isComplete: true,
        metadata: { fromLocalRuntime: true, runtimeId: connection.runtimeId },
      });
    } catch (error) {
      console.error('[RuntimeConnectionManager] Error persisting frame:', error);
    }
  }

  function isIdleFrame(frame: TymbalFrame): boolean {
    if (!isSetFrame(frame)) return false;
    const value = frame.v as Record<string, unknown> | undefined;
    return value?.type === 'idle';
  }

  // ==========================================================================
  // Disconnect Handler
  // ==========================================================================

  async function handleDisconnect(connection: RuntimeConnection): Promise<void> {
    pendingConnections.delete(connection);

    if (!connection.runtimeId) return;

    const runtimeId = connection.runtimeId;
    runtimeConnections.delete(runtimeId);

    // Unregister LocalRuntime from registry
    if (runtimeRegistry) {
      runtimeRegistry.unregisterLocalRuntime(runtimeId);
    }

    try {
      // Mark runtime as offline
      await storage.updateRuntime(runtimeId, {
        status: 'offline',
        config: { wsConnectionId: null },
      });

      // Mark all agents on this runtime as offline
      // Get all online agents from state manager and filter by runtime
      const onlineAgents = agentStateManager.getAllOnline();
      for (const agentState of onlineAgents) {
        // Check if this agent is bound to this runtime
        const { channelId, callsign } = parseAgentId(agentState.agentId);
        const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);

        if (rosterEntry?.runtimeId === runtimeId) {
          // Mark agent as offline
          agentStateManager.handleSuspend(agentState.agentId);

          // Broadcast offline status
          const statusFrame = tymbal.set(generateMessageId(), {
            type: 'status',
            sender: callsign,
            senderType: 'agent',
            content: `offline (runtime disconnected)`,
          });
          await connectionManager.broadcast(channelId, JSON.stringify(statusFrame));
        }
      }

      console.log(`[RuntimeConnectionManager] Runtime disconnected: ${runtimeId}`);
    } catch (error) {
      console.error('[RuntimeConnectionManager] Error handling disconnect:', error);
    }
  }

  // ==========================================================================
  // Ping/Pong Heartbeat
  // ==========================================================================

  function startPingInterval(): void {
    if (pingInterval) return;

    pingInterval = setInterval(() => {
      const now = new Date();
      const timestamp = now.toISOString();

      for (const [runtimeId, connection] of runtimeConnections) {
        // Check for stale connection (no pong in 2 intervals)
        const staleness = now.getTime() - connection.lastPong.getTime();
        if (staleness > pingIntervalMs * 2) {
          console.log(`[RuntimeConnectionManager] Runtime ${runtimeId} stale, disconnecting`);
          connection.ws.close(4000, 'Ping timeout');
          continue;
        }

        send(connection.ws, { type: 'ping', timestamp });
      }
    }, pingIntervalMs);
  }

  function stopPingInterval(): void {
    if (pingInterval) {
      clearInterval(pingInterval);
      pingInterval = null;
    }
  }

  // Start ping interval
  startPingInterval();

  // ==========================================================================
  // Public Interface
  // ==========================================================================

  return {
    async handleConnection(ws: WebSocket, authHeader?: string): Promise<void> {
      // Parse server auth from Authorization header
      const serverAuth = authHeader ? await verifyServerAuth(authHeader) : null;

      // If auth required but no valid server auth, reject
      if (requireAuth && !serverAuth) {
        sendError(ws, 'AUTH_REQUIRED', 'Server authentication required');
        ws.close(4001, 'Authentication required');
        console.log('[RuntimeConnectionManager] Connection rejected: no valid server auth');
        return;
      }

      const connection: RuntimeConnection = {
        ws,
        runtimeId: null,
        spaceId: null,
        serverAuth,
        connectedAt: new Date(),
        lastPong: new Date(),
      };

      pendingConnections.add(connection);

      console.log(
        `[RuntimeConnectionManager] New connection${serverAuth ? ` (server: ${serverAuth.serverId})` : ' (dev mode)'}`
      );

      // Handle incoming messages
      ws.on('message', async (data) => {
        try {
          const message = JSON.parse(data.toString()) as RuntimeToBackendMessage;

          switch (message.type) {
            case 'runtime_ready':
              await handleRuntimeReady(connection, message);
              break;

            case 'agent_checkin':
              await handleAgentCheckin(connection, message);
              break;

            case 'frame':
              await handleFrame(connection, message);
              break;

            case 'pong':
              handlePong(connection, message);
              break;

            default:
              sendError(ws, 'INVALID_MESSAGE', `Unknown message type: ${(message as { type: string }).type}`);
          }
        } catch (error) {
          console.error('[RuntimeConnectionManager] Message handling error:', error);
          sendError(ws, 'INVALID_MESSAGE', 'Failed to parse message');
        }
      });

      // Handle disconnection
      ws.on('close', () => {
        handleDisconnect(connection);
      });

      // Handle errors
      ws.on('error', (error) => {
        console.error('[RuntimeConnectionManager] WebSocket error:', error);
        handleDisconnect(connection);
      });
    },

    sendCommand(runtimeId: string, command: BackendToRuntimeMessage): boolean {
      const connection = runtimeConnections.get(runtimeId);
      if (!connection) {
        console.log(`[RuntimeConnectionManager] Cannot send command: runtime ${runtimeId} not connected`);
        return false;
      }
      return send(connection.ws, command);
    },

    getOnlineRuntimes(spaceId: string): StoredRuntime[] {
      // This would need to query storage for full runtime records
      // For now, return empty - caller should use storage.getRuntimesBySpace
      console.log(`[RuntimeConnectionManager] getOnlineRuntimes called for space ${spaceId}`);
      return [];
    },

    isRuntimeOnline(runtimeId: string): boolean {
      return runtimeConnections.has(runtimeId);
    },

    getAgentStateManager(): AgentStateManager {
      return agentStateManager;
    },

    closeAll(): void {
      stopPingInterval();

      for (const connection of pendingConnections) {
        if (connection.ws.readyState === connection.ws.OPEN) {
          connection.ws.close();
        }
      }
      pendingConnections.clear();

      for (const connection of runtimeConnections.values()) {
        if (connection.ws.readyState === connection.ws.OPEN) {
          connection.ws.close();
        }
      }
      runtimeConnections.clear();
    },
  };
}
