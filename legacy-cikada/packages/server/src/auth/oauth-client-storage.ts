/**
 * OAuth Client Storage Interface
 *
 * Abstraction for storing OAuth client credentials (client_id from Mellon).
 * Implementations: in-memory (local dev), DynamoDB (AWS Lambda).
 *
 * Mellon assigns client_id during registration - we must store and reuse it.
 */

// =============================================================================
// Types
// =============================================================================

/**
 * Stored OAuth client credentials from Mellon registration.
 */
export interface OAuthClientCredentials {
  /** Client ID assigned by Mellon */
  clientId: string;
  /** Redirect URI this client is registered for */
  redirectUri: string;
  /** Client name used during registration */
  clientName: string;
  /** Timestamp when registered */
  registeredAt: number;
}

// =============================================================================
// Interface
// =============================================================================

/**
 * Storage interface for OAuth client credentials.
 */
export interface OAuthClientStorage {
  /**
   * Get stored client credentials for a redirect URI.
   * @param redirectUri - The redirect URI to look up
   * @returns Client credentials, or null if not registered
   */
  get(redirectUri: string): Promise<OAuthClientCredentials | null>;

  /**
   * Save client credentials for a redirect URI.
   * @param redirectUri - The redirect URI (key)
   * @param credentials - The client credentials from Mellon
   */
  save(redirectUri: string, credentials: OAuthClientCredentials): Promise<void>;

  /**
   * Clear all stored credentials (for testing).
   */
  clear(): Promise<void>;
}

// =============================================================================
// In-Memory Implementation (for local development)
// =============================================================================

/**
 * In-memory OAuth client storage.
 * Suitable for local development. Credentials persist for the server lifetime.
 */
export function createInMemoryOAuthClientStorage(): OAuthClientStorage {
  const clients = new Map<string, OAuthClientCredentials>();

  return {
    async get(redirectUri: string): Promise<OAuthClientCredentials | null> {
      return clients.get(redirectUri) ?? null;
    },

    async save(redirectUri: string, credentials: OAuthClientCredentials): Promise<void> {
      clients.set(redirectUri, credentials);
    },

    async clear(): Promise<void> {
      clients.clear();
    },
  };
}

// =============================================================================
// DynamoDB Implementation (for AWS Lambda)
// =============================================================================

export interface DynamoDBOAuthClientStorageOptions {
  /** DynamoDB DocumentClient */
  client: {
    send: (command: unknown) => Promise<unknown>;
  };
  /** Table name */
  tableName: string;
}

/**
 * DynamoDB OAuth client storage.
 * Stores Mellon-assigned client credentials persistently.
 * No TTL - credentials are permanent until manually cleared.
 */
export function createDynamoDBOAuthClientStorage(
  options: DynamoDBOAuthClientStorageOptions
): OAuthClientStorage {
  const { client, tableName } = options;

  // Dynamic imports to avoid bundling issues
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let PutCommand: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GetCommand: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ScanCommand: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let DeleteCommand: any;

  const ensureCommands = async () => {
    if (!PutCommand) {
      const lib = await import('@aws-sdk/lib-dynamodb');
      PutCommand = lib.PutCommand;
      GetCommand = lib.GetCommand;
      ScanCommand = lib.ScanCommand;
      DeleteCommand = lib.DeleteCommand;
    }
  };

  // Create a deterministic key from redirect URI
  const makeKey = (redirectUri: string): string => {
    // Use a hash to keep keys manageable
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update(redirectUri).digest('hex').slice(0, 16);
    return `oauthclient#${hash}`;
  };

  return {
    async get(redirectUri: string): Promise<OAuthClientCredentials | null> {
      await ensureCommands();

      const result = (await client.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: makeKey(redirectUri) },
        })
      )) as { Item?: { data: string } };

      if (!result.Item) {
        return null;
      }

      try {
        return JSON.parse(result.Item.data) as OAuthClientCredentials;
      } catch {
        console.error('[OAuthClientStorage] Failed to parse credentials');
        return null;
      }
    },

    async save(redirectUri: string, credentials: OAuthClientCredentials): Promise<void> {
      await ensureCommands();

      await client.send(
        new PutCommand({
          TableName: tableName,
          Item: {
            pk: makeKey(redirectUri),
            redirectUri, // Store for debugging/lookup
            data: JSON.stringify(credentials),
            createdAt: new Date().toISOString(),
          },
        })
      );
    },

    async clear(): Promise<void> {
      await ensureCommands();

      const result = (await client.send(
        new ScanCommand({
          TableName: tableName,
          FilterExpression: 'begins_with(pk, :prefix)',
          ExpressionAttributeValues: { ':prefix': 'oauthclient#' },
        })
      )) as { Items?: Array<{ pk: string }> };

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
  };
}

// =============================================================================
// Global Instance
// =============================================================================

let globalOAuthClientStorage: OAuthClientStorage | null = null;

/**
 * Get the global OAuth client storage instance.
 * Defaults to in-memory storage if not configured.
 */
export function getOAuthClientStorage(): OAuthClientStorage {
  if (!globalOAuthClientStorage) {
    globalOAuthClientStorage = createInMemoryOAuthClientStorage();
  }
  return globalOAuthClientStorage;
}

/**
 * Set the global OAuth client storage instance.
 * Call this during server initialization to use DynamoDB storage on AWS.
 */
export function setOAuthClientStorage(storage: OAuthClientStorage): void {
  globalOAuthClientStorage = storage;
}

/**
 * Reset the global OAuth client storage (for testing).
 */
export function resetOAuthClientStorage(): void {
  globalOAuthClientStorage = null;
}
