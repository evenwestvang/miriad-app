/**
 * WebSocket module
 *
 * Connection management and broadcasting for Tymbal streaming.
 */

export {
  createConnectionManager,
  createChannelBroadcaster,
  type ConnectionInfo,
  type ConnectionManager,
  type ConnectionManagerOptions,
} from './connection-manager.js';
