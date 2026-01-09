/**
 * WebSocket Connection Manager
 *
 * Manages WebSocket connections organized by channel.
 * Provides broadcast capabilities for Tymbal frames.
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import { parseFrame, isSyncRequest, type TymbalFrame } from '@cast/core';

// =============================================================================
// Types
// =============================================================================

export interface ConnectionInfo {
  /** Unique connection ID */
  id: string;
  /** WebSocket instance */
  ws: WebSocket;
  /** Channel this connection is subscribed to */
  channelId: string;
  /** Optional agent callsign (for container connections) */
  agentCallsign?: string;
  /** Optional container ID (for container connections) */
  containerId?: string;
  /** Connection timestamp */
  connectedAt: Date;
}

export interface ConnectionManagerOptions {
  /** Handler for sync requests (channelId is the requested channel, may differ from current) */
  onSyncRequest?: (
    connection: ConnectionInfo,
    channelId: string,
    since?: string,
    before?: string,
    limit?: number
  ) => Promise<void>;
  /** Handler for incoming frames from containers */
  onFrame?: (
    connection: ConnectionInfo,
    frame: TymbalFrame
  ) => Promise<void>;
  /** Handler for connection close */
  onClose?: (connection: ConnectionInfo) => void;
  /** Handler for connection errors */
  onError?: (connection: ConnectionInfo, error: Error) => void;
}

export interface ConnectionManager {
  /** Add a connection to a channel */
  addConnection(
    ws: WebSocket,
    channelId: string,
    options?: {
      agentCallsign?: string;
      containerId?: string;
    }
  ): ConnectionInfo;

  /** Remove a connection */
  removeConnection(connectionId: string): void;

  /** Switch a connection to a different channel */
  switchChannel(connectionId: string, newChannelId: string): ConnectionInfo | undefined;

  /** Get all connections for a channel */
  getChannelConnections(channelId: string): ConnectionInfo[];

  /** Get connection by ID */
  getConnection(connectionId: string): ConnectionInfo | undefined;

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
}

// =============================================================================
// Implementation
// =============================================================================

let connectionCounter = 0;

function generateConnectionId(): string {
  return `conn_${Date.now()}_${++connectionCounter}`;
}

export function createConnectionManager(
  options: ConnectionManagerOptions = {}
): ConnectionManager {
  const { onSyncRequest, onFrame, onClose, onError } = options;

  // Connection storage
  const connections = new Map<string, ConnectionInfo>();
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

  return {
    addConnection(ws, channelId, opts = {}) {
      const connectionId = generateConnectionId();
      const info: ConnectionInfo = {
        id: connectionId,
        ws,
        channelId,
        agentCallsign: opts.agentCallsign,
        containerId: opts.containerId,
        connectedAt: new Date(),
      };

      connections.set(connectionId, info);
      addToChannel(channelId, connectionId);

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
          console.error('[ConnectionManager] Error handling message:', error);
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
        console.error('[ConnectionManager] WebSocket error:', error);
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

        // Close the WebSocket if still open
        if (info.ws.readyState === WebSocket.OPEN) {
          info.ws.close();
        }
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

      console.log(`[ConnectionManager] Switched connection ${connectionId} from ${oldChannelId} to ${newChannelId}`);
      return info;
    },

    getChannelConnections(channelId) {
      const channelSet = channelConnections.get(channelId);
      if (!channelSet) return [];

      return Array.from(channelSet)
        .map((id) => connections.get(id))
        .filter((info): info is ConnectionInfo => info !== undefined);
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
                  console.error(`[ConnectionManager] Send error to ${connectionId}:`, err);
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
      }
      connections.clear();
      channelConnections.clear();
    },
  };
}

// =============================================================================
// Broadcast Helper
// =============================================================================

/**
 * Create a broadcast function for a specific channel.
 * This is the function signature expected by TymbalFrameHandler.
 */
export function createChannelBroadcaster(
  manager: ConnectionManager,
  channelId: string
): (frame: string) => Promise<void> {
  return (frame: string) => manager.broadcast(channelId, frame);
}
