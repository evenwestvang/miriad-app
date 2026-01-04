/**
 * @cast/storage - Storage interface and implementations
 *
 * PostgreSQL storage using @neondatabase/serverless for PlanetScale.
 */

// Interface
export type { Storage } from './interface.js';

// Implementations
export { createPostgresStorage } from './postgres.js';
export type { PostgresStorageOptions } from './postgres.js';
