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
// Channel Types (Phase 2)
// =============================================================================

/**
 * A channel as stored in the database.
 */
export interface StoredChannel {
  /** Unique channel identifier (ULID) */
  id: string;

  /** Space this channel belongs to */
  spaceId: string;

  /** Channel name (slug-like) */
  name: string;

  /** Short description */
  tagline?: string;

  /** Longer mission/purpose statement */
  mission?: string;

  /** Whether the channel is archived */
  archived: boolean;

  /** ISO timestamp of creation */
  createdAt: string;

  /** ISO timestamp of last update */
  updatedAt: string;
}

/**
 * Input for creating a new channel
 */
export interface CreateChannelInput {
  id?: string;
  spaceId: string;
  name: string;
  tagline?: string;
  mission?: string;
}

/**
 * Input for updating a channel
 */
export interface UpdateChannelInput {
  name?: string;
  tagline?: string;
  mission?: string;
  archived?: boolean;
}

/**
 * Parameters for listing channels
 */
export interface ListChannelsParams {
  /** Include archived channels (default: false) */
  includeArchived?: boolean;
  /** Maximum number of channels to return */
  limit?: number;
}

// =============================================================================
// Roster Types (Phase 2)
// =============================================================================

export type RosterStatus = 'active' | 'idle' | 'busy' | 'offline';

/**
 * A roster entry (agent in a channel) as stored in the database.
 */
export interface RosterEntry {
  /** Unique roster entry identifier (ULID) */
  id: string;

  /** Channel this roster entry belongs to */
  channelId: string;

  /** Agent's callsign in this channel */
  callsign: string;

  /** Type of agent (definition slug) */
  agentType: string;

  /** Current status */
  status: RosterStatus;

  /** ISO timestamp of when agent joined */
  createdAt: string;

  /** Callback URL for message delivery (set by container checkin) */
  callbackUrl?: string;

  /** Last delivered message ID (for tracking what's been pushed to agent) */
  readmark?: string;
}

/**
 * Input for adding an agent to a roster
 */
export interface AddToRosterInput {
  id?: string;
  channelId: string;
  callsign: string;
  agentType: string;
  status?: RosterStatus;
}

/**
 * Input for updating a roster entry
 */
export interface UpdateRosterInput {
  status?: RosterStatus;
  /** Callback URL for message delivery */
  callbackUrl?: string;
  /** Last delivered message ID */
  readmark?: string;
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

export function isStoredChannel(value: unknown): value is StoredChannel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredChannel).id === 'string' &&
    typeof (value as StoredChannel).spaceId === 'string' &&
    typeof (value as StoredChannel).name === 'string'
  );
}

export function isRosterEntry(value: unknown): value is RosterEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RosterEntry).id === 'string' &&
    typeof (value as RosterEntry).channelId === 'string' &&
    typeof (value as RosterEntry).callsign === 'string'
  );
}
