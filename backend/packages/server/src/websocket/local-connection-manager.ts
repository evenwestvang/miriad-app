/**
 * Local Connection Manager
 *
 * Adapter for local dev server that bridges the old callback-based interface
 * to the new Postgres-backed ConnectionManager.
 *
 * This handles:
 * - Taking WebSocket objects and setting up event handlers
 * - Parsing Tymbal frames and calling back with sync requests
 * - Managing WebSocket instances via WebSocketSender
 * - Delegating state management to PostgresConnectionManager
 */

import { WebSocket } from 'ws';
import { parseFrame, isSyncRequest, type TymbalFrame } from '@cast/core';
import type { Storage } from '@cast/storage';
import { createPostgresConnectionManager, type PostgresConnectionManager, type ConnectionInfo } from './postgres-connection-manager.js';
import { WebSocketSender } from './message-sender.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Extended connection info that includes the WebSocket instance.
 * Compatible with the old ConnectionInfo interface.
 */
export interface LocalConnectionInfo extends ConnectionInfo {
  /** Unique connection ID */
  id: string;
  /** WebSocket instance */
  ws: WebSocket;
}

/**
 * Options for creating the local connection manager.
 */
export interface LocalConnectionManagerOptions {
  /** Storage instance for database operations */
  storage: Storage;
  /** Handler for sync requests (channelId is the requested channel, may differ from current) */
  onSyncRequest?: (
    connection: LocalConnectionInfo,
    channelId: string,
    since?: string,
    before?: string,
    limit?: number
  ) => Promise<void>;
  /** Handler for incoming frames from containers */
  onFrame?: (
    connection: LocalConnectionInfo,
    frame: TymbalFrame
  ) => Promise<void>;
  /** Handler for connection close */
  onClose?: (connection: LocalConnectionInfo) => void;
  /** Handler for connection errors */
  onError?: (connection: LocalConnectionInfo, error: Error) => void;
}

/**
 * Local connection manager interface.
 * Compatible with the old ConnectionManager but backed by Postgres.
 */
export interface LocalConnectionManager {
  /** Add a connection to a channel */
  addConnection(
    ws: WebSocket,
    channelId: string,
    options?: {
      agentCallsign?: string;
      containerId?: string;
    }
  ): LocalConnectionInfo;

  /** Remove a connection */
  removeConnection(connectionId: string): void;

  /** Switch a connection to a different channel */
  switchChannel(connectionId: string, newChannelId: string): LocalConnectionInfo | undefined;

  /** Get all connections for a channel */
  getChannelConnections(channelId: string): LocalConnectionInfo[];

  /** Get connection by ID */
  getConnection(connectionId: string): LocalConnectionInfo | undefined;

  /** Broadcast a frame to all connections in a channel */
  broadcast(channelId: string, frame: string): Promise<void>;

  /** Send a frame to a specific connection */
  send(connectionId: string, frame: string): Promise<void>;

  /** Get total connection count */
  getConnectionCount(): number;

  /** Get connection count for a channel */
  getChannelConnectionCount(channelId: string): number;

  /** Close all connections (for shutdown) */
  closeAll(): void;

  /** Initialize (creates table, must be called before use) */
  initialize(): Promise<void>;
}

// =============================================================================
// Implementation
// =============================================================================

let connectionCounter = 0;

function generateConnectionId(): string {
  return `conn_${Date.now()}_${++connectionCounter}`;
}

/**
 * Create a local connection manager that bridges the old interface
 * to the new Postgres-backed implementation.
 */
