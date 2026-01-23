import { describe, it, expect } from 'vitest';
import { parseFrame, parseFrames, serializeFrame, serializeFrameLine } from './parser.js';
import type { TymbalFrame, SetFrame } from './frames.js';

describe('Tymbal Parser', () => {
  describe('parseFrame', () => {
    it('parses bare start frame', () => {
      const result = parseFrame('{"i":"01J001"}');
      expect(result).toEqual({ i: '01J001' });
    });

    it('parses start frame with metadata', () => {
      const result = parseFrame('{"i":"01J001","m":{"type":"assistant","sender":"fox"}}');
      expect(result).toEqual({
        i: '01J001',
        m: { type: 'assistant', sender: 'fox' },
      });
    });

    it('parses append frame', () => {
      const result = parseFrame('{"i":"01J001","a":"Hello "}');
      expect(result).toEqual({ i: '01J001', a: 'Hello ' });
    });

    it('parses set frame', () => {
      const result = parseFrame(
        '{"i":"01J001","t":"2026-01-04T10:00:00.000Z","v":{"type":"assistant","content":"Hello!"}}'
      );
      expect(result).toEqual({
        i: '01J001',
        t: '2026-01-04T10:00:00.000Z',
        v: { type: 'assistant', content: 'Hello!' },
      });
    });

    it('parses reset frame', () => {
      const result = parseFrame('{"i":"01J001","v":null}');
      expect(result).toEqual({ i: '01J001', v: null });
    });

    it('parses sync request', () => {
      const result = parseFrame('{"request":"sync"}');
      expect(result).toEqual({ request: 'sync' });
    });

    it('parses sync request with since', () => {
      const result = parseFrame('{"request":"sync","since":"2026-01-04T10:00:00.000Z"}');
      expect(result).toEqual({ request: 'sync', since: '2026-01-04T10:00:00.000Z' });
    });

    it('parses sync response', () => {
      const result = parseFrame('{"sync":"2026-01-04T10:00:00.000Z"}');
      expect(result).toEqual({ sync: '2026-01-04T10:00:00.000Z' });
    });

    it('parses error frame', () => {
      const result = parseFrame('{"error":"auth_failed","message":"Invalid token"}');
      expect(result).toEqual({ error: 'auth_failed', message: 'Invalid token' });
    });

    it('parses artifact frame', () => {
      const input = JSON.stringify({
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
      });
      const result = parseFrame(input);
      expect(result).toEqual({
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
      });
    });

    // Invalid inputs
    it('returns null for invalid JSON', () => {
      expect(parseFrame('not json')).toBe(null);
    });

    it('returns null for array', () => {
      expect(parseFrame('[]')).toBe(null);
    });

    it('returns null for primitive', () => {
      expect(parseFrame('"string"')).toBe(null);
      expect(parseFrame('123')).toBe(null);
      expect(parseFrame('null')).toBe(null);
    });

    it('returns null for frame with both a and v', () => {
      expect(parseFrame('{"i":"01J001","a":"text","v":{}}')).toBe(null);
    });

    it('returns null for message frame without i', () => {
      expect(parseFrame('{"a":"text"}')).toBe(null);
    });

    it('returns null for append frame with non-string a', () => {
      expect(parseFrame('{"i":"01J001","a":123}')).toBe(null);
    });

    it('returns null for set frame with array v', () => {
      expect(parseFrame('{"i":"01J001","t":"2026-01-04T10:00:00.000Z","v":[]}')).toBe(null);
    });

    it('returns null for set frame without timestamp', () => {
      expect(parseFrame('{"i":"01J001","v":{}}')).toBe(null);
    });

    it('returns null for start frame with content in metadata', () => {
      expect(parseFrame('{"i":"01J001","m":{"content":"forbidden"}}')).toBe(null);
    });

    it('returns null for artifact frame with invalid structure', () => {
      expect(parseFrame('{"artifact":{"action":"create"}}')).toBe(null);
    });
  });

  describe('parseFrames', () => {
    it('parses multiple lines', () => {
      const input = `{"i":"01J001"}
{"i":"01J001","a":"Hello "}
{"i":"01J001","a":"world!"}
{"i":"01J001","t":"2026-01-04T10:00:00.000Z","v":{"content":"Hello world!"}}`;

      const result = parseFrames(input);
      expect(result).toHaveLength(4);
      expect(result[0]).toEqual({ i: '01J001' });
      expect(result[1]).toEqual({ i: '01J001', a: 'Hello ' });
      expect(result[2]).toEqual({ i: '01J001', a: 'world!' });
      expect(result[3]).toEqual({
        i: '01J001',
        t: '2026-01-04T10:00:00.000Z',
        v: { content: 'Hello world!' },
      });
    });

    it('ignores empty lines', () => {
      const input = `{"i":"01J001"}

{"i":"01J002"}
`;
      const result = parseFrames(input);
      expect(result).toHaveLength(2);
    });

    it('ignores invalid lines', () => {
      const input = `{"i":"01J001"}
invalid json
{"i":"01J002"}`;
      const result = parseFrames(input);
      expect(result).toHaveLength(2);
    });
  });

  describe('serializeFrame', () => {
    it('serializes frame without newline', () => {
      const frame: TymbalFrame = { i: '01J001', a: 'text' };
      const result = serializeFrame(frame);
      expect(result).toBe('{"i":"01J001","a":"text"}');
      expect(result.endsWith('\n')).toBe(false);
    });
  });

  describe('serializeFrameLine', () => {
    it('serializes frame with newline', () => {
      const frame: TymbalFrame = { i: '01J001', a: 'text' };
      const result = serializeFrameLine(frame);
      expect(result).toBe('{"i":"01J001","a":"text"}\n');
    });
  });
});
