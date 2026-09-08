import { describe, expect, it } from 'vitest';
import { findMentions, formatMention } from '../src/mention.js';

/** Just the matched text of each hit, which is what a renderer turns into a pill. */
const tokens = (text: string): string[] =>
  findMentions(text).map((m) => text.slice(m.start, m.end));

describe('formatMention', () => {
  it('quotes a Bitbucket username that needs it, and leaves a simple one bare', () => {
    expect(formatMention('bitbucket-server', { name: 'first.last' })).toBe('@"first.last"');
    expect(formatMention('bitbucket-server', { name: 'jdoe' })).toBe('@jdoe');
  });

  it('uses the bare form on GitHub / GitLab', () => {
    expect(formatMention('github', { name: 'jdoe' })).toBe('@jdoe');
    expect(formatMention('gitlab', { name: 'jdoe' })).toBe('@jdoe');
  });
});

describe('findMentions', () => {
  it('reads back both forms formatMention can write', () => {
    const quoted = formatMention('bitbucket-server', { name: 'first.last' });
    const bare = formatMention('github', { name: 'jdoe' });
    expect(findMentions(`ping ${quoted} and ${bare}`).map((m) => m.name)).toEqual([
      'first.last',
      'jdoe',
    ]);
  });

  it('finds a mention at the start of the body and after an opening bracket', () => {
    expect(tokens('@jdoe please look')).toEqual(['@jdoe']);
    expect(tokens('(@jdoe) and [@ada]')).toEqual(['@jdoe', '@ada']);
  });

  it('ignores an email address', () => {
    // The `@` has no leading boundary, so neither the local part nor the domain is a mention.
    expect(tokens('mail me at user@example.com please')).toEqual([]);
  });

  it('ignores a scoped package name', () => {
    expect(tokens('install @meebox/shared first')).toEqual([]);
    // ...but a mention immediately before a slash-free word is still found.
    expect(tokens('ask @meebox about it')).toEqual(['@meebox']);
  });

  it('leaves sentence punctuation out of the name', () => {
    expect(findMentions('thanks @jdoe.')[0]?.name).toBe('jdoe');
    expect(findMentions('cc @jdoe, @ada').map((m) => m.name)).toEqual(['jdoe', 'ada']);
  });

  it('reports offsets that exactly span the token', () => {
    const text = 'hi @jdoe there';
    const [m] = findMentions(text);
    expect(text.slice(m!.start, m!.end)).toBe('@jdoe');
  });

  it('handles several mentions in one run, including adjacent ones', () => {
    expect(tokens('@a @b @c')).toEqual(['@a', '@b', '@c']);
  });

  it('finds nothing in text without a mention', () => {
    expect(findMentions('no mentions here')).toEqual([]);
    expect(findMentions('')).toEqual([]);
  });

  it('is not confused by a stray @ or an empty quoted token', () => {
    expect(findMentions('a @ b')).toEqual([]);
    expect(findMentions('a @"" b')).toEqual([]);
  });
});
