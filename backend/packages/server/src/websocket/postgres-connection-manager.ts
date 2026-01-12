/**
 * Postgres-backed Connection Manager
 *
 * Unified connection manager that uses the Storage interface for state storage.
 * Works identically in local dev and Lambda - only the MessageSender differs.
 *
 * Key features:
 * - Storage abstraction handles connection state (connectionId, channelId, metadata)
 * - MessageSender handles platform-specific message delivery
 * - Self-healing: stale connections cleaned up when send() returns false
 * - Supports '__pending__' channelId for connect-first-auth-later flow
 */

import type { Storage, StoredConnection } from '@cast/storage';
import type { MessageSender } from './message-sender.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Connection record from storage.
 * Re-exported for compatibility with existing code.
 */
export interface ConnectionRecord {
  connectionId: string;
  channelId: string;
  connectedAt: Date;
  agentCallsign?: string;
  containerId?: string;
}

/**
 * Extended connection info with optional session data.
 * Used by local dev to attach auth session to connections.
 */
export interface ConnectionInfo extends ConnectionRecord {
  /** Optional session data (for local dev auth) */
  session?: { userId: string; spaceId: string };
  /** Cached authorized channels (for local dev) */
  authorizedChannels?: Set<string>;
}

/**
 * Options for creating a PostgresConnectionManager.
 */
export interface PostgresConnectionManagerOptions {
  /** Storage instance for database operations */
  storage: Storage;
  /** Message sender implementation (WebSocketSender or ApiGatewaySender) */
  sender: MessageSender;
  /** Handler for incoming messages (optional) */
  onMessage?: (connectionId: string, data: string) => Promise<void>;
}

/**
 * Postgres Connection Manager interface.
 */
export interface PostgresConnectionManager {
  /** Add a connection with initial channelId (use '__pending__' for deferred auth) */
  addConnection(connectionId: string, channelId: string, options?: {
    agentCallsign?: string;
    containerId?: string;
  }): Promise<ConnectionInfo>;

  /** Remove a connection */
  removeConnection(connectionId: string): Promise<void>;

  /** Switch a connection to a different channel */
  switchChannel(connectionId: string, newChannelId: string): Promise<ConnectionInfo | null>;

  /** Get a connection by ID */
  getConnection(connectionId: string): Promise<ConnectionInfo | null>;

  /** Get all connections for a channel */
  getChannelConnections(channelId: string): Promise<ConnectionRecord[]>;

  /** Broadcast a message to all connections in a channel */
  broadcast(channelId: string, data: string): Promise<void>;

  /** Send a message to a specific connection */
  send(connectionId: string, data: string): Promise<boolean>;

  /** Get the message sender (for registering/unregistering WebSocket instances) */
  getSender(): MessageSender;

  /** Initialize is no longer needed - Storage handles table creation */
  initialize(): Promise<void>;

  /** Close all connections and cleanup */
  close(): Promise<void>;
}

// =============================================================================
// Helper: Convert StoredConnection to ConnectionRecord
// =============================================================================

function storedToRecord(stored: StoredConnection): ConnectionRecord {
  return {
    connectionId: stored.connectionId,
    channelId: stored.channelId,
    connectedAt: new Date(stored.connectedAt),
    agentCallsign: stored.agentCallsign,
    containerId: stored.containerId,
  };
}

// =============================================================================
// Implementation
// =============================================================================

/**
 * Create a Postgres-backed ConnectionManager using the Storage interface.
 *
 * @param options - Configuration options
 * @returns ConnectionManager instance
 */
export function createPostgresConnectionManager(
  options: PostgresConnectionManagerOptions
): PostgresConnectionManager {
  const { storage, sender, onMessage } = options;

  // In-memory cache for extended connection info (session, authorizedChannels)
  // This is local to each server instance - not shared across Lambda invocations
  const connectionCache = new Map<string, ConnectionInfo>();

  // ---------------------------------------------------------------------------
  // Implementation
  // ---------------------------------------------------------------------------

  return {
    async addConnection(connectionId, channelId, opts = {}) {
      await storage.saveConnection(connectionId, channelId, {
        agentCallsign: opts.agentCallsign,
        containerId: opts.containerId,
      });

      const info: ConnectionInfo = {
        connectionId,
        channelId,
        connectedAt: new Date(),
        agentCallsign: opts.agentCallsign,
        containerId: opts.containerId,
      };

      // Cache the connection info
      connectionCache.set(connectionId, info);

      console.log(`[ConnectionManager] Added connection ${connectionId} to channel ${channelId}`);
      return info;
    },

    async removeConnection(connectionId) {
      await storage.deleteConnection(connectionId);

      // Remove from cache
      connectionCache.delete(connectionId);

      // Unregister from sender (no-op for ApiGatewaySender)
      sender.unregister?.(connectionId);

      console.log(`[ConnectionManager] Removed connection ${connectionId}`);
    },

    async switchChannel(connectionId, newChannelId) {
      await storage.updateConnectionChannel(connectionId, newChannelId);

      // Update cache
      const cached = connectionCache.get(connectionId);
      if (cached) {
        cached.channelId = newChannelId;
        console.log(`[ConnectionManager] Switched ${connectionId} to channel ${newChannelId}`);
        return cached;
      }

      // Fetch from storage if not cached
      const stored = await storage.getConnection(connectionId);
      if (!stored) {
        console.warn(`[ConnectionManager] Connection ${connectionId} not found for channel switch`);
        return null;
      }

      const record = storedToRecord(stored);
      connectionCache.set(connectionId, record);
      console.log(`[ConnectionManager] Switched ${connectionId} to channel ${newChannelId}`);
      return record;
    },

    async getConnection(connectionId) {
      // Check cache first
      const cached = connectionCache.get(connectionId);
      if (cached) {
        return cached;
      }

      // Query storage
      const stored = await storage.getConnection(connectionId);
      if (!stored) {
        return null;
      }

      return storedToRecord(stored);
    },

    async getChannelConnections(channelId) {
      const stored = await storage.getConnectionsByChannel(channelId);
      return stored.map(storedToRecord);
    },

    async broadcast(channelId, data) {
      const connections = await this.getChannelConnections(channelId);

      if (connections.length === 0) {
        return;
      }

      const results = await Promise.allSettled(
        connections.map(async (conn) => {
          const success = await sender.send(conn.connectionId, data);
          if (!success) {
            // Connection is stale, clean it up
            console.log(`[ConnectionManager] Cleaning up stale connection ${conn.connectionId}`);
            await this.removeConnection(conn.connectionId);
          }
          return success;
        })
      );

      const succeeded = results.filter(
        (r) => r.status === 'fulfilled' && r.value
      ).length;
      const failed = connections.length - succeeded;

      if (failed > 0) {
        console.log(
          `[ConnectionManager] Broadcast to ${channelId}: ${succeeded}/${connections.length} succeeded, ${failed} stale removed`
        );
      }
    },

    async send(connectionId, data) {
      const success = await sender.send(connectionId, data);
      if (!success) {
        // Connection is stale, clean it up
        console.log(`[ConnectionManager] Cleaning up stale connection ${connectionId}`);
        await this.removeConnection(connectionId);
      }
      return success;
    },

    getSender() {
      return sender;
    },

    async initialize() {
      // No-op: Storage.initialize() handles table creation
      // This method is kept for interface compatibility
      console.log('[ConnectionManager] Initialized (using Storage for persistence)');
    },

    async close() {
      // Clear cache
      connectionCache.clear();

      // Note: Don't close storage here - it's shared and should be closed by the caller
      console.log('[ConnectionManager] Closed');
    },
  };
}
