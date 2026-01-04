/**
 * TymbalFrameHandler
 *
 * Centralized handler for all Tymbal frames from all agent types.
 * Responsibilities:
 * - Parse and validate incoming frames
 * - Normalize field names (input -> args)
 * - Broadcast ALL frames for streaming UX
 * - Persist SetFrames to storage
 * - Route @mentions to other agents
 *
 * @see tymbal-spec for full specification
 */

import type { StoredMessage, StoredMessageType } from '../cikada/index.js';

// =============================================================================
// Storage Interface (minimal subset for handler)
// =============================================================================

/**
 * Minimal storage interface required by TymbalFrameHandler.
 * This avoids circular dependency with @cikada/storage.
 * Full Storage implementations satisfy this interface.
 */
export interface TymbalStorage {
  saveMessage(spaceId: string, message: StoredMessage): Promise<void>;
  deleteMessage(spaceId: string, messageId: string): Promise<void>;
}

import {
  type TymbalFrame,
  type SetFrame,
  isSetFrame,
  isResetFrame,
} from './frames.js';
import { parseFrame } from './parser.js';

// =============================================================================
// Types
// =============================================================================

export interface TymbalFrameHandlerOptions {
  /** Storage backend for persistence */
  storage: TymbalStorage;
  /** Broadcast frame to WebSocket clients */
  broadcast: (channelId: string, frame: string) => Promise<void>;
  /** Route message to agents based on @mentions */
  routeMessage: (spaceId: string, channelId: string, sender: string, content: string) => Promise<void>;
}

export interface TymbalFrameHandler {
  /**
   * Handle a Tymbal frame from any agent.
   * - ALL frames -> broadcast to WebSocket clients (streaming)
   * - SetFrames -> persist to storage + route @mentions
   */
  handleFrame(spaceId: string, channelId: string, frame: string): Promise<void>;
}

// =============================================================================
// Mention Parsing
// =============================================================================

const MENTION_REGEX = /@([a-zA-Z][a-zA-Z0-9_-]*)/g;

/**
 * Extract @mentions from message content.
 * Returns array of mentioned names (without @ prefix).
 */
function parseMentions(content: string): string[] {
  const mentions: string[] = [];
  let match;
  while ((match = MENTION_REGEX.exec(content)) !== null) {
    const name = match[1].toLowerCase();
    if (!mentions.includes(name)) {
      mentions.push(name);
    }
  }
  return mentions;
}

// =============================================================================
// Frame Normalization
// =============================================================================

/**
 * Normalize frame value fields for consistency.
 * - Converts 'input' to 'args' for tool_call frames
 */
function normalizeFrameValue(value: Record<string, unknown>): Record<string, unknown> {
  // Normalize input -> args for tool_call
  if (value.type === 'tool_call' && 'input' in value && !('args' in value)) {
    const { input, ...rest } = value;
    return { ...rest, args: input };
  }
  return value;
}

// =============================================================================
// Persistence Logic
// =============================================================================

/**
 * Persist a SetFrame to storage.
 * Unwraps frame value to storage format based on message type.
 */
async function persistSetFrame(
  storage: TymbalStorage,
  spaceId: string,
  channelId: string,
  frame: SetFrame
): Promise<void> {
  const { i: id, t: timestamp, v: value } = frame;

  // Validate required fields
  if (!value.type || typeof value.type !== 'string') {
    throw new Error('SetFrame missing required field: type');
  }
  if (!value.sender || typeof value.sender !== 'string') {
    throw new Error('SetFrame missing required field: sender');
  }

  const sender = value.sender as string;
  const messageType = value.type as StoredMessageType;

  // Base message fields
  const base: Omit<StoredMessage, 'content'> = {
    id,
    channelId,
    sender,
    senderType: 'agent',
    type: messageType,
    timestamp,
    isComplete: true,
    addressedAgents: typeof value.content === 'string' ? parseMentions(value.content) : [],
  };

  // Build content based on message type
  let content: unknown;

  switch (messageType) {
    case 'assistant':
    case 'user':
      // Text messages: content is just the string
      content = value.content ?? '';
      base.addressedAgents = parseMentions(content as string);
      break;

    case 'tool_call':
      // Tool call: unwrap to flat format
      content = {
        id: value.id,
        name: value.name,
        args: value.args,
      };
      break;

    case 'tool_result':
      // Tool result: unwrap to flat format
      content = {
        call_id: value.call_id,
        name: value.name,
        content: value.content,
        isError: value.isError ?? false,
      };
      break;

    case 'thinking':
    case 'status':
    case 'error':
      // These types store content as-is
      content = value.content;
      break;

    case 'agent_complete':
      // agent_complete is metadata, don't persist
      // (the assistant message is already persisted separately)
      return;

    default:
      // Other types: store full value minus type/sender
      const { type: _type, sender: _sender, senderType: _senderType, ...rest } = value;
      content = rest;
  }

  await storage.saveMessage(spaceId, {
    ...base,
    content,
  });
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a TymbalFrameHandler instance.
 */
export function createTymbalFrameHandler(options: TymbalFrameHandlerOptions): TymbalFrameHandler {
  const { storage, broadcast, routeMessage } = options;

  return {
    async handleFrame(spaceId: string, channelId: string, frame: string): Promise<void> {
      // Parse the frame
      const parsed = parseFrame(frame);
      if (!parsed) {
        console.error('[TymbalFrameHandler] Invalid frame:', frame);
        return;
      }

      // Normalize field names if this is a SetFrame
      let normalizedFrame = frame;
      if (isSetFrame(parsed)) {
        const normalizedValue = normalizeFrameValue(parsed.v);
        if (normalizedValue !== parsed.v) {
          const normalizedParsed = { ...parsed, v: normalizedValue };
          normalizedFrame = JSON.stringify(normalizedParsed);
        }
      }

      // ALWAYS broadcast for streaming UX
      await broadcast(channelId, normalizedFrame);

      // Handle SetFrames: persist and route
      if (isSetFrame(parsed)) {
        const normalizedValue = normalizeFrameValue(parsed.v);
        const normalizedSetFrame: SetFrame = { ...parsed, v: normalizedValue };

        try {
          // Persist to storage (except agent_complete)
          await persistSetFrame(storage, spaceId, channelId, normalizedSetFrame);

          // Route @mentions for assistant messages
          if (normalizedValue.type === 'assistant' && typeof normalizedValue.content === 'string') {
            await routeMessage(spaceId, channelId, normalizedValue.sender as string, normalizedValue.content);
          }

          // Also route agent_complete result for @mentions
          if (normalizedValue.type === 'agent_complete' && normalizedValue.result) {
            await routeMessage(
              spaceId,
              channelId,
              normalizedValue.sender as string,
              String(normalizedValue.result)
            );
          }
        } catch (error) {
          console.error('[TymbalFrameHandler] Error processing SetFrame:', error);
          // Continue - frame was already broadcast
        }
      }

      // Handle ResetFrames: delete from storage
      if (isResetFrame(parsed)) {
        try {
          await storage.deleteMessage(spaceId, parsed.i);
        } catch (error) {
          console.error('[TymbalFrameHandler] Error deleting message:', error);
        }
      }
    },
  };
}
