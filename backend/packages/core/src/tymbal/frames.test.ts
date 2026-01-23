import { describe, it, expect } from 'vitest';
import {
  isStartFrame,
  isAppendFrame,
  isSetFrame,
  isResetFrame,
  isSyncRequest,
  isSyncResponse,
  isErrorFrame,
  isArtifactFrame,
  isMessageFrame,
  isControlFrame,
  type TymbalFrame,
} from './frames.js';

describe('Tymbal Frame Type Guards', () => {
  describe('isStartFrame', () => {
    it('returns true for bare start frame', () => {
      const frame: TymbalFrame = { i: '01J001' };
      expect(isStartFrame(frame)).toBe(true);
    });

    it('returns true for start frame with metadata', () => {
      const frame: TymbalFrame = {
        i: '01J001',
        m: { type: 'assistant', sender: 'fox', senderType: 'agent' },
      };
      expect(isStartFrame(frame)).toBe(true);
    });

    it('returns false for append frame', () => {
      const frame: TymbalFrame = { i: '01J001', a: 'hello' };
      expect(isStartFrame(frame)).toBe(false);
    });

    it('returns false for set frame', () => {
      const frame: TymbalFrame = {
        i: '01J001',
        t: '2026-01-04T10:00:00.000Z',
        v: { type: 'assistant' },
      };
      expect(isStartFrame(frame)).toBe(false);
    });
  });

  describe('isAppendFrame', () => {
    it('returns true for append frame', () => {
      const frame: TymbalFrame = { i: '01J001', a: 'Hello ' };
      expect(isAppendFrame(frame)).toBe(true);
    });

    it('returns false for start frame', () => {
      const frame: TymbalFrame = { i: '01J001' };
      expect(isAppendFrame(frame)).toBe(false);
    });
  });

  describe('isSetFrame', () => {
    it('returns true for set frame', () => {
      const frame: TymbalFrame = {
        i: '01J001',
        t: '2026-01-04T10:00:00.000Z',
        v: { type: 'assistant', content: 'Hello!' },
      };
      expect(isSetFrame(frame)).toBe(true);
    });

    it('returns false for reset frame', () => {
      const frame: TymbalFrame = { i: '01J001', v: null };
      expect(isSetFrame(frame)).toBe(false);
    });
  });

  describe('isResetFrame', () => {
    it('returns true for reset frame', () => {
      const frame: TymbalFrame = { i: '01J001', v: null };
      expect(isResetFrame(frame)).toBe(true);
    });

    it('returns false for set frame', () => {
      const frame: TymbalFrame = {
        i: '01J001',
        t: '2026-01-04T10:00:00.000Z',
        v: { type: 'assistant' },
      };
      expect(isResetFrame(frame)).toBe(false);
    });
  });

  describe('isSyncRequest', () => {
    it('returns true for sync request without since', () => {
      const frame: TymbalFrame = { request: 'sync' };
      expect(isSyncRequest(frame)).toBe(true);
    });

    it('returns true for sync request with since', () => {
      const frame: TymbalFrame = { request: 'sync', since: '2026-01-04T10:00:00.000Z' };
      expect(isSyncRequest(frame)).toBe(true);
    });
  });

  describe('isSyncResponse', () => {
    it('returns true for sync response', () => {
      const frame: TymbalFrame = { sync: '2026-01-04T10:00:00.000Z' };
      expect(isSyncResponse(frame)).toBe(true);
    });
  });

  describe('isErrorFrame', () => {
    it('returns true for error frame', () => {
      const frame: TymbalFrame = { error: 'auth_failed', message: 'Invalid token' };
      expect(isErrorFrame(frame)).toBe(true);
    });

    it('returns true for error frame without message', () => {
      const frame: TymbalFrame = { error: 'rate_limited' };
      expect(isErrorFrame(frame)).toBe(true);
    });
  });

  describe('isArtifactFrame', () => {
    it('returns true for artifact frame', () => {
      const frame: TymbalFrame = {
        artifact: {
          action: 'create',
          channelId: 'channel-123',
          payload: {
            slug: 'my-doc',
            type: 'doc',
            tldr: 'A document',
            status: 'active',
            path: '/channel-123/my-doc',
          },
        },
      };
      expect(isArtifactFrame(frame)).toBe(true);
    });
  });

  describe('isMessageFrame / isControlFrame', () => {
    it('classifies message frames correctly', () => {
      const frames: TymbalFrame[] = [
        { i: '01J001' },
        { i: '01J001', a: 'text' },
        { i: '01J001', t: '2026-01-04T10:00:00.000Z', v: {} },
        { i: '01J001', v: null },
      ];

      for (const frame of frames) {
        expect(isMessageFrame(frame)).toBe(true);
        expect(isControlFrame(frame)).toBe(false);
      }
    });

    it('classifies control frames correctly', () => {
      const frames: TymbalFrame[] = [
        { request: 'sync' },
        { sync: '2026-01-04T10:00:00.000Z' },
        { error: 'test' },
        {
          artifact: {
            action: 'create',
            channelId: 'ch',
            payload: { slug: 's', type: 't', tldr: 't', status: 's', path: '/p' },
          },
        },
      ];

      for (const frame of frames) {
        expect(isControlFrame(frame)).toBe(true);
        expect(isMessageFrame(frame)).toBe(false);
      }
    });
  });
});
