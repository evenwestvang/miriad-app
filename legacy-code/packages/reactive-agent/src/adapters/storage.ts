/**
 * Storage Adapter Interface
 *
 * Abstracts storage operations for the reactive agent.
 * Implementations: SQLite (local), DynamoDB (AWS).
 */

import type { StoredMessage } from "@cikada/core";

// =============================================================================
// Types
// =============================================================================

/**
 * Options for retrieving agent conversation history.
 */
export interface GetAgentHistoryOptions {
  /** Agent's callsign */
  agentCallsign: string;
  /** Agent's instance start time (joinedAt from roster) */
  sinceTimestamp: string;
  /** Maximum number of messages to return */
  limit?: number;
}

/**
 * Message to save to storage.
 * Omits id generation (handled by caller) but requires all storage fields.
 */
export interface MessageToSave {
  /** Unique message identifier (ULID) */
  id: string;
  /** Channel this message belongs to */
  channelId: string;
  /** Who sent this message */
  sender: string;
  /** Type of sender */
  senderType: "user" | "agent" | "system";
  /** Message type discriminator */
  type: string;
  /** Message content (shape depends on type) */
  content: unknown;
  /** ISO timestamp */
  timestamp: string;
  /** Whether the message is complete (for streaming) */
  isComplete: boolean;
  /** Agents this message was addressed/routed to */
  addressedAgents?: string[];
}

// =============================================================================
// Storage Adapter Interface
// =============================================================================

/**
 * Storage adapter interface for the reactive agent.
 *
 * Platform implementations:
 * - Local: SQLite via better-sqlite3
 * - AWS: DynamoDB via @cikada/storage
 */
export interface StorageAdapter {
  /**
   * Get conversation history for a specific agent.
   * Returns messages where:
   * - The agent's callsign is in addressedAgents, OR
   * - 'channel' is in addressedAgents (broadcast messages)
   * AND
   * - timestamp >= agent's sinceTimestamp (instance startTime)
   */
  getAgentHistory(
    spaceId: string,
    channelId: string,
    options: GetAgentHistoryOptions
  ): Promise<StoredMessage[]>;

  /**
   * Save a message to storage.
   */
  saveMessage(spaceId: string, message: MessageToSave): Promise<void>;

  /**
   * Update a message (e.g., mark complete after streaming).
   */
  updateMessage(
    spaceId: string,
    messageId: string,
    update: Partial<MessageToSave>
  ): Promise<void>;
}
