/**
 * Cikada Platform - Channel Types
 *
 * Core domain models for channels and roster management.
 */

// =============================================================================
// Channel Types
// =============================================================================

/**
 * A channel is the primary container for real-time communication.
 * For MVP, channel = thread (flat model, no nested threads).
 */
export interface Channel {
  /** Unique channel identifier (ULID) */
  id: string;

  /** Space this channel belongs to */
  spaceId: string;

  /** Human-readable channel name */
  name: string;

  /** List of participant identifiers in this channel */
  roster: string[];

  /** Callsign of the channel leader (receives unaddressed human messages) */
  leader?: string;

  /** ISO timestamp when the channel was created */
  createdAt: string;

  /** Optional channel description */
  description?: string;

  /** Channel status */
  status: ChannelStatus;

  /** Focus area slug (references system.focus artifact) */
  focusSlug?: string;

  /** Short channel tagline */
  tagline?: string;

  /** Channel mission/purpose description */
  mission?: string;
}

export type ChannelStatus = 'active' | 'archived';

// =============================================================================
// Roster Types
// =============================================================================

/**
 * A roster entry represents a participant in a channel.
 */
export interface RosterEntry {
  /** Participant identifier */
  id: string;

  /** Display name */
  name: string;

  /** Type of participant */
  type: ParticipantType;

  /** Current status */
  status: ParticipantStatus;

  /** When the participant joined (serves as instance startTime for agents) */
  joinedAt: string;

  /** Agent-specific metadata */
  agentConfig?: AgentConfig;

  /**
   * System prompt for agents, captured at spawn time.
   * This is immutable for the lifetime of the agent instance.
   * History queries are scoped to messages after joinedAt.
   */
  systemPrompt?: string;
}

export type ParticipantType = 'user' | 'agent';

export type ParticipantStatus = 'online' | 'offline' | 'busy';

/**
 * MCP server configuration for agents.
 * Supports stdio (local command), sse (server-sent events), and http transports.
 */
export interface McpServerConfig {
  /** Server name for tool namespacing (e.g., 'filesystem' -> mcp__filesystem__read_file) */
  name: string;
  /** MCP server artifact slug (optional, for board-defined servers) */
  slug?: string;
  /** Transport type */
  transport: 'stdio' | 'sse' | 'http';
  /** Command for stdio transport */
  command?: string;
  /** Arguments for stdio transport */
  args?: string[];
  /** Environment variables for stdio transport */
  env?: Record<string, string>;
  /** Working directory for stdio transport */
  cwd?: string;
  /** URL for sse/http transport */
  url?: string;
  /** Headers for sse/http transport */
  headers?: Record<string, string>;
  /** Human-readable description of capabilities */
  capabilities?: string;
}

/**
 * Configuration for agent participants.
 */
export interface AgentConfig {
  /** Agent definition name (optional) */
  agentName?: string;

  /** Execution engine type */
  engine?: AgentEngine;

  /** Model to use (optional override) */
  model?: string;

  /** System prompt for the agent */
  system?: string;

  /** Maximum tokens for responses */
  maxTokens?: number;

  /** MCP servers to attach to this agent */
  mcpServers?: McpServerConfig[];
}

export type AgentEngine = 'stateless' | 'durable' | 'reactive' | 'hosted' | 'claude-code';

// =============================================================================
// Stored Message Types
// =============================================================================

/**
 * A message as stored in the database.
 * This is the persistent form - differs from wire format (TymbalFrame).
 */
export interface StoredMessage {
  /** Unique message identifier (ULID for ordering) */
  id: string;

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
   * Used for JIT conversion back to LLM message format.
   */
  turnId?: string;
}

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

// =============================================================================
// Attachment Types
// =============================================================================

/**
 * A file attachment uploaded to a channel.
 * Attachments are ephemeral (can be cleaned up) unlike artifacts which are permanent.
 */
export interface Attachment {
  /** Unique attachment identifier (ULID) */
  id: string;

  /** Channel this attachment belongs to */
  channelId: string;

  /** Message this attachment is linked to (optional - can upload before message) */
  messageId?: string;

  /** Original filename */
  filename: string;

  /** MIME type of the file */
  mimeType: string;

  /** File size in bytes */
  size: number;

  /** URL to access the file */
  url: string;

  /** Who uploaded this attachment */
  uploadedBy: string;

  /** ISO timestamp when uploaded */
  uploadedAt: string;

  /** Optional title for the attachment */
  title?: string;

  /** Optional description of what the attachment contains */
  description?: string;
}

// =============================================================================
// Type Guards
// =============================================================================

export function isChannel(value: unknown): value is Channel {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Channel).id === 'string' &&
    typeof (value as Channel).name === 'string' &&
    Array.isArray((value as Channel).roster)
  );
}

export function isRosterEntry(value: unknown): value is RosterEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as RosterEntry).id === 'string' &&
    typeof (value as RosterEntry).name === 'string' &&
    typeof (value as RosterEntry).type === 'string'
  );
}

export function isStoredMessage(value: unknown): value is StoredMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredMessage).id === 'string' &&
    typeof (value as StoredMessage).channelId === 'string' &&
    typeof (value as StoredMessage).sender === 'string'
  );
}

export function isAttachment(value: unknown): value is Attachment {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Attachment).id === 'string' &&
    typeof (value as Attachment).channelId === 'string' &&
    typeof (value as Attachment).filename === 'string' &&
    typeof (value as Attachment).mimeType === 'string'
  );
}
