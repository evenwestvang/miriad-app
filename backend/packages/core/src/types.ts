/**
 * @cast/core - Shared Types
 *
 * Core domain models for the Cast platform.
 */

// =============================================================================
// Message Types (Phase 1 - Minimal)
// =============================================================================

export type ParticipantType = 'user' | 'agent';

export type StoredMessageType =
  | 'user'
  | 'assistant'
  | 'tool_call'
  | 'tool_result'
  | 'thinking'
  | 'status'
  | 'error'
  | 'agent_message'
  | 'agent_complete'
  | 'structured_ask'
  | 'attachment';

/**
 * A message as stored in the database.
 * This is the persistent form - differs from wire format (TymbalFrame).
 */
export interface StoredMessage {
  /** Unique message identifier (ULID for ordering) */
  id: string;

  /** Space this message belongs to */
  spaceId: string;

  /** Channel this message belongs to */
  channelId: string;

  /** Who sent this message */
  sender: string;

  /** Type of sender */
  senderType: ParticipantType;

  /** Message type discriminator */
  type: StoredMessageType;

  /** Message content (shape depends on type) */
  content: unknown;

  /** ISO timestamp */
  timestamp: string;

  /** Whether the message is complete (for streaming) */
  isComplete: boolean;

  /**
   * Agents this message was addressed/routed to.
   * - ["fox", "bear"] → Routed to specific agents (@fox, @bear)
   * - ["channel"] → Broadcast to all agents (@channel, system messages)
   * - [] or undefined → Logged but not routed to any agent
   */
  addressedAgents?: string[];

  /**
   * Turn identifier for grouping messages from a single agentic loop invocation.
   * All messages (assistant, tool_call, tool_result) from one turn share this ID.
   */
  turnId?: string;

  /** JSONB metadata for extensibility */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new message
 */
export interface CreateMessageInput {
  id?: string;
  spaceId: string;
  channelId: string;
  sender: string;
  senderType: ParticipantType;
  type: StoredMessageType;
  content: unknown;
  isComplete?: boolean;
  addressedAgents?: string[];
  turnId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Parameters for querying messages
 */
export interface GetMessagesParams {
  /** Return messages after this ID (ULID - for sync) */
  since?: string;
  /** Return messages before this ID (ULID - for pagination) */
  before?: string;
  /** Maximum number of messages to return */
  limit?: number;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isStoredMessage(value: unknown): value is StoredMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredMessage).id === 'string' &&
    typeof (value as StoredMessage).channelId === 'string' &&
    typeof (value as StoredMessage).sender === 'string'
  );
}
