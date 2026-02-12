import { describe, it, expect } from 'vitest';
import { createScrubber } from './scrubber.js';

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
