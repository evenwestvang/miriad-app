/**
 * Channel Handler Types
 *
 * Type definitions for channel operations including creation, roster management,
 * and message handling.
 */

import type { ResolvedMcpConfig } from '../agents/types.js';

// =============================================================================
// Channel Types
// =============================================================================

/**
 * Channel data structure
 */
export interface Channel {
  id: string;
  name: string;
  description?: string;
  focusSlug?: string;
  tagline?: string;
  mission?: string;
  leader?: string;
  status?: 'active' | 'archived';
  createdAt?: string;
}

/**
 * Input for creating a new channel
 */
export interface CreateChannelInput {
  name: string;
  description?: string;
  focusSlug?: string;
  tagline?: string;
  mission?: string;
}

// =============================================================================
// Roster Types
// =============================================================================

/**
 * Agent engine types
 */
export type AgentEngine = 'stateless' | 'durable' | 'reactive' | 'hosted' | 'claude-code';

/**
 * Agent configuration for roster entry
 */
export interface AgentConfig {
  agentName?: string;
  engine?: AgentEngine;
  model?: string;
  system?: string;
  mcpServers?: ResolvedMcpConfig[];
  definitionSlug?: string;
  purpose?: string;
}

/**
 * Roster entry for participants in a channel
 */
export interface RosterEntry {
  id: string;
  name: string;
  type: 'agent' | 'human';
  status: 'online' | 'offline' | 'active' | 'idle';
  joinedAt: string;
  agentConfig?: AgentConfig;
  systemPrompt?: string;
}

/**
 * Input for adding an agent to a channel
 */
export interface AddAgentInput {
  agentType: string; // Agent definition slug
  callsign: string;
}

// =============================================================================
// Focus Area Types
// =============================================================================

/**
 * Props for system.focus artifacts
 */
export interface FocusProps {
  agents?: string[];
  defaultTagline?: string;
  defaultMission?: string;
  initialPrompt?: string;
  leader?: string;
}

/**
 * Resolved focus area configuration
 */
export interface ResolvedFocus {
  tagline?: string;
  mission?: string;
  agents: string[];
  leader?: string;
  initialPrompt?: string;
}

// =============================================================================
// Message Types
// =============================================================================

/**
 * Message data structure
 */
export interface Message {
  id: string;
  channelId: string;
  sender: string;
  senderType: 'user' | 'agent' | 'system';
  type: string;
  content: string;
  timestamp: string;
  isComplete?: boolean;
  addressedAgents?: string[];
}

/**
 * Input for saving a message
 */
export interface SaveMessageInput {
  id: string;
  channelId: string;
  sender: string;
  senderType: 'user' | 'agent' | 'system';
  type: string;
  content: string;
  timestamp: string;
  isComplete: boolean;
  addressedAgents?: string[];
}

// =============================================================================
// Storage Interface
// =============================================================================

/**
 * Storage adapter interface for channel operations.
 * Abstracts away SQLite vs DynamoDB differences.
 */
export interface ChannelStorage {
  /**
   * Create a new channel
   */
  createChannel(
    spaceId: string,
    input: {
      id: string;
      name: string;
      description?: string;
      focusSlug?: string;
      tagline?: string;
      mission?: string;
      leader?: string;
    }
  ): Promise<Channel>;

  /**
   * Get a channel by ID
   */
  getChannel(spaceId: string, channelId: string): Promise<Channel | null>;

  /**
   * List all channels in a space
   */
  listChannels(spaceId: string): Promise<Channel[]>;

  /**
   * Update channel status
   */
  updateChannelStatus(spaceId: string, channelId: string, status: 'active' | 'archived'): Promise<void>;

  /**
   * Get roster entries for a channel
   */
  getRoster(spaceId: string, channelId: string): Promise<RosterEntry[]>;

  /**
   * Add entry to roster
   */
  addToRoster(spaceId: string, channelId: string, entry: RosterEntry): Promise<void>;

  /**
   * Remove entry from roster
   */
  removeFromRoster(spaceId: string, channelId: string, participantId: string): Promise<void>;

  /**
   * Save a message
   */
  saveMessage(spaceId: string, message: SaveMessageInput): Promise<void>;
}

// =============================================================================
// Handler Context
// =============================================================================

/**
 * Context for channel handler operations
 */
export interface ChannelHandlerContext {
  storage: ChannelStorage;
  spaceId: string;
  /** Callback for broadcasting events to WebSocket clients */
  broadcast?: (channelId: string, frame: string) => Promise<void>;
}
