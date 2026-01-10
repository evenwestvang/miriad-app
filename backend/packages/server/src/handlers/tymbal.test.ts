import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { createTymbalRoutes } from './tymbal.js';
import { tymbal, type SetFrame } from '@cast/core';
import { generateContainerToken } from '../auth/index.js';
import type { ConnectionManager } from '../websocket/index.js';

// Mock connection manager
function createMockConnectionManager(): ConnectionManager & {
  broadcastCalls: Array<{ channelId: string; frame: string }>;
} {
  const broadcastCalls: Array<{ channelId: string; frame: string }> = [];

  return {
    broadcastCalls,
    addConnection: vi.fn(),
    removeConnection: vi.fn(),
    getChannelConnections: vi.fn(() => []),
    getConnection: vi.fn(),
    broadcast: vi.fn(async (channelId: string, frame: string) => {
      broadcastCalls.push({ channelId, frame });
    }),
    send: vi.fn(),
    getConnectionCount: vi.fn(() => 0),
    getChannelConnectionCount: vi.fn(() => 0),
    closeAll: vi.fn(),
  };
}

describe('Tymbal Routes', () => {
  let app: Hono;
  let mockConnectionManager: ReturnType<typeof createMockConnectionManager>;
  let onSetFrame: ReturnType<typeof vi.fn>;
  let onResetFrame: ReturnType<typeof vi.fn>;
  let token: string;

  beforeEach(() => {
    mockConnectionManager = createMockConnectionManager();
    onSetFrame = vi.fn();
    onResetFrame = vi.fn();

    const tymbalRoutes = createTymbalRoutes({
      connectionManager: mockConnectionManager,
      onSetFrame,
      onResetFrame,
    });

    app = new Hono();
    app.route('/tymbal', tymbalRoutes);

    // Generate a valid container token
    token = generateContainerToken({
      spaceId: 'space-1',
      channelId: 'channel-1',
      callsign: 'fox',
    });
  });

  // Helper to make requests
  async function req(
    path: string,
    options: { method?: string; headers?: Record<string, string>; body?: string } = {}
  ) {
    return app.request(path, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
    });
  }

  describe('POST /tymbal/:channelId', () => {
    it('requires container auth', async () => {
      const res = await app.request('/tymbal/channel-1', {
        method: 'POST',
        body: tymbal.start('01J001'),
      });

      expect(res.status).toBe(401);
    });

    it('broadcasts start frame', async () => {
      const frame = tymbal.start('01J001', { type: 'assistant' });

      const res = await app.request('/tymbal/channel-1', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: frame,
      });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(mockConnectionManager.broadcastCalls).toHaveLength(1);
      // Frame gets channelId injected as 'c' field for client routing
      const broadcastedFrame = JSON.parse(mockConnectionManager.broadcastCalls[0].frame);
      expect(broadcastedFrame.i).toBe('01J001');
      expect(broadcastedFrame.m).toEqual({ type: 'assistant' });
      expect(broadcastedFrame.c).toBe('channel-1');
    });

    it('broadcasts append frame', async () => {
      const frame = tymbal.append('01J001', 'Hello world');

      const res = await app.request('/tymbal/channel-1', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: frame,
      });

      expect(res.status).toBe(200);
      // Frame gets channelId injected as 'c' field for client routing
      const broadcastedFrame = JSON.parse(mockConnectionManager.broadcastCalls[0].frame);
      expect(broadcastedFrame.i).toBe('01J001');
      expect(broadcastedFrame.a).toBe('Hello world');
      expect(broadcastedFrame.c).toBe('channel-1');
    });

    it('broadcasts and persists set frame', async () => {
      const frame = tymbal.set('01J001', {
        type: 'assistant',
        sender: 'fox',
        content: 'Hello!',
      });

      const res = await app.request('/tymbal/channel-1', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: frame,
      });

      expect(res.status).toBe(200);
      expect(mockConnectionManager.broadcastCalls).toHaveLength(1);
      expect(onSetFrame).toHaveBeenCalledTimes(1);
      expect(onSetFrame).toHaveBeenCalledWith('channel-1', expect.objectContaining({
        i: '01J001',
        v: expect.objectContaining({ type: 'assistant', content: 'Hello!' }),
      }), 'space-1');
    });

    it('normalizes tool_call input to args', async () => {
      // Send with 'input' field (Anthropic SDK style)
      const frame = JSON.stringify({
        i: '01J001',
        t: new Date().toISOString(),
        v: {
          type: 'tool_call',
          sender: 'fox',
          id: 'call_123',
          name: 'search',
          input: { query: 'test' },  // Note: 'input' not 'args'
        },
      });

      const res = await app.request('/tymbal/channel-1', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: frame,
      });

      expect(res.status).toBe(200);

      // Check broadcast received normalized frame
      const broadcastedFrame = JSON.parse(mockConnectionManager.broadcastCalls[0].frame);
      expect(broadcastedFrame.v.args).toEqual({ query: 'test' });
      expect(broadcastedFrame.v.input).toBeUndefined();

      // Check persistence received normalized frame
      const persistedFrame = onSetFrame.mock.calls[0][1] as SetFrame;
      expect(persistedFrame.v.args).toEqual({ query: 'test' });
    });

    it('broadcasts and handles reset frame', async () => {
      const frame = tymbal.delete('01J001');

      const res = await app.request('/tymbal/channel-1', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: frame,
      });

      expect(res.status).toBe(200);
      expect(mockConnectionManager.broadcastCalls).toHaveLength(1);
      expect(onResetFrame).toHaveBeenCalledWith('channel-1', '01J001', 'space-1');
    });

    it('rejects empty body', async () => {
      const res = await app.request('/tymbal/channel-1', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: '',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('empty_body');
    });

    it('rejects invalid frame', async () => {
      const res = await app.request('/tymbal/channel-1', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: 'not valid json',
      });

      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_frame');
    });
  });

  describe('POST /tymbal/:channelId/batch', () => {
    it('processes multiple frames', async () => {
      const frames = [
        tymbal.start('01J001', { type: 'assistant' }),
        tymbal.append('01J001', 'Hello '),
        tymbal.append('01J001', 'world!'),
        tymbal.set('01J001', { type: 'assistant', content: 'Hello world!' }),
      ].join('\n');

      const res = await app.request('/tymbal/channel-1/batch', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: frames,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(true);
      expect(json.total).toBe(4);
      expect(json.succeeded).toBe(4);
      expect(json.failed).toBe(0);
      expect(mockConnectionManager.broadcastCalls).toHaveLength(4);
    });

    it('reports partial failures', async () => {
      const frames = [
        tymbal.start('01J001'),
        'invalid json',
        tymbal.append('01J001', 'text'),
      ].join('\n');

      const res = await app.request('/tymbal/channel-1/batch', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: frames,
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.ok).toBe(false);
      expect(json.total).toBe(3);
      expect(json.succeeded).toBe(2);
      expect(json.failed).toBe(1);
      expect(json.results[1]).toEqual({ line: 1, ok: false, error: 'invalid_frame' });
    });

    it('rejects empty body', async () => {
      const res = await app.request('/tymbal/channel-1/batch', {
        method: 'POST',
        headers: { Authorization: `Container ${token}` },
        body: '',
      });

      expect(res.status).toBe(400);
    });
  });
});
