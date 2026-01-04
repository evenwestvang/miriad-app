/**
 * Storage Interface
 *
 * Abstract interface for Cast storage backends.
 * Phase 1: Messages only. Expand as needed.
 */

import type {
  StoredMessage,
  CreateMessageInput,
  GetMessagesParams,
} from '@cast/core';

// =============================================================================
// Storage Interface
// =============================================================================

export interface Storage {
  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  /**
   * Save a message.
   */
  saveMessage(message: CreateMessageInput): Promise<StoredMessage>;

  /**
   * Get a message by ID.
   */
  getMessage(spaceId: string, messageId: string): Promise<StoredMessage | null>;

  /**
   * Get messages for a channel.
   */
  getMessages(
    spaceId: string,
    channelId: string,
    params?: GetMessagesParams
  ): Promise<StoredMessage[]>;

  /**
   * Update a message (e.g., mark complete after streaming).
   */
  updateMessage(
    spaceId: string,
    messageId: string,
    update: Partial<StoredMessage>
  ): Promise<void>;

  /**
   * Delete a message.
   */
  deleteMessage(spaceId: string, messageId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Initialize storage (create tables, etc.).
   */
  initialize(): Promise<void>;

  /**
   * Close storage connections.
   */
  close(): Promise<void>;
}
