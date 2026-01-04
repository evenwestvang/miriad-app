/**
 * DynamoDB Storage Adapter
 *
 * Wraps the @cikada/storage DynamoDB implementation to match the
 * StorageAdapter interface from @cikada/reactive-agent.
 */

import type { StoredMessage } from "@cikada/core";
import type { Storage } from "@cikada/storage";
import { createDynamoDbStorage } from "@cikada/storage";
import type {
  StorageAdapter,
  GetAgentHistoryOptions,
  MessageToSave,
} from "@cikada/reactive-agent";

// =============================================================================
// DynamoDB Storage Adapter
// =============================================================================

/**
 * Storage adapter for AWS Lambda using DynamoDB.
 * Wraps the @cikada/storage DynamoDB implementation.
 */
export class DynamoStorageAdapter implements StorageAdapter {
  private storage: Storage;

  constructor(storage: Storage) {
    this.storage = storage;
  }

  /**
   * Get conversation history for an agent.
   */
  async getAgentHistory(
    spaceId: string,
    channelId: string,
    options: GetAgentHistoryOptions
  ): Promise<StoredMessage[]> {
    return this.storage.getAgentHistory(spaceId, channelId, {
      agentCallsign: options.agentCallsign,
      sinceTimestamp: options.sinceTimestamp,
      limit: options.limit,
    });
  }

  /**
   * Save a message to storage.
   */
  async saveMessage(spaceId: string, message: MessageToSave): Promise<void> {
    await this.storage.saveMessage(spaceId, {
      id: message.id,
      channelId: message.channelId,
      sender: message.sender,
      senderType: message.senderType,
      type: message.type,
      content: message.content,
      timestamp: message.timestamp,
      isComplete: message.isComplete,
      addressedAgents: message.addressedAgents,
    } as StoredMessage);
  }

  /**
   * Update a message.
   */
  async updateMessage(
    spaceId: string,
    messageId: string,
    update: Partial<MessageToSave>
  ): Promise<void> {
    await this.storage.updateMessage(spaceId, messageId, update);
  }
}

// =============================================================================
// Factory Functions
// =============================================================================

/**
 * Storage singleton for Lambda warm starts.
 */
let storageInstance: Storage | null = null;

/**
 * Get or create the DynamoDB storage singleton.
 */
function getStorage(): Storage {
  if (!storageInstance) {
    const region = process.env.AWS_REGION || "us-east-1";
    const tableName = process.env.MAIN_TABLE;

    if (!tableName) {
      throw new Error("MAIN_TABLE environment variable not set");
    }

    storageInstance = createDynamoDbStorage({
      region,
      tableName,
    });
  }
  return storageInstance;
}

/**
 * Create a DynamoDB storage adapter using environment config.
 */
export function createDynamoStorageAdapter(): DynamoStorageAdapter {
  return new DynamoStorageAdapter(getStorage());
}

/**
 * Create a DynamoDB storage adapter from an existing Storage instance.
 */
export function createDynamoStorageAdapterFromStorage(
  storage: Storage
): DynamoStorageAdapter {
  return new DynamoStorageAdapter(storage);
}
