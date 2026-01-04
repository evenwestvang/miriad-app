/**
 * Storage Interface
 *
 * Abstract interface for Cast storage backends.
 * Phase 1: Messages
 * Phase 2: Channels + Roster
 */

import type {
  StoredMessage,
  CreateMessageInput,
  GetMessagesParams,
  StoredChannel,
  CreateChannelInput,
  UpdateChannelInput,
  ListChannelsParams,
  RosterEntry,
  AddToRosterInput,
  UpdateRosterInput,
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
  // Channel Operations (Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Create a new channel.
   */
  createChannel(input: CreateChannelInput): Promise<StoredChannel>;

  /**
   * Get a channel by ID.
   */
  getChannel(spaceId: string, channelId: string): Promise<StoredChannel | null>;

  /**
   * Get a channel by name.
   */
  getChannelByName(spaceId: string, name: string): Promise<StoredChannel | null>;

  /**
   * List channels in a space.
   */
  listChannels(
    spaceId: string,
    params?: ListChannelsParams
  ): Promise<StoredChannel[]>;

  /**
   * Update a channel.
   */
  updateChannel(
    spaceId: string,
    channelId: string,
    update: UpdateChannelInput
  ): Promise<void>;

  /**
   * Archive a channel (soft delete).
   */
  archiveChannel(spaceId: string, channelId: string): Promise<void>;

  // ---------------------------------------------------------------------------
  // Roster Operations (Phase 2)
  // ---------------------------------------------------------------------------

  /**
   * Add an agent to a channel's roster.
   */
  addToRoster(input: AddToRosterInput): Promise<RosterEntry>;

  /**
   * Get a roster entry by ID.
   */
  getRosterEntry(channelId: string, entryId: string): Promise<RosterEntry | null>;

  /**
   * Get a roster entry by callsign.
   */
  getRosterByCallsign(channelId: string, callsign: string): Promise<RosterEntry | null>;

  /**
   * List all agents in a channel's roster.
   */
  listRoster(channelId: string): Promise<RosterEntry[]>;

  /**
   * Update a roster entry (e.g., change status).
   */
  updateRosterEntry(
    channelId: string,
    entryId: string,
    update: UpdateRosterInput
  ): Promise<void>;

  /**
   * Remove an agent from a channel's roster.
   */
  removeFromRoster(channelId: string, entryId: string): Promise<void>;

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
