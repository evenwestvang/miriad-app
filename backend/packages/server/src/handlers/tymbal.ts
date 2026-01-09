/**
 * POST /tymbal endpoint
 *
 * Receives Tymbal frames from containers and broadcasts them to WebSocket clients.
 * This is how agent containers stream their output back to the server.
 */

import { Hono } from 'hono';
import {
  parseFrame,
  isSetFrame,
  isResetFrame,
  type TymbalFrame,
  type SetFrame,
} from '@cast/core';
import { requireContainerAuth, getContainerAuth, type ContainerAuthVariables } from '../auth/index.js';
import type { ConnectionManager } from '../websocket/index.js';

// =============================================================================
// Types
// =============================================================================

export interface TymbalHandlerOptions {
  /** Connection manager for broadcasting frames */
  connectionManager: ConnectionManager;
  /** Optional: persist SetFrames to storage (spaceId from container auth) */
  onSetFrame?: (channelId: string, frame: SetFrame, spaceId: string) => Promise<void>;
  /** Optional: handle ResetFrames (deletions) (spaceId from container auth) */
  onResetFrame?: (channelId: string, messageId: string, spaceId: string) => Promise<void>;
}

// =============================================================================
// Frame Normalization
// =============================================================================

/**
 * Normalize frame value fields for consistency.
 * - Converts 'input' to 'args' for tool_call frames (Anthropic SDK compatibility)
 */
function normalizeFrameValue(value: Record<string, unknown>): Record<string, unknown> {
  if (value.type === 'tool_call' && 'input' in value && !('args' in value)) {
    const { input, ...rest } = value;
    return { ...rest, args: input };
  }
  return value;
}

/**
 * Normalize a SetFrame, transforming its value if needed.
 */
function normalizeSetFrame(frame: SetFrame): { frame: SetFrame; serialized: string } {
  const normalizedValue = normalizeFrameValue(frame.v);
  if (normalizedValue !== frame.v) {
    const normalized = { ...frame, v: normalizedValue };
    return { frame: normalized, serialized: JSON.stringify(normalized) };
  }
  return { frame, serialized: JSON.stringify(frame) };
}

/**
 * Inject channelId into a frame for client routing.
 * This makes frames self-describing so clients don't need to track channel state.
 */
function injectChannelId(frameJson: string, channelId: string): string {
  try {
    const frame = JSON.parse(frameJson);
    frame.c = channelId; // 'c' for channel, keeps wire format compact
    return JSON.stringify(frame);
  } catch {
    // If parsing fails, return original (shouldn't happen with valid frames)
    return frameJson;
  }
}

// =============================================================================
// Route Handler
// =============================================================================

/**
 * Create the /tymbal routes.
 */
export function createTymbalRoutes(options: TymbalHandlerOptions): Hono<{ Variables: ContainerAuthVariables }> {
  const { connectionManager, onSetFrame, onResetFrame } = options;

  const app = new Hono<{ Variables: ContainerAuthVariables }>();

  // Require container auth for all tymbal routes
  app.use('/*', requireContainerAuth());

  /**
   * POST /tymbal/:channelId
   *
   * Receive a Tymbal frame from a container and broadcast it.
   * Body should be a single NDJSON line (no trailing newline required).
   */
  app.post('/:channelId', async (c) => {
    const channelId = c.req.param('channelId');
    const auth = getContainerAuth(c);
    const spaceId = auth.spaceId;

    // Get raw body
    const body = await c.req.text();

    if (!body.trim()) {
      return c.json({ error: 'empty_body', message: 'Request body is empty' }, 400);
    }

    // Parse the frame
    const frame = parseFrame(body);
    if (!frame) {
      return c.json({ error: 'invalid_frame', message: 'Could not parse Tymbal frame' }, 400);
    }

    // Handle frame types
    try {
      if (isSetFrame(frame)) {
        // Normalize and broadcast SetFrame with channelId injected
        const { frame: normalizedFrame, serialized } = normalizeSetFrame(frame);
        await connectionManager.broadcast(channelId, injectChannelId(serialized, channelId));

        // Persist if handler provided
        if (onSetFrame) {
          await onSetFrame(channelId, normalizedFrame, spaceId);
        }
      } else if (isResetFrame(frame)) {
        // Broadcast ResetFrame with channelId injected
        await connectionManager.broadcast(channelId, injectChannelId(body, channelId));

        // Handle deletion if handler provided
        if (onResetFrame) {
          await onResetFrame(channelId, frame.i, spaceId);
        }
      } else {
        // All other frames (Start, Append) with channelId injected
        await connectionManager.broadcast(channelId, injectChannelId(body, channelId));
      }

      return c.json({ ok: true });
    } catch (error) {
      console.error('[Tymbal] Error processing frame:', error);
      return c.json(
        { error: 'processing_error', message: 'Failed to process frame' },
        500
      );
    }
  });

  /**
   * POST /tymbal/:channelId/batch
   *
   * Receive multiple Tymbal frames (NDJSON body).
   * Each line is processed independently.
   */
  app.post('/:channelId/batch', async (c) => {
    const channelId = c.req.param('channelId');
    const auth = getContainerAuth(c);
    const spaceId = auth.spaceId;

    const body = await c.req.text();
    if (!body.trim()) {
      return c.json({ error: 'empty_body', message: 'Request body is empty' }, 400);
    }

    const lines = body.split('\n').filter((line) => line.trim());
    const results: { line: number; ok: boolean; error?: string }[] = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const frame = parseFrame(line);

      if (!frame) {
        results.push({ line: i, ok: false, error: 'invalid_frame' });
        continue;
      }

      try {
        if (isSetFrame(frame)) {
          const { frame: normalizedFrame, serialized } = normalizeSetFrame(frame);
          await connectionManager.broadcast(channelId, injectChannelId(serialized, channelId));
          if (onSetFrame) {
            await onSetFrame(channelId, normalizedFrame, spaceId);
          }
        } else if (isResetFrame(frame)) {
          await connectionManager.broadcast(channelId, injectChannelId(line, channelId));
          if (onResetFrame) {
            await onResetFrame(channelId, frame.i, spaceId);
          }
        } else {
          await connectionManager.broadcast(channelId, injectChannelId(line, channelId));
        }
        results.push({ line: i, ok: true });
      } catch (error) {
        results.push({ line: i, ok: false, error: 'processing_error' });
      }
    }

    const failedCount = results.filter((r) => !r.ok).length;
    return c.json({
      ok: failedCount === 0,
      total: lines.length,
      succeeded: lines.length - failedCount,
      failed: failedCount,
      results,
    });
  });

  return app;
}
