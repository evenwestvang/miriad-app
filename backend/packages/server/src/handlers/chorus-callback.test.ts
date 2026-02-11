/**
 * Chorus Callback Handler Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import {
  createChorusCallbackRoutes,
  generateCallbackToken,
  verifyCallbackToken,
} from './chorus-callback.js';
import type { Storage } from '@cast/storage';

// =============================================================================
// Test Helpers
// =============================================================================

const testSpaceId = 'test-space-chorus';
const testChannelId = 'test-channel-chorus';
const testCallsign = 'test-agent';

function createMockStorage(): Partial<Storage> {
  return {
    getRosterByCallsign: vi.fn(async () => ({
      id: 'roster-1',
      channelId: testChannelId,
      callsign: testCallsign,
      agentType: 'chorus',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
    })),
    saveMessage: vi.fn(async (input) => ({
      id: input.id ?? 'msg-1',
      spaceId: input.spaceId,
      channelId: input.channelId,
      sender: input.sender,
      senderType: input.senderType,
      type: input.type,
      content: input.content,
      isComplete: true,
      timestamp: new Date().toISOString(),
    })),
    updateRosterEntry: vi.fn(async () => {}),
    getChannelById: vi.fn(async () => ({
      id: testChannelId,
      spaceId: testSpaceId,
      name: 'test-channel',
      archived: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
    })),
  };
}

function createTestApp(storage: Partial<Storage>, broadcast = vi.fn(async () => {})) {
  const app = new Hono();
  const routes = createChorusCallbackRoutes({
    storage: storage as Storage,
    broadcast,
  });
  app.route('/api/chorus', routes);
  return { app, broadcast };
}

function makeRequest(app: Hono, token: string, body: unknown) {
  return app.request(`/api/chorus/callback/${token}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('Chorus Callback', () => {
  describe('Token generation and verification', () => {
    it('should generate and verify a callback token', () => {
      const token = generateCallbackToken(testSpaceId, testChannelId, testCallsign);
      const payload = verifyCallbackToken(token);

      expect(payload).not.toBeNull();
      expect(payload!.spaceId).toBe(testSpaceId);
      expect(payload!.channelId).toBe(testChannelId);
      expect(payload!.callsign).toBe(testCallsign);
    });

    it('should reject invalid tokens', () => {
      expect(verifyCallbackToken('invalid')).toBeNull();
      expect(verifyCallbackToken('a.b.c')).toBeNull();
      expect(verifyCallbackToken('')).toBeNull();
    });
  });

  describe('Callback endpoint', () => {
    let storage: Partial<Storage>;
    let broadcast: ReturnType<typeof vi.fn>;
    let app: Hono;
    let token: string;

    beforeEach(() => {
      storage = createMockStorage();
      const result = createTestApp(storage);
      app = result.app;
      broadcast = result.broadcast;
      token = generateCallbackToken(testSpaceId, testChannelId, testCallsign);
    });

    it('should reject invalid callback token', async () => {
      const res = await makeRequest(app, 'invalid-token', { type: 'lifecycle', status: 'processing' });
      expect(res.status).toBe(401);
    });

    it('should reject missing event type', async () => {
      const res = await makeRequest(app, token, { content: 'hello' });
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toContain('Missing event type');
    });

    it('should reject unknown event type', async () => {
      const res = await makeRequest(app, token, { type: 'unknown_type' });
      expect(res.status).toBe(400);
    });

    it('should reject events from paused agents', async () => {
      (storage.getRosterByCallsign as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        id: 'roster-1',
        channelId: testChannelId,
        callsign: testCallsign,
        agentType: 'chorus',
        status: 'paused',
        createdAt: new Date().toISOString(),
      });

      const res = await makeRequest(app, token, { type: 'lifecycle', status: 'processing' });
      expect(res.status).toBe(403);
    });

    it('should reject events from agents not in roster', async () => {
      (storage.getRosterByCallsign as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);

      const res = await makeRequest(app, token, { type: 'lifecycle', status: 'processing' });
      expect(res.status).toBe(404);
    });

    // -----------------------------------------------------------------------
    // Lifecycle events
    // -----------------------------------------------------------------------

    it('should handle lifecycle:processing → broadcast online', async () => {
      const res = await makeRequest(app, token, { type: 'lifecycle', status: 'processing' });
      expect(res.status).toBe(200);

      expect(broadcast).toHaveBeenCalledTimes(1);
      const broadcastedFrame = JSON.parse(broadcast.mock.calls[0][1]);
      expect(broadcastedFrame.v.type).toBe('agent_state');
      expect(broadcastedFrame.v.state).toBe('online');
      expect(broadcastedFrame.v.sender).toBe(testCallsign);
    });

    it('should handle lifecycle:idle → broadcast idle frame', async () => {
      const res = await makeRequest(app, token, { type: 'lifecycle', status: 'idle' });
      expect(res.status).toBe(200);

      expect(broadcast).toHaveBeenCalledTimes(1);
      const broadcastedFrame = JSON.parse(broadcast.mock.calls[0][1]);
      expect(broadcastedFrame.v.type).toBe('idle');
      expect(broadcastedFrame.v.sender).toBe(testCallsign);
    });

    it('should reject unknown lifecycle status', async () => {
      const res = await makeRequest(app, token, { type: 'lifecycle', status: 'unknown' });
      expect(res.status).toBe(400);
    });

    // -----------------------------------------------------------------------
    // Message events
    // -----------------------------------------------------------------------

    it('should handle message event → store + broadcast', async () => {
      const res = await makeRequest(app, token, { type: 'message', content: 'Hello from Chorus!' });
      expect(res.status).toBe(200);

      // Should store message
      expect(storage.saveMessage).toHaveBeenCalledTimes(1);
      const savedMsg = (storage.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(savedMsg.sender).toBe(testCallsign);
      expect(savedMsg.type).toBe('agent');
      expect(savedMsg.content).toEqual({ text: 'Hello from Chorus!' });
      expect(savedMsg.metadata).toEqual({ fromChorus: true });

      // Should broadcast
      expect(broadcast).toHaveBeenCalledTimes(1);
      const broadcastedFrame = JSON.parse(broadcast.mock.calls[0][1]);
      expect(broadcastedFrame.v.content).toBe('Hello from Chorus!');
    });

    it('should reject message event without content', async () => {
      const res = await makeRequest(app, token, { type: 'message' });
      expect(res.status).toBe(400);
    });

    // -----------------------------------------------------------------------
    // Tool call/result events
    // -----------------------------------------------------------------------

    it('should handle tool_call event → store + broadcast', async () => {
      const toolCall = {
        type: 'tool_call',
        name: 'send_message',
        arguments: { content: 'test' },
      };
      const res = await makeRequest(app, token, toolCall);
      expect(res.status).toBe(200);

      expect(storage.saveMessage).toHaveBeenCalledTimes(1);
      const savedMsg = (storage.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(savedMsg.type).toBe('tool_call');
    });

    it('should handle tool_result event → store + broadcast', async () => {
      const toolResult = {
        type: 'tool_result',
        name: 'send_message',
        result: { success: true },
      };
      const res = await makeRequest(app, token, toolResult);
      expect(res.status).toBe(200);

      expect(storage.saveMessage).toHaveBeenCalledTimes(1);
      const savedMsg = (storage.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(savedMsg.type).toBe('tool_result');
    });

    // -----------------------------------------------------------------------
    // Error events
    // -----------------------------------------------------------------------

    it('should handle error event → store + broadcast', async () => {
      const res = await makeRequest(app, token, { type: 'error', message: 'Something went wrong' });
      expect(res.status).toBe(200);

      expect(storage.saveMessage).toHaveBeenCalledTimes(1);
      const savedMsg = (storage.saveMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(savedMsg.type).toBe('error');
      expect(savedMsg.content).toEqual({ text: 'Something went wrong' });
    });

    // -----------------------------------------------------------------------
    // Status events (ignored)
    // -----------------------------------------------------------------------

    it('should ignore status events (agent uses MCP set_status)', async () => {
      const res = await makeRequest(app, token, { type: 'status', text: 'Searching...' });
      expect(res.status).toBe(200);

      // Should NOT store a message or broadcast
      expect(storage.saveMessage).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();

      // Should still update heartbeat
      expect(storage.updateRosterEntry).toHaveBeenCalled();
    });

    // -----------------------------------------------------------------------
    // Heartbeat updates
    // -----------------------------------------------------------------------

    it('should update roster heartbeat on every event', async () => {
      await makeRequest(app, token, { type: 'lifecycle', status: 'processing' });

      expect(storage.updateRosterEntry).toHaveBeenCalledWith(
        testChannelId,
        'roster-1',
        expect.objectContaining({ lastHeartbeat: expect.any(String) })
      );
    });
  });
});