export function createLocalConnectionManager(
  options: LocalConnectionManagerOptions
): LocalConnectionManager {
  const { storage, onSyncRequest, onFrame, onClose, onError } = options;

  // Create WebSocket sender for local dev
  const sender = new WebSocketSender();

  // Create Postgres-backed manager using Storage
  let pgManager: PostgresConnectionManager | null = null;

  // In-memory map of connectionId -> LocalConnectionInfo
  // This holds the WebSocket references and extended session data
  const connections = new Map<string, LocalConnectionInfo>();

  // Channel -> connectionIds for sync operations (before Postgres is queried)
  const channelConnections = new Map<string, Set<string>>();

  function addToChannel(channelId: string, connectionId: string): void {
    let channelSet = channelConnections.get(channelId);
    if (!channelSet) {
      channelSet = new Set();
      channelConnections.set(channelId, channelSet);
    }
    channelSet.add(connectionId);
  }

  function removeFromChannel(channelId: string, connectionId: string): void {
    const channelSet = channelConnections.get(channelId);
    if (channelSet) {
      channelSet.delete(connectionId);
      if (channelSet.size === 0) {
        channelConnections.delete(channelId);
      }
    }
  }

  // Get or create the Postgres manager
  function getPgManager(): PostgresConnectionManager {
    if (!pgManager) {
      pgManager = createPostgresConnectionManager({
        storage,
        sender,
      });
    }
    return pgManager;
  }

  return {
    addConnection(ws, channelId, opts = {}) {
      const connectionId = generateConnectionId();

      const info: LocalConnectionInfo = {
        id: connectionId,
        connectionId, // For compatibility with ConnectionRecord
        ws,
        channelId,
        agentCallsign: opts.agentCallsign,
        containerId: opts.containerId,
        connectedAt: new Date(),
      };

      // Store in memory
      connections.set(connectionId, info);
      addToChannel(channelId, connectionId);

      // Register WebSocket with sender
      sender.register(connectionId, ws);

      // Persist to Postgres (async, fire-and-forget for initial sync)
      const mgr = getPgManager();
      mgr.addConnection(connectionId, channelId, opts).catch(err => {
        console.error('[LocalConnectionManager] Failed to persist connection:', err);
      });

      // Set up WebSocket event handlers
      ws.on('message', async (data) => {
        try {
          const message = data.toString();
          const frame = parseFrame(message);

          if (!frame) {
            // Invalid frame, ignore
            return;
          }

          // Handle sync requests (may include channel switch)
          if (isSyncRequest(frame)) {
            // Pass requested channelId to handler for authorization
            // The handler is responsible for calling switchChannel after auth
            const requestedChannelId = frame.channelId || info.channelId;
            if (onSyncRequest) {
              await onSyncRequest(info, requestedChannelId, frame.since, frame.before, frame.limit);
            }
            return;
          }

          // Handle other frames
          if (onFrame) {
            await onFrame(info, frame);
          }
        } catch (error) {
          console.error('[LocalConnectionManager] Error handling message:', error);
          if (onError) {
            onError(info, error instanceof Error ? error : new Error(String(error)));
          }
        }
      });

      ws.on('close', () => {
        this.removeConnection(connectionId);
        if (onClose) {
          onClose(info);
        }
      });

      ws.on('error', (error) => {
        console.error('[LocalConnectionManager] WebSocket error:', error);
        if (onError) {
          onError(info, error);
        }
      });

      return info;
    },

    removeConnection(connectionId) {
      const info = connections.get(connectionId);
      if (info) {
        removeFromChannel(info.channelId, connectionId);
        connections.delete(connectionId);
        sender.unregister(connectionId);

        // Close the WebSocket if still open
        if (info.ws.readyState === WebSocket.OPEN) {
          info.ws.close();
        }

        // Remove from Postgres (async)
        const mgr = getPgManager();
        mgr.removeConnection(connectionId).catch(err => {
          console.error('[LocalConnectionManager] Failed to remove connection from Postgres:', err);
        });
      }
    },

    switchChannel(connectionId, newChannelId) {
      const info = connections.get(connectionId);
      if (!info) return undefined;

      const oldChannelId = info.channelId;
      if (oldChannelId === newChannelId) return info; // No change needed

      // Move connection from old channel to new channel
      removeFromChannel(oldChannelId, connectionId);
      info.channelId = newChannelId;
      addToChannel(newChannelId, connectionId);

      // Update in Postgres (async)
      const mgr = getPgManager();
      mgr.switchChannel(connectionId, newChannelId).catch(err => {
        console.error('[LocalConnectionManager] Failed to switch channel in Postgres:', err);
      });

      console.log(`[LocalConnectionManager] Switched connection ${connectionId} from ${oldChannelId} to ${newChannelId}`);
      return info;
    },

    getChannelConnections(channelId) {
      const channelSet = channelConnections.get(channelId);
      if (!channelSet) return [];

      return Array.from(channelSet)
        .map((id) => connections.get(id))
        .filter((info): info is LocalConnectionInfo => info !== undefined);
    },

    getConnection(connectionId) {
      return connections.get(connectionId);
    },

    async broadcast(channelId, frame) {
      const channelSet = channelConnections.get(channelId);
      if (!channelSet) return;

      const promises: Promise<void>[] = [];

      for (const connectionId of channelSet) {
        const info = connections.get(connectionId);
        if (info && info.ws.readyState === WebSocket.OPEN) {
          promises.push(
            new Promise((resolve, reject) => {
              info.ws.send(frame, (err) => {
                if (err) {
                  console.error(`[LocalConnectionManager] Send error to ${connectionId}:`, err);
                  reject(err);
                } else {
                  resolve();
                }
              });
            })
          );
        }
      }

      // Wait for all sends to complete (ignore individual failures)
      await Promise.allSettled(promises);
    },

    async send(connectionId, frame) {
      const info = connections.get(connectionId);
      if (!info || info.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Connection ${connectionId} not found or not open`);
      }

      return new Promise((resolve, reject) => {
        info.ws.send(frame, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },

    getConnectionCount() {
      return connections.size;
    },

    getChannelConnectionCount(channelId) {
      const channelSet = channelConnections.get(channelId);
      return channelSet?.size ?? 0;
    },

    closeAll() {
      for (const info of connections.values()) {
        if (info.ws.readyState === WebSocket.OPEN) {
          info.ws.close();
        }
        sender.unregister(info.connectionId);
      }
      connections.clear();
      channelConnections.clear();

      // Close the connection manager (but not storage - that's shared)
      if (pgManager) {
        pgManager.close().catch(err => {
          console.error('[LocalConnectionManager] Failed to close connection manager:', err);
        });
      }
    },

    async initialize() {
      // Storage should be initialized by caller, connection manager is ready immediately
      getPgManager();
      console.log('[LocalConnectionManager] Initialized');
    },
  };
}
