/**
 * WebSocket module
 *
 * Connection management and broadcasting for Tymbal streaming.
 */

// Legacy in-memory implementation (kept for tests, will be removed)
export {
  createConnectionManager,
  createChannelBroadcaster,
  type ConnectionInfo,
  type ConnectionManager,
  type ConnectionManagerOptions,
} from './connection-manager.js';

// Unified Postgres-backed implementation
export {
  createPostgresConnectionManager,
  type PostgresConnectionManager,
  type PostgresConnectionManagerOptions,
  type ConnectionRecord,
  type ConnectionInfo as PgConnectionInfo,
} from './postgres-connection-manager.js';

// Local dev adapter (bridges old interface to Postgres)
export {
  createLocalConnectionManager,
  type LocalConnectionManager,
  type LocalConnectionManagerOptions,
  type LocalConnectionInfo,
} from './local-connection-manager.js';

// Message sender interface and implementations
export {
  type MessageSender,
  WebSocketSender,
  ApiGatewaySender,
  type ApiGatewaySenderOptions,
} from './message-sender.js';
