/**
 * @cikada/storage
 *
 * Storage adapters for the Cikada platform.
 *
 * Usage:
 * ```ts
 * // SQLite for local development
 * import { createSqliteStorage } from '@cikada/storage/sqlite';
 * const storage = createSqliteStorage({ path: './data.db' });
 *
 * // DynamoDB for AWS production
 * import { createDynamoDbStorage } from '@cikada/storage/dynamodb';
 * const storage = createDynamoDbStorage({
 *   region: 'us-east-1',
 *   tableName: 'cikada-main',
 * });
 * ```
 */

export type {
  Storage,
  CreateChannelParams,
  ListChannelsParams,
  GetMessagesParams,
  StorageOptions,
} from './interface.js';

export { createSqliteStorage, type SqliteStorageOptions } from './sqlite/index.js';
export { createDynamoDbStorage, type DynamoDbStorageOptions } from './dynamodb/index.js';

// Factory function for convenience
import type { StorageOptions, Storage } from './interface.js';
import { createSqliteStorage } from './sqlite/index.js';
import { createDynamoDbStorage } from './dynamodb/index.js';

export function createStorage(options: StorageOptions): Storage {
  switch (options.type) {
    case 'sqlite':
      if (!options.sqlite?.path) {
        throw new Error('sqlite.path is required for SQLite storage');
      }
      return createSqliteStorage({ path: options.sqlite.path });

    case 'dynamodb':
      if (!options.dynamodb?.region || !options.dynamodb?.tableName) {
        throw new Error('dynamodb.region and dynamodb.tableName are required');
      }
      return createDynamoDbStorage({
        region: options.dynamodb.region,
        tableName: options.dynamodb.tableName,
        endpoint: options.dynamodb.endpoint,
      });

    default:
      throw new Error(`Unknown storage type: ${(options as StorageOptions).type}`);
  }
}
