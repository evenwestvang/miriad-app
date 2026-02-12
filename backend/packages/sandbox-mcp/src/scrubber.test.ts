import { describe, it, expect } from 'vitest';
import { createScrubber } from './scrubber.js';
import { deepScrub } from './tools.js';

describe('createScrubber', () => {
  it('scrubs known secret values from text', () => {
    const scrubber = createScrubber({
      API_KEY: 'sk-secret-key-12345',
      DB_PASSWORD: 'hunter2',
    });

    expect(scrubber.scrub('Connected with sk-secret-key-12345')).toBe(
      'Connected with [REDACTED]',
    );
    expect(scrubber.scrub('Password: hunter2')).toBe('Password: [REDACTED]');
  });

  it('scrubs multiple occurrences', () => {
    const scrubber = createScrubber({ TOKEN: 'abc123xyz' });
    expect(scrubber.scrub('token=abc123xyz&verify=abc123xyz')).toBe(
      'token=[REDACTED]&verify=[REDACTED]',
    );
  });

  it('scrubs multiple different secrets in one string', () => {
    const scrubber = createScrubber({
      KEY_A: 'secret-a',
      KEY_B: 'secret-b',
    });
    expect(scrubber.scrub('a=secret-a b=secret-b')).toBe(
      'a=[REDACTED] b=[REDACTED]',
    );
  });

  it('handles overlapping secrets (longer match wins)', () => {
    const scrubber = createScrubber({
      SHORT: 'abcd',
      LONG: 'abcdefgh',
    });
    // Longer match should be replaced first
    expect(scrubber.scrub('value: abcdefgh')).toBe('value: [REDACTED]');
  });

  it('skips values shorter than 4 characters', () => {
    const scrubber = createScrubber({
      BOOL: 'yes',
      NUM: '42',
      EMPTY: '',
    });
    expect(scrubber.scrub('yes 42')).toBe('yes 42');
  });

  it('returns identity function when no scrubable values', () => {
    const scrubber = createScrubber({});
    expect(scrubber.scrub('anything')).toBe('anything');
  });

  it('handles regex special characters in secret values', () => {
    const scrubber = createScrubber({
      REGEX_KEY: 'secret+value.with$special(chars)',
    });
    expect(scrubber.scrub('key=secret+value.with$special(chars)')).toBe(
      'key=[REDACTED]',
    );
  });

  it('deduplicates identical values', () => {
    const scrubber = createScrubber({
      KEY_1: 'same-secret',
      KEY_2: 'same-secret',
    });
    expect(scrubber.scrub('value: same-secret')).toBe('value: [REDACTED]');
  });
});

describe('deepScrub', () => {
  const scrub = (text: string) => text.replace(/secret-token/g, '[REDACTED]');

  it('scrubs string values', () => {
    expect(deepScrub('contains secret-token here', scrub)).toBe('contains [REDACTED] here');
  });

  it('scrubs nested object string values', () => {
    const input = { output: 'has secret-token', nested: { deep: 'also secret-token' } };
    expect(deepScrub(input, scrub)).toEqual({
      output: 'has [REDACTED]',
      nested: { deep: 'also [REDACTED]' },
    });
  });

  it('scrubs array elements', () => {
    const input = ['secret-token', 'clean', 'another secret-token'];
    expect(deepScrub(input, scrub)).toEqual(['[REDACTED]', 'clean', 'another [REDACTED]']);
  });

  it('passes through non-string primitives', () => {
    expect(deepScrub(42, scrub)).toBe(42);
    expect(deepScrub(true, scrub)).toBe(true);
    expect(deepScrub(null, scrub)).toBe(null);
  });

  it('prevents JSON escaping bypass', () => {
    // This is the key test: a secret containing newlines/quotes would be escaped
    // by JSON.stringify, bypassing a post-serialization regex scrub.
    // deepScrub operates on raw strings BEFORE serialization.
    const secretWithNewline = 'line1\nline2-secret-token';
    const input = { result: secretWithNewline };
    const scrubbed = deepScrub(input, scrub) as any;
    // The raw string is scrubbed before JSON.stringify can escape the \n
    expect(scrubbed.result).toBe('line1\nline2-[REDACTED]');
    // And when serialized, the scrubbed value is safe
    const json = JSON.stringify(scrubbed);
    expect(json).not.toContain('secret-token');
  });

  it('handles mixed nested structures', () => {
    const input = {
      files: [{ path: '/tmp', content: 'secret-token in file' }],
      count: 3,
      success: true,
    };
    expect(deepScrub(input, scrub)).toEqual({
      files: [{ path: '/tmp', content: '[REDACTED] in file' }],
      count: 3,
      success: true,
    });
  });
});
