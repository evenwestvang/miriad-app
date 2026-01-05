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

// DynamoDB-backed implementation for AWS Lambda
export {
  createDynamoDBConnectionManager,
  addConnectionAsync,
  removeConnectionAsync,
  getConnectionAsync,
  type DynamoDBConnectionManagerOptions,
} from './dynamodb-connection-manager.js';
