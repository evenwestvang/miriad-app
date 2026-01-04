/**
 * Tymbal Protocol - Frame Builders
 *
 * Unified frame builder functions for the Tymbal streaming protocol.
 * These functions return JSON-serialized frame strings ready for transmission.
 *
 * @see /design-notes/agent-server/tymbal-spec.md for the full specification
 */

import { ulid } from 'ulid';
import type { ArtifactFrame, ArtifactPayload, MessageMetadata } from './frames.js';

// =============================================================================
// Frame Builders (tymbal namespace)
// =============================================================================

/**
 * Tymbal frame builder namespace.
 * All methods return JSON-serialized strings ready for transmission.
 */
export const tymbal = {
  /**
   * Create a start frame with optional metadata.
   * Text streaming mode: include metadata (e.g., {type: "assistant"})
   * Object streaming mode: omit metadata
   */
  start(id: string, metadata?: MessageMetadata): string {
    const frame: { i: string; m?: MessageMetadata } = { i: id };
    if (metadata) {
      // Validate: content is reserved
      if ('content' in metadata) {
        throw new Error('Metadata cannot contain reserved key "content"');
      }
      frame.m = metadata;
    }
    return JSON.stringify(frame);
  },

  /**
   * Create an append frame to add text to a message buffer.
   */
  append(id: string, text: string): string {
    return JSON.stringify({ i: id, a: text });
  },

  /**
   * Create a set frame to finalize a message with its complete value.
   */
  set(id: string, value: Record<string, unknown>, timestamp?: string): string {
    return JSON.stringify({
      i: id,
      t: timestamp ?? new Date().toISOString(),
      v: value,
    });
  },

  /**
   * Create a delete frame to remove a message.
   */
  delete(id: string): string {
    return JSON.stringify({ i: id, v: null });
  },

  /**
   * Create a sync request frame (client → server).
   */
  sync(since?: string): string {
    const frame: { request: 'sync'; since?: string } = { request: 'sync' };
    if (since) {
      frame.since = since;
    }
    return JSON.stringify(frame);
  },

  /**
   * Create a sync response frame (server → client).
   * Used to acknowledge sync completion with a timestamp cursor.
   */
  syncResponse(timestamp: string): string {
    return JSON.stringify({ sync: timestamp });
  },

  /**
   * Create an error frame.
   */
  error(code: string, message?: string): string {
    const frame: { error: string; message?: string } = { error: code };
    if (message) {
      frame.message = message;
    }
    return JSON.stringify(frame);
  },

  /**
   * Create an artifact frame for broadcasting artifact changes.
   */
  artifact(
    action: 'create' | 'update' | 'archive',
    channelId: string,
    artifact: Omit<ArtifactPayload, 'path'> & { path?: string }
  ): string {
    const frame: ArtifactFrame = {
      artifact: {
        action,
        channelId,
        payload: {
          slug: artifact.slug,
          type: artifact.type,
          title: artifact.title,
          tldr: artifact.tldr,
          status: artifact.status,
          path: artifact.path ?? `/${channelId}/${artifact.slug}`,
          assignees: artifact.assignees,
        },
      },
    };
    return JSON.stringify(frame);
  },
};

// =============================================================================
// Message Handle
// =============================================================================

export interface MessageHandleOptions {
  id: string;
  metadata?: MessageMetadata;
  broadcast: (frame: string) => Promise<void>;
}

export interface MessageHandle {
  id: string;
  stream(text: string): Promise<void>;
  set(value: Record<string, unknown>): Promise<void>;
  delete(): Promise<void>;
}

/**
 * Create a message handle for streaming content.
 * Manages the start/append/set lifecycle for a single message.
 */
export function createMessageHandle(options: MessageHandleOptions): MessageHandle {
  const { id, metadata, broadcast } = options;
  let buffer = '';
  let started = false;
  let finalized = false;

  return {
    id,

    async stream(text: string): Promise<void> {
      if (finalized) {
        throw new Error('Cannot stream to a finalized message');
      }

      if (!started) {
        await broadcast(tymbal.start(id, metadata));
        started = true;
      }

      buffer += text;
      await broadcast(tymbal.append(id, text));
    },

    async set(value: Record<string, unknown>): Promise<void> {
      if (finalized) {
        throw new Error('Cannot set a finalized message');
      }

      // If we haven't started, send a set directly (no streaming)
      if (!started) {
        await broadcast(tymbal.set(id, value));
        finalized = true;
        return;
      }

      // Finalize with the complete value
      // For text mode, merge metadata with content
      const finalValue = metadata ? { ...metadata, content: buffer, ...value } : value;

      await broadcast(tymbal.set(id, finalValue));
      finalized = true;
    },

    async delete(): Promise<void> {
      await broadcast(tymbal.delete(id));
      finalized = true;
    },
  };
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Generate a new message ID (ULID).
 * ULIDs are sortable, unique identifiers suitable for message ordering.
 */
export function generateMessageId(): string {
  return ulid();
}
