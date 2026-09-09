import { describe, expect, it } from 'vitest';
import {
  LOOPBACK_NO_PROXY,
  matchesNoProxy,
  normalizeNoProxy,
  parseNoProxy,
} from '../src/no-proxy.js';

describe('parseNoProxy', () => {
  it('accepts commas, whitespace and newlines as separators', () => {
    expect(parseNoProxy('a.com, b.com\nc.com  d.com')).toEqual([
      'a.com',
      'b.com',
      'c.com',
      'd.com',
    ]);
  });

  it('normalizes case, leading dots and port suffixes', () => {
    expect(parseNoProxy('.Corp.EXAMPLE.com, git.corp.com:7999')).toEqual([
      'corp.example.com',
      'git.corp.com',
    ]);
  });

  it('drops empty entries, and treats an absent value as no rules', () => {
    expect(parseNoProxy(' , ,\n')).toEqual([]);
    expect(parseNoProxy(undefined)).toEqual([]);
    expect(parseNoProxy('')).toEqual([]);
  });

  it('keeps IPv6 literals, with or without brackets', () => {
    expect(parseNoProxy('[fe80::1], ::1')).toEqual(['fe80::1', '::1']);
  });
});

describe('normalizeNoProxy', () => {
  it('collapses to one comma-separated line and deduplicates', () => {
    expect(normalizeNoProxy('a.com\n.a.com\nb.com, a.com')).toBe('a.com,b.com');
  });
});

describe('matchesNoProxy', () => {
  it('matches the domain itself and its subdomains', () => {
    expect(matchesNoProxy('corp.example.com', 'corp.example.com')).toBe(true);
    expect(matchesNoProxy('git.corp.example.com', 'corp.example.com')).toBe(true);
    // A leading dot means the same thing: users expect it to cover the bare domain too.
    expect(matchesNoProxy('corp.example.com', '.corp.example.com')).toBe(true);
  });

  it('does not match a host that merely ends with the rule text', () => {
    // The suffix must fall on a label boundary, or "evil-example.com" would bypass a rule for "example.com".
    expect(matchesNoProxy('evil-example.com', 'example.com')).toBe(false);
    expect(matchesNoProxy('notexample.com', 'example.com')).toBe(false);
  });

  it('is case-insensitive and ignores ports on either side', () => {
    expect(matchesNoProxy('GIT.Corp.COM', 'corp.com')).toBe(true);
    expect(matchesNoProxy('git.corp.com:7999', 'corp.com')).toBe(true);
    expect(matchesNoProxy('git.corp.com', 'corp.com:7999')).toBe(true);
  });

  it('matches IP literals exactly, not as a suffix', () => {
    expect(matchesNoProxy('10.0.0.5', '10.0.0.5')).toBe(true);
    expect(matchesNoProxy('10.0.0.50', '10.0.0.5')).toBe(false);
    expect(matchesNoProxy('[fe80::1]', 'fe80::1')).toBe(true);
  });

  it('supports the wildcard, and treats no rules as no bypass', () => {
    expect(matchesNoProxy('anything.com', '*')).toBe(true);
    expect(matchesNoProxy('anything.com', '')).toBe(false);
    expect(matchesNoProxy('anything.com', undefined)).toBe(false);
  });

  // How both egress paths compose the effective rules: the built-in loopback set prepended to the user's (see the
  // desktop proxy plumbing). Asserted here so the guarantee holds no matter what the user typed.
  describe('composed with the built-in loopback set', () => {
    const effective = (userRules: string): string =>
      normalizeNoProxy(`${LOOPBACK_NO_PROXY},${userRules}`);

    it('keeps local addresses direct even when the user configured nothing', () => {
      expect(matchesNoProxy('localhost', effective(''))).toBe(true);
      expect(matchesNoProxy('127.0.0.1', effective(''))).toBe(true);
      expect(matchesNoProxy('[::1]', effective(''))).toBe(true);
      expect(matchesNoProxy('api.openai.com', effective(''))).toBe(false);
    });

    it('bypasses the user rules alongside loopback, leaving everything else proxied', () => {
      const rules = effective('corp.example.com\n10.0.0.5');
      expect(matchesNoProxy('git.corp.example.com', rules)).toBe(true);
      expect(matchesNoProxy('10.0.0.5', rules)).toBe(true);
      expect(matchesNoProxy('localhost', rules)).toBe(true);
      expect(matchesNoProxy('api.openai.com', rules)).toBe(false);
    });
  });

  it('does not support CIDR: a range is not silently treated as a match', () => {
    // Documented limitation — honouring it here while the subprocess egresses did not would make the two disagree.
    expect(matchesNoProxy('10.0.0.5', '10.0.0.0/8')).toBe(false);
  });
});
