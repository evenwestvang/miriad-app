import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tymbal, createMessageHandle, generateMessageId } from './builders.js';
import { parseFrame } from './parser.js';

describe('Tymbal Builders', () => {
  describe('tymbal.start', () => {
    it('creates bare start frame', () => {
      const result = tymbal.start('01J001');
      expect(JSON.parse(result)).toEqual({ i: '01J001' });
    });

    it('creates start frame with metadata', () => {
      const result = tymbal.start('01J001', { type: 'assistant', sender: 'fox' });
      expect(JSON.parse(result)).toEqual({
        i: '01J001',
        m: { type: 'assistant', sender: 'fox' },
      });
    });

    it('throws if metadata contains content', () => {
      expect(() => tymbal.start('01J001', { type: 'assistant', content: 'forbidden' })).toThrow(
        'Metadata cannot contain reserved key "content"'
      );
    });
  });

  describe('tymbal.append', () => {
    it('creates append frame', () => {
      const result = tymbal.append('01J001', 'Hello ');
      expect(JSON.parse(result)).toEqual({ i: '01J001', a: 'Hello ' });
    });
  });

  describe('tymbal.set', () => {
    it('creates set frame with auto timestamp', () => {
      const before = new Date().toISOString();
      const result = tymbal.set('01J001', { type: 'assistant', content: 'Hello!' });
      const after = new Date().toISOString();

      const parsed = JSON.parse(result);
      expect(parsed.i).toBe('01J001');
      expect(parsed.v).toEqual({ type: 'assistant', content: 'Hello!' });
      expect(parsed.t >= before).toBe(true);
      expect(parsed.t <= after).toBe(true);
    });

    it('creates set frame with custom timestamp', () => {
      const result = tymbal.set('01J001', { content: 'test' }, '2026-01-04T10:00:00.000Z');
      const parsed = JSON.parse(result);
      expect(parsed.t).toBe('2026-01-04T10:00:00.000Z');
    });
  });

  describe('tymbal.delete', () => {
    it('creates delete frame', () => {
      const result = tymbal.delete('01J001');
      expect(JSON.parse(result)).toEqual({ i: '01J001', v: null });
    });
  });

  describe('tymbal.sync', () => {
    it('creates sync request without since', () => {
      const result = tymbal.sync();
      expect(JSON.parse(result)).toEqual({ request: 'sync' });
    });

    it('creates sync request with since', () => {
      const result = tymbal.sync('2026-01-04T10:00:00.000Z');
      expect(JSON.parse(result)).toEqual({
        request: 'sync',
        since: '2026-01-04T10:00:00.000Z',
      });
    });
  });

  describe('tymbal.syncResponse', () => {
    it('creates sync response', () => {
      const result = tymbal.syncResponse('2026-01-04T10:00:00.000Z');
      expect(JSON.parse(result)).toEqual({ sync: '2026-01-04T10:00:00.000Z' });
    });
  });

  describe('tymbal.error', () => {
    it('creates error frame with message', () => {
      const result = tymbal.error('auth_failed', 'Invalid token');
      expect(JSON.parse(result)).toEqual({ error: 'auth_failed', message: 'Invalid token' });
    });

    it('creates error frame without message', () => {
      const result = tymbal.error('rate_limited');
      expect(JSON.parse(result)).toEqual({ error: 'rate_limited' });
    });
  });

  describe('tymbal.artifact', () => {
    it('creates artifact frame', () => {
      const result = tymbal.artifact('create', 'channel-123', {
        slug: 'my-doc',
        type: 'doc',
        tldr: 'A document',
        status: 'active',
      });
      const parsed = JSON.parse(result);
      expect(parsed.artifact.action).toBe('create');
      expect(parsed.artifact.channelId).toBe('channel-123');
      expect(parsed.artifact.payload.slug).toBe('my-doc');
      expect(parsed.artifact.payload.path).toBe('/channel-123/my-doc');
    });

    it('uses custom path if provided', () => {
      const result = tymbal.artifact('update', 'ch', {
        slug: 'doc',
        type: 't',
        tldr: 't',
        status: 's',
        path: '/custom/path',
      });
      const parsed = JSON.parse(result);
      expect(parsed.artifact.payload.path).toBe('/custom/path');
    });
  });

  describe('generateMessageId', () => {
    it('generates ULID format', () => {
      const id = generateMessageId();
      expect(id).toMatch(/^[0-9A-Z]{26}$/);
    });

    it('generates unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 100; i++) {
        ids.add(generateMessageId());
      }
      expect(ids.size).toBe(100);
    });

    it('generates sortable IDs', async () => {
      const id1 = generateMessageId();
      // ULIDs use millisecond precision - wait 5ms to ensure different timestamp
      // (setTimeout(1) can return before 1ms on some systems)
      await new Promise((resolve) => setTimeout(resolve, 5));
      const id2 = generateMessageId();
      expect(id1 < id2).toBe(true);
    });
  });

  describe('createMessageHandle', () => {
    let frames: string[];
    let broadcast: (frame: string) => Promise<void>;

    beforeEach(() => {
      frames = [];
      broadcast = vi.fn(async (frame: string) => {
        frames.push(frame);
      });
    });

    it('streams text progressively', async () => {
      const handle = createMessageHandle({
        id: '01J001',
        metadata: { type: 'assistant', sender: 'fox', senderType: 'agent' as const },
        broadcast,
      });

      await handle.stream('Hello ');
      await handle.stream('world!');
      await handle.set({ content: 'Hello world!' });

      expect(frames).toHaveLength(4);

      // Start frame
      const start = JSON.parse(frames[0]);
      expect(start.i).toBe('01J001');
      expect(start.m.type).toBe('assistant');

      // Append frames
      expect(JSON.parse(frames[1])).toEqual({ i: '01J001', a: 'Hello ' });
      expect(JSON.parse(frames[2])).toEqual({ i: '01J001', a: 'world!' });

      // Set frame with merged content
      const set = JSON.parse(frames[3]);
      expect(set.i).toBe('01J001');
      expect(set.v.type).toBe('assistant');
      expect(set.v.content).toBe('Hello world!');
    });

    it('sends set directly when not streaming', async () => {
      const handle = createMessageHandle({
        id: '01J001',
        broadcast,
      });

      await handle.set({ type: 'user', content: 'Hello!' });

      expect(frames).toHaveLength(1);
      const set = JSON.parse(frames[0]);
      expect(set.i).toBe('01J001');
      expect(set.v).toEqual({ type: 'user', content: 'Hello!' });
    });

    it('throws when streaming to finalized message', async () => {
      const handle = createMessageHandle({
        id: '01J001',
        broadcast,
      });

      await handle.set({ content: 'done' });

      await expect(handle.stream('more')).rejects.toThrow('Cannot stream to a finalized message');
    });

    it('throws when setting finalized message', async () => {
      const handle = createMessageHandle({
        id: '01J001',
        broadcast,
      });

      await handle.set({ content: 'done' });

      await expect(handle.set({ content: 'again' })).rejects.toThrow(
        'Cannot set a finalized message'
      );
    });

    it('can delete message', async () => {
      const handle = createMessageHandle({
        id: '01J001',
        broadcast,
      });

      await handle.delete();

      expect(frames).toHaveLength(1);
      expect(JSON.parse(frames[0])).toEqual({ i: '01J001', v: null });
    });
  });

  describe('round-trip parsing', () => {
    it('all built frames can be parsed', () => {
      const frames = [
        tymbal.start('01J001'),
        tymbal.start('01J001', { type: 'assistant' }),
        tymbal.append('01J001', 'text'),
        tymbal.set('01J001', { content: 'test' }),
        tymbal.delete('01J001'),
        tymbal.sync(),
        tymbal.sync('2026-01-04T10:00:00.000Z'),
        tymbal.syncResponse('2026-01-04T10:00:00.000Z'),
        tymbal.error('test', 'message'),
        tymbal.artifact('create', 'ch', { slug: 's', type: 't', tldr: 't', status: 's' }),
      ];

      for (const frame of frames) {
        const parsed = parseFrame(frame);
        expect(parsed).not.toBe(null);
      }
    });
  });
});
