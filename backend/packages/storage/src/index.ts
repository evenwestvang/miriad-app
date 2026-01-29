/**
 * @cast/storage - Storage interface and implementations
 *
 * PostgreSQL storage using @neondatabase/serverless for PlanetScale.
 */

// Interface
export type {
  Storage,
  SetSecretInput,
  MessageDeliveryContext,
  RosterWithRuntime,
  AgentDefinitionSummary,
  EnvironmentArtifactData,
  McpArtifactData,
  StoredSecret,
} from './interface.js';

// Re-export types from @cast/core used by storage consumers
export type { StoredConnection } from '@cast/core';

// Implementations
export { createPostgresStorage } from './postgres.js';
export type { PostgresStorageOptions } from './postgres.js';
