/**
 * Runtime Connection Manager
 *
 * Manages WebSocket connections from local runtimes.
 * Thin transport adapter that delegates business logic to shared handlers.
 *
 * Protocol: See [[local-provider-spec]] section 2.2
 *
 * This module handles:
 * - WebSocket lifecycle (connect, disconnect, message routing)
 * - Ping/pong heartbeat for connection health (local dev only)
 *
 * Business logic (protocol handling, persistence) is in runtime-protocol-handlers.ts
 * which is shared between local dev and AWS Lambda.
 *
 * Message routing goes through the DB-based path in invoker-adapter.ts:
 * - invoker-adapter queries storage.getRuntime() to get wsConnectionId
 * - Uses connectionManager.send(wsConnectionId) to deliver messages
 * - This ensures Lambda and local dev use identical routing logic
 *
 * Deployment Note:
 * This requires a persistent WebSocket server (long-running process).
 * Works with: Node.js server (dev.ts), EC2, ECS, Fargate
 * Does NOT work with: AWS Lambda (use websocket-handlers.ts instead)
 */

import type { WebSocket } from 'ws';
import type { Storage } from '@cast/storage';
import type { StoredRuntime } from '@cast/core';
import { AgentStateManager, parseAgentId } from '@cast/runtime';
import type { ConnectionManager } from '../websocket/index.js';
import { createServerAuthVerifier, type ServerAuthResult } from '../handlers/runtime-auth.js';

// Re-export protocol message types from runtime-protocol-handlers
// (those are now the source of truth for the protocol types)
export {
  PROTOCOL_VERSION,
  type RuntimeConnectedMessage,
  type ActivateAgentMessage,
  type DeliverMessageMessage,
  type SuspendAgentMessage,
  type PingMessage,
  type BackendToRuntimeMessage,
  type RuntimeReadyMessage,
  type AgentCheckinMessage,
  type AgentHeartbeatMessage,
  type AgentFrameMessage,
  type PongMessage,
  type RuntimeToBackendMessage,
  type McpServerConfig,
} from './runtime-protocol-handlers.js';

import {
  PROTOCOL_VERSION,
  createRuntimeProtocolHandlers,
  type RuntimeConnectionState,
  type RuntimeToBackendMessage,
  type BackendToRuntimeMessage,
  type PongMessage,
} from './runtime-protocol-handlers.js';

// =============================================================================
// Connection State (local dev only - holds WebSocket reference)
// =============================================================================

interface RuntimeConnection {
  ws: WebSocket;
  connectionId: string;
  runtimeId: string | null;
  spaceId: string | null;
  serverAuth: ServerAuthResult | null;
  connectedAt: Date;
  lastPong: Date;
}

// Counter for generating unique connection IDs in local dev
let connectionCounter = 0;

// =============================================================================
// RuntimeConnectionManager Interface
// =============================================================================

export interface RuntimeConnectionManagerOptions {
  storage: Storage;
  connectionManager: ConnectionManager;
  agentStateManager: AgentStateManager;
  requireAuth?: boolean;
  pingIntervalMs?: number;
}

export interface RuntimeConnectionManager {
  /** Handle new WS connection from local runtime */
  handleConnection(ws: WebSocket, authHeader?: string): Promise<void>;

  /** Send command to runtime's WS connection */
  sendCommand(runtimeId: string, command: BackendToRuntimeMessage): boolean;

