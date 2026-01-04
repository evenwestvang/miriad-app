/**
 * Auth State Storage Interface
 *
 * Abstraction for storing OAuth PKCE state.
 * Implementations: in-memory (local dev), DynamoDB (AWS Lambda).
 */

import type { PendingSanityAuthState } from './sanity-auth.js';

// =============================================================================
// Interface
// =============================================================================

/**
 * Storage interface for OAuth pending states.
 */
export interface AuthStateStorage {
  /**
   * Save a pending auth state.
   * @param state - The state key (random string)
   * @param data - The pending state data
   * @param ttlMs - Time-to-live in milliseconds
   */
  save(state: string, data: PendingSanityAuthState, ttlMs: number): Promise<void>;

  /**
   * Get and delete a pending auth state (one-time use).
   * @param state - The state key
   * @returns The pending state data, or null if not found/expired
   */
  getAndDelete(state: string): Promise<PendingSanityAuthState | null>;

  /**
   * Clear all states (for testing).
   */
  clear(): Promise<void>;

  /**
   * Get count of pending states (for monitoring).
   */
  count(): Promise<number>;
}

// =============================================================================
// In-Memory Implementation (for local development)
// =============================================================================

/**
 * In-memory auth state storage.
 * Suitable for local development where Lambda statelessness isn't an issue.
 */
export function createInMemoryAuthStateStorage(): AuthStateStorage {
  const states = new Map<string, { data: PendingSanityAuthState; expiresAt: number }>();

  // Cleanup expired states periodically
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of states) {
      if (now > entry.expiresAt) {
        states.delete(key);
      }
    }
  }, 60 * 1000); // Every minute

  // Allow cleanup to be stopped (for testing)
  if (typeof cleanupInterval.unref === 'function') {
    cleanupInterval.unref();
  }

  return {
    async save(state: string, data: PendingSanityAuthState, ttlMs: number): Promise<void> {
      states.set(state, {
        data,
        expiresAt: Date.now() + ttlMs,
      });
    },

    async getAndDelete(state: string): Promise<PendingSanityAuthState | null> {
      const entry = states.get(state);
      if (!entry) {
        return null;
      }

      // Delete immediately (one-time use)
      states.delete(state);

      // Check expiry
      if (Date.now() > entry.expiresAt) {
        return null;
      }

      return entry.data;
    },

    async clear(): Promise<void> {
      states.clear();
    },

    async count(): Promise<number> {
      return states.size;
    },
  };
}

// =============================================================================
// DynamoDB Implementation (for AWS Lambda)
// =============================================================================

export interface DynamoDBAuthStateStorageOptions {
  /** DynamoDB DocumentClient */
  client: {
    send: (command: unknown) => Promise<unknown>;
  };
  /** Table name */
  tableName: string;
}

/**
 * DynamoDB auth state storage.
 * Stores PKCE state in DynamoDB with TTL for automatic expiration.
 */
export function createDynamoDBAuthStateStorage(options: DynamoDBAuthStateStorageOptions): AuthStateStorage {
  const { client, tableName } = options;

  // Import DynamoDB commands dynamically to avoid bundling issues
  // when using in-memory storage. Types are 'any' to avoid compile-time
  // dependency on @aws-sdk/lib-dynamodb (only needed at runtime on AWS).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PutCommand: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GetCommand: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let DeleteCommand: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ScanCommand: any;

  const ensureCommands = async () => {
    if (!PutCommand) {
      // Dynamic import - only loads on AWS Lambda where the SDK is available
      const lib = await import('@aws-sdk/lib-dynamodb');
      PutCommand = lib.PutCommand;
      GetCommand = lib.GetCommand;
      DeleteCommand = lib.DeleteCommand;
      ScanCommand = lib.ScanCommand;
    }
  };

  return {
    async save(state: string, data: PendingSanityAuthState, ttlMs: number): Promise<void> {
      await ensureCommands();

      const ttlSeconds = Math.floor((Date.now() + ttlMs) / 1000);

      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: `authstate#${state}`,
            state,
            data: JSON.stringify(data),
            ttl: ttlSeconds,
            createdAt: new Date().toISOString(),
          },
        })
      );
    },

    async getAndDelete(state: string): Promise<PendingSanityAuthState | null> {
      await ensureCommands();

      // Get the item
      const result = await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: `authstate#${state}` },
        })
      ) as { Item?: { data: string; ttl: number } };

      if (!result.Item) {
        return null;
      }

      // Delete immediately (one-time use)
      await client.send(
        new DeleteCommand({
          TableName: tableName,
          Key: { pk: `authstate#${state}` },
        })
      );

      // Check TTL (DynamoDB TTL is eventually consistent, so double-check)
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (result.Item.ttl && nowSeconds > result.Item.ttl) {
        return null;
      }

      try {
        return JSON.parse(result.Item.data) as PendingSanityAuthState;
      } catch {
        console.error('[AuthStateStorage] Failed to parse state data');
        return null;
      }
    },

    async clear(): Promise<void> {
      await ensureCommands();

      // Scan and delete all items (for testing only)
      const result = await client.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: 'begins_with(pk, :prefix)',
          ExpressionAttributeValues: { ':prefix': 'authstate#' },
        })
      ) as { Items?: Array<{ pk: string }> };

      if (result.Items) {
        for (const item of result.Items) {
          await client.send(
            new DeleteCommand({
              TableName: tableName,
              Key: { pk: item.pk },
            })
          );
        }
      }
    },

    async count(): Promise<number> {
      await ensureCommands();

      const result = await client.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: 'begins_with(pk, :prefix)',
          ExpressionAttributeValues: { ':prefix': 'authstate#' },
          Select: 'COUNT',
        })
      ) as { Count?: number };

      return result.Count ?? 0;
    },
  };
}

// =============================================================================
// Global Instance
// =============================================================================

let globalAuthStateStorage: AuthStateStorage | null = null;

/**
 * Get the global auth state storage instance.
 * Defaults to in-memory storage if not configured.
 */
export function getAuthStateStorage(): AuthStateStorage {
  if (!globalAuthStateStorage) {
    globalAuthStateStorage = createInMemoryAuthStateStorage();
  }
  return globalAuthStateStorage;
}

/**
 * Set the global auth state storage instance.
 * Call this during server initialization to use DynamoDB storage on AWS.
 */
export function setAuthStateStorage(storage: AuthStateStorage): void {
  globalAuthStateStorage = storage;
}

/**
 * Reset the global auth state storage (for testing).
 */
export function resetAuthStateStorage(): void {
  globalAuthStateStorage = null;
}
