import { describe, it, expect } from 'vitest';
import { parseMentions, determineRouting, stripMentions } from './parser.js';

describe('parseMentions', () => {
  it('parses single mention', () => {
    const result = parseMentions('@fox help me with this');
    expect(result.mentions).toEqual(['fox']);
    expect(result.isChannelMention).toBe(false);
  });

  it('parses multiple mentions', () => {
    const result = parseMentions('@fox @bear please coordinate');
    expect(result.mentions).toEqual(['fox', 'bear']);
    expect(result.isChannelMention).toBe(false);
  });

  it('deduplicates mentions', () => {
    const result = parseMentions('@fox hey @fox you there?');
    expect(result.mentions).toEqual(['fox']);
  });

  it('handles @channel mention', () => {
    const result = parseMentions('@channel status update please');
    expect(result.mentions).toEqual([]);
    expect(result.isChannelMention).toBe(true);
  });

  it('handles @channel with other mentions', () => {
    const result = parseMentions('@channel @fox important update');
    expect(result.mentions).toEqual(['fox']);
    expect(result.isChannelMention).toBe(true);
  });

  it('handles no mentions', () => {
    const result = parseMentions('just a regular message');
    expect(result.mentions).toEqual([]);
    expect(result.isChannelMention).toBe(false);
  });

  it('normalizes mentions to lowercase', () => {
    const result = parseMentions('@Fox @BEAR @Channel');
    expect(result.mentions).toEqual(['fox', 'bear']);
    expect(result.isChannelMention).toBe(true);
  });

  it('handles mentions with hyphens and underscores', () => {
    const result = parseMentions('@code-reviewer @test_agent help');
    expect(result.mentions).toEqual(['code-reviewer', 'test_agent']);
  });

  it('handles mention at end of message', () => {
    const result = parseMentions('can you help @fox');
    expect(result.mentions).toEqual(['fox']);
  });

  it('handles mention with punctuation after', () => {
    const result = parseMentions('@fox, can you help?');
    expect(result.mentions).toEqual(['fox']);
  });

  it('preserves original content', () => {
    const content = '@fox help me';
    const result = parseMentions(content);
    expect(result.content).toBe(content);
  });
});

describe('determineRouting', () => {
  const roster = {
    agents: ['fox', 'bear', 'owl'],
    leader: 'fox',
  };

  it('routes to mentioned agent', () => {
    const parsed = parseMentions('@bear help me');
    const result = determineRouting(parsed, true, roster);
    expect(result.targets).toEqual(['bear']);
    expect(result.isBroadcast).toBe(false);
  });

  it('routes to multiple mentioned agents', () => {
    const parsed = parseMentions('@fox @bear coordinate');
    const result = determineRouting(parsed, true, roster);
    expect(result.targets).toEqual(['fox', 'bear']);
    expect(result.isBroadcast).toBe(false);
  });

  it('filters out non-existent agents', () => {
    const parsed = parseMentions('@fox @unknown help');
    const result = determineRouting(parsed, true, roster);
    expect(result.targets).toEqual(['fox']);
  });

  it('broadcasts on @channel', () => {
    const parsed = parseMentions('@channel status update');
    const result = determineRouting(parsed, true, roster);
    expect(result.targets).toEqual(['fox', 'bear', 'owl']);
    expect(result.isBroadcast).toBe(true);
  });

  it('routes unaddressed human messages to leader', () => {
    const parsed = parseMentions('hello, can someone help?');
    const result = determineRouting(parsed, true, roster);
    expect(result.targets).toEqual(['fox']);
    expect(result.isBroadcast).toBe(false);
  });

  it('does not route unaddressed agent messages', () => {
    const parsed = parseMentions('I completed the task');
    const result = determineRouting(parsed, false, roster);
    expect(result.targets).toEqual([]);
    expect(result.isBroadcast).toBe(false);
  });

  it('@channel from agent still broadcasts', () => {
    const parsed = parseMentions('@channel task complete');
    const result = determineRouting(parsed, false, roster);
    expect(result.targets).toEqual(['fox', 'bear', 'owl']);
    expect(result.isBroadcast).toBe(true);
  });

  it('@channel excludes sender when provided', () => {
    const parsed = parseMentions('@channel task complete');
    const result = determineRouting(parsed, false, roster, 'fox');
    expect(result.targets).toEqual(['bear', 'owl']);
    expect(result.isBroadcast).toBe(true);
  });

  it('specific mentions exclude sender when provided', () => {
    const parsed = parseMentions('@fox @bear help me');
    const result = determineRouting(parsed, false, roster, 'fox');
    expect(result.targets).toEqual(['bear']);
    expect(result.isBroadcast).toBe(false);
  });

  it('self-mention results in empty targets', () => {
    const parsed = parseMentions('@fox thinking out loud');
    const result = determineRouting(parsed, false, roster, 'fox');
    expect(result.targets).toEqual([]);
    expect(result.isBroadcast).toBe(false);
  });
});

describe('stripMentions', () => {
  it('removes mentions from content', () => {
    expect(stripMentions('@fox help me')).toBe('help me');
  });

  it('removes multiple mentions', () => {
    expect(stripMentions('@fox @bear please coordinate')).toBe('please coordinate');
  });

  it('handles @channel', () => {
    expect(stripMentions('@channel status update')).toBe('status update');
  });

  it('normalizes whitespace', () => {
    expect(stripMentions('@fox   @bear   help')).toBe('help');
  });

  it('returns empty string if only mentions', () => {
    expect(stripMentions('@fox @bear')).toBe('');
  });

  it('handles mentions with special characters', () => {
    expect(stripMentions('@code-reviewer check this')).toBe('check this');
  });
});
