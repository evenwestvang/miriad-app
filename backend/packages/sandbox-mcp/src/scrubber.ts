import type { SecretScrubber } from './types.js';

const REDACTED = '[REDACTED]';

// Minimum secret length to scrub — very short values cause false positives
const MIN_SECRET_LENGTH = 4;

/**
 * Creates a secret scrubber from known environment values.
 *
 * At sandbox creation time, we know exactly which secret values were injected.
 * This builds a scrubber that does exact string replacement — no regex guessing,
 * no heuristic scanning. Fast and reliable.
 *
 * Values shorter than MIN_SECRET_LENGTH are skipped to avoid false positives
 * (e.g., scrubbing "true" or "1" from output).
 */
export function createScrubber(secretValues: Record<string, string>): SecretScrubber {
  // Collect unique values worth scrubbing, sorted longest-first
  // so longer matches take priority (e.g., a token that contains a prefix)
  const values = [...new Set(Object.values(secretValues))]
    .filter(v => v.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);

  if (values.length === 0) {
    return { scrub: (text: string) => text };
  }

  // Build a single regex that matches any secret value.
  // Escape regex special characters in the values.
  const escaped = values.map(v => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(escaped.join('|'), 'g');

  return {
    scrub(text: string): string {
      return text.replace(pattern, REDACTED);
    },
  };
}