  /** Send raw data to a runtime connection by connectionId (for invoker-adapter) */
  send(connectionId: string, data: string): Promise<boolean>;

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
    requireAuth = false,
    pingIntervalMs = 30000,
  } = options;

  // Auth verifier
  const verifyServerAuth = createServerAuthVerifier(storage);

  // Track connections by runtimeId (local dev only - holds WS references)
  const runtimeConnections = new Map<string, RuntimeConnection>();

  // Track pending connections (before runtime_ready)
  const pendingConnections = new Set<RuntimeConnection>();

  // Track connections by connectionId for send()
  const connectionsByConnId = new Map<string, RuntimeConnection>();

  // Ping interval handle
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  // ==========================================================================
  // Helper Functions (transport layer)
  // ==========================================================================

  function sendToWs(ws: WebSocket, message: BackendToRuntimeMessage): boolean {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(message));
      return true;
    }
    return false;
  }

  function sendErrorToWs(ws: WebSocket, code: string, message: string): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({ type: 'error', code, message }));
    }
  }

  // ==========================================================================
  // Create Shared Protocol Handlers
  // ==========================================================================

  const protocolHandlers = createRuntimeProtocolHandlers({
    storage,
    broadcast: async (channelId: string, data: string) => {
      await connectionManager.broadcast(channelId, data);
    },
    send: async (connectionId: string, data: string): Promise<boolean> => {
      const connection = connectionsByConnId.get(connectionId);
      if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
        return false;
      }
      connection.ws.send(data);
      return true;
    },
    sendError: async (connectionId: string, code: string, message: string): Promise<void> => {
      const connection = connectionsByConnId.get(connectionId);
      if (connection) {
        sendErrorToWs(connection.ws, code, message);
      }
    },
  });

  // ==========================================================================
  // Local Dev Extensions (on top of shared handlers)
  // ==========================================================================

  /**
   * Handle runtime_ready with local dev extensions:
   * - Space auth validation
   * - AgentStateManager integration
   *
   * Note: Runtime state is persisted to DB by the shared handler.
   * Message routing uses DB-based lookup (storage.getRuntime → wsConnectionId).
   */
  async function handleRuntimeReadyWithExtensions(
    connection: RuntimeConnection,
    message: RuntimeToBackendMessage & { type: 'runtime_ready' }
  ): Promise<void> {
    const { runtimeId, spaceId, name } = message;

    // If auth required, verify server credentials match space
    if (requireAuth && connection.serverAuth) {
      if (connection.serverAuth.spaceId !== spaceId) {
        sendErrorToWs(connection.ws, 'SPACE_MISMATCH', 'Server credentials do not match spaceId');
        connection.ws.close(4003, 'Space mismatch');
        return;
      }
    }

    // Build connection state for shared handlers
    const state: RuntimeConnectionState = {
      connectionId: connection.connectionId,
      channelId: '__pending__',
      protocol: 'runtime',
      runtimeId: null,
      spaceId: null,
      serverId: connection.serverAuth?.serverId,
    };

    // Call shared handler (persists to DB with wsConnectionId)
    const result = await protocolHandlers.handleRuntimeReady(state, message);

    if (result.success && result.runtimeId) {
      // Update local connection state
      connection.runtimeId = result.runtimeId;
      connection.spaceId = spaceId;

      // Move from pending to active (for ping/pong and closeAll)
      pendingConnections.delete(connection);
      runtimeConnections.set(result.runtimeId, connection);

      console.log(`[RuntimeConnectionManager] Runtime registered: ${result.runtimeId} (${name})`);
    }
  }

  /**
   * Handle agent_checkin with local dev extensions:
   * - AgentStateManager integration
   */
  async function handleAgentCheckinWithExtensions(
    connection: RuntimeConnection,
    message: RuntimeToBackendMessage & { type: 'agent_checkin' }
  ): Promise<void> {
    if (!connection.runtimeId) {
      sendErrorToWs(connection.ws, 'NOT_REGISTERED', 'Must send runtime_ready first');
      return;
    }

    // Update local agent state manager
    const newState = agentStateManager.handleCheckin(message.agentId);
    console.log(`[RuntimeConnectionManager] Agent checkin: ${message.agentId} -> ${newState.status}`);

    // Call shared handler for DB updates and broadcast
    const state: RuntimeConnectionState = {
      connectionId: connection.connectionId,
      channelId: '__pending__',
      protocol: 'runtime',
      runtimeId: connection.runtimeId,
      spaceId: connection.spaceId,
    };
    await protocolHandlers.handleAgentCheckin(state, message);
  }

  /**
   * Handle agent_heartbeat with local dev extensions:
   * - AgentStateManager integration
   */
  async function handleAgentHeartbeatWithExtensions(
    connection: RuntimeConnection,
    message: RuntimeToBackendMessage & { type: 'agent_heartbeat' }
  ): Promise<void> {
    if (!connection.runtimeId) {
      sendErrorToWs(connection.ws, 'NOT_REGISTERED', 'Must send runtime_ready first');
      return;
    }

    // Update local agent state manager
    agentStateManager.handleHeartbeat(message.agentId);

    // Call shared handler for DB updates and broadcast
    const state: RuntimeConnectionState = {
      connectionId: connection.connectionId,
      channelId: '__pending__',
      protocol: 'runtime',
      runtimeId: connection.runtimeId,
      spaceId: connection.spaceId,
    };
    await protocolHandlers.handleAgentHeartbeat(state, message);
  }

  /**
   * Handle frame with local dev extensions:
   * - AgentStateManager integration (idle detection)
   */
  async function handleFrameWithExtensions(
    connection: RuntimeConnection,
    message: RuntimeToBackendMessage & { type: 'frame' }
  ): Promise<void> {
    if (!connection.runtimeId) {
      sendErrorToWs(connection.ws, 'NOT_REGISTERED', 'Must send runtime_ready first');
      return;
    }

    const { agentId, frame } = message;

    // Update local agent state manager (idle detection)
    const value = (frame as { v?: Record<string, unknown> }).v;
    const isIdle = value?.type === 'idle';
    agentStateManager.handleFrame(agentId, isIdle);

    // Call shared handler for broadcast and persistence
    const state: RuntimeConnectionState = {
      connectionId: connection.connectionId,
      channelId: '__pending__',
      protocol: 'runtime',
      runtimeId: connection.runtimeId,
      spaceId: connection.spaceId,
    };
    await protocolHandlers.handleFrame(state, message);
  }

  /**
   * Handle pong - local dev only (ping/pong heartbeat)
   * Updates both in-memory lastPong and persists lastSeenAt to DB
   * so the frontend staleness check works correctly.
   */
  async function handlePong(connection: RuntimeConnection, _message: PongMessage): Promise<void> {
    connection.lastPong = new Date();

    // Persist lastSeenAt to DB so frontend staleness check works
    if (connection.runtimeId) {
      await storage.updateRuntime(connection.runtimeId, {
        lastSeenAt: new Date().toISOString(),
      });
    }
  }

  // ==========================================================================
  // Disconnect Handler
  // ==========================================================================

  async function handleDisconnect(connection: RuntimeConnection): Promise<void> {
    pendingConnections.delete(connection);
    connectionsByConnId.delete(connection.connectionId);

    if (!connection.runtimeId) return;

    const runtimeId = connection.runtimeId;
    runtimeConnections.delete(runtimeId);

    // Mark agents as offline in local state manager
    const onlineAgents = agentStateManager.getAllOnline();
    for (const agentState of onlineAgents) {
      const { channelId, callsign } = parseAgentId(agentState.agentId);
      const rosterEntry = await storage.getRosterByCallsign(channelId, callsign);
      if (rosterEntry?.runtimeId === runtimeId) {
        agentStateManager.handleSuspend(agentState.agentId);
      }
    }

    // Call shared handler for DB updates and broadcast
    await protocolHandlers.handleDisconnect(runtimeId);

    console.log(`[RuntimeConnectionManager] Runtime disconnected: ${runtimeId}`);
  }

  // ==========================================================================
  // Ping/Pong Heartbeat (local dev only - API Gateway handles this in Lambda)
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

        sendToWs(connection.ws, { type: 'ping', timestamp });
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
      // Generate unique connection ID for local dev
      const connectionId = `local_${++connectionCounter}_${Date.now()}`;

      // Create connection object immediately (serverAuth will be set after async check)
      const connection: RuntimeConnection = {
        ws,
        connectionId,
        runtimeId: null,
        spaceId: null,
        serverAuth: null,
        connectedAt: new Date(),
        lastPong: new Date(),
      };

      // Track by connectionId for send() calls from shared handlers
      connectionsByConnId.set(connectionId, connection);

      // Queue to hold messages received before auth completes
      const messageQueue: string[] = [];
      let authComplete = false;

      // Register message handler IMMEDIATELY to capture early messages
      ws.on('message', async (data) => {
        const dataStr = data.toString();
        if (!authComplete) {
          // Queue messages until auth is complete
          messageQueue.push(dataStr);
          console.log('[RuntimeConnectionManager] Message queued (auth pending):', dataStr.slice(0, 100));
          return;
        }
        await processMessage(dataStr);
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

      // Now do async auth check
      const serverAuth = authHeader ? await verifyServerAuth(authHeader) : null;

      // If auth required but no valid server auth, reject
      if (requireAuth && !serverAuth) {
        sendErrorToWs(ws, 'AUTH_REQUIRED', 'Server authentication required');
        ws.close(4001, 'Authentication required');
        connectionsByConnId.delete(connectionId);
        console.log('[RuntimeConnectionManager] Connection rejected: no valid server auth');
        return;
      }

      // Update connection with auth result
      connection.serverAuth = serverAuth;
      pendingConnections.add(connection);

      console.log(
        `[RuntimeConnectionManager] New connection ${connectionId}${serverAuth ? ` (server: ${serverAuth.serverId})` : ' (dev mode)'}`
      );

      // Mark auth as complete and process queued messages
      authComplete = true;
      for (const queuedData of messageQueue) {
        console.log('[RuntimeConnectionManager] Processing queued message:', queuedData.slice(0, 100));
        await processMessage(queuedData);
      }

      // Message processor function - routes to shared handlers with local extensions
      async function processMessage(dataStr: string): Promise<void> {
        console.log('[RuntimeConnectionManager] Received message:', dataStr.slice(0, 200));
        try {
          const message = JSON.parse(dataStr) as RuntimeToBackendMessage;
          console.log('[RuntimeConnectionManager] Parsed message type:', message.type);

          switch (message.type) {
            case 'runtime_ready':
              await handleRuntimeReadyWithExtensions(connection, message);
              break;

            case 'agent_checkin':
              await handleAgentCheckinWithExtensions(connection, message);
              break;

            case 'agent_heartbeat':
              await handleAgentHeartbeatWithExtensions(connection, message);
              break;

            case 'frame':
              await handleFrameWithExtensions(connection, message);
              break;

            case 'pong':
              await handlePong(connection, message);
              break;

            default:
              sendErrorToWs(ws, 'INVALID_MESSAGE', `Unknown message type: ${(message as { type: string }).type}`);
          }
        } catch (error) {
          console.error('[RuntimeConnectionManager] Message handling error:', error);
          sendErrorToWs(ws, 'INVALID_MESSAGE', 'Failed to parse message');
        }
      }
    },

    sendCommand(runtimeId: string, command: BackendToRuntimeMessage): boolean {
      const connection = runtimeConnections.get(runtimeId);
      if (!connection) {
        console.log(`[RuntimeConnectionManager] Cannot send command: runtime ${runtimeId} not connected`);
        return false;
      }
      return sendToWs(connection.ws, command);
    },

    async send(connectionId: string, data: string): Promise<boolean> {
      const connection = connectionsByConnId.get(connectionId);
      if (!connection || connection.ws.readyState !== connection.ws.OPEN) {
        console.log(`[RuntimeConnectionManager] Cannot send: connection ${connectionId} not found or not open`);
        return false;
      }
      connection.ws.send(data);
      return true;
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
      connectionsByConnId.clear();
    },
  };
}
