/**
 * Cikada Platform - API Contract
 *
 * Type definitions for HTTP API requests and responses.
 * This is the contract between frontend and backend.
 */

import type { Channel, RosterEntry, StoredMessage } from './channels.js';

// =============================================================================
// Channel Endpoints
// =============================================================================

/**
 * POST /channels - Create a new channel
 */
export interface CreateChannelRequest {
  name: string;
  description?: string;
}

export interface CreateChannelResponse {
  channel: Channel;
}

/**
 * GET /channels - List channels
 */
export interface ListChannelsResponse {
  channels: Channel[];
}

/**
 * GET /channels/:id - Get channel details
 */
export interface GetChannelResponse {
  channel: Channel;
  roster: RosterEntry[];
}

/**
 * DELETE /channels/:id - Archive a channel
 */
export interface ArchiveChannelResponse {
  success: boolean;
}

// =============================================================================
// Roster Endpoints
// =============================================================================

/**
 * POST /channels/:id/roster - Add participant to channel
 */
export interface AddToRosterRequest {
  participantId: string;
  participantType: 'user' | 'agent';
  name: string;
  agentConfig?: {
    agentName: string;
    engine: 'stateless' | 'durable' | 'hosted';
    model?: string;
    /** System prompt for the agent */
    system?: string;
  };
}

export interface AddToRosterResponse {
  entry: RosterEntry;
}

/**
 * DELETE /channels/:id/roster/:participantId - Remove from channel
 */
export interface RemoveFromRosterResponse {
  success: boolean;
}

// =============================================================================
// Message Endpoints
// =============================================================================

/**
 * POST /channels/:id/messages - Send a message
 */
export interface SendMessageRequest {
  content: string;
  sender: string;
  senderType: 'user' | 'agent';
}

export interface SendMessageResponse {
  messageId: string;
  timestamp: string;
}

/**
 * GET /channels/:id/messages - Get message history
 */
export interface GetMessagesRequest {
  /** Return messages after this ID (for pagination) */
  since?: string;
  /** Maximum number of messages to return */
  limit?: number;
}

export interface GetMessagesResponse {
  messages: StoredMessage[];
  /** ID of the last message (for pagination) */
  cursor?: string;
}

// =============================================================================
// Agent Endpoints
// =============================================================================

/**
 * GET /agents - List available agent definitions
 */
export interface ListAgentsResponse {
  agents: AgentInfo[];
}

export interface AgentInfo {
  name: string;
  description: string;
  engine: 'stateless' | 'durable' | 'hosted';
}

/**
 * POST /channels/:id/invoke - Invoke an agent in a channel
 */
export interface InvokeAgentRequest {
  agentName: string;
  message: string;
}

export interface InvokeAgentResponse {
  /** The agent's response message ID */
  messageId: string;
  /** Whether the agent is still processing */
  streaming: boolean;
}

// =============================================================================
// WebSocket Messages
// =============================================================================

/**
 * Client → Server: Subscribe to channel updates
 */
export interface SubscribeMessage {
  type: 'subscribe';
  channelId: string;
}

/**
 * Client → Server: Unsubscribe from channel
 */
export interface UnsubscribeMessage {
  type: 'unsubscribe';
  channelId: string;
}

/**
 * Client → Server: Sync request (get messages since timestamp)
 */
export interface SyncMessage {
  type: 'sync';
  channelId: string;
  since?: string;
}

/**
 * Client → Server: Send a message
 */
export interface ClientSendMessage {
  type: 'send';
  channelId: string;
  content: string;
  sender: string;
  senderType: 'user' | 'agent';
}

/**
 * Server → Client: Acknowledgment
 */
export interface AckMessage {
  type: 'ack';
  messageId?: string;
  error?: string;
}

export type ClientMessage =
  | SubscribeMessage
  | UnsubscribeMessage
  | SyncMessage
  | ClientSendMessage;

export type ServerMessage = AckMessage;

// Note: Tymbal frames are also sent server → client for message streaming
