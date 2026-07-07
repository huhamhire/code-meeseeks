import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatTimestamp } from '../src/time-format.js';

describe('formatTimestamp', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Fixed "now" = 2026-07-07 10:00:00 local (so same-day detection is deterministic).
    vi.setSystemTime(new Date(2026, 6, 7, 10, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('same day → time only, 24-hour HH:mm:ss', () => {
    expect(formatTimestamp(new Date(2026, 6, 7, 22, 38, 20))).toBe('22:38:20');
  });

  it('other day → full yyyy-mm-dd HH:mm:ss', () => {
    expect(formatTimestamp(new Date(2026, 6, 5, 22, 38, 20))).toBe('2026-07-05 22:38:20');
  });

  it('{ full: true } forces the date even on the same day', () => {
    expect(formatTimestamp(new Date(2026, 6, 7, 9, 5, 3), { full: true })).toBe(
      '2026-07-07 09:05:03',
    );
  });

  it('zero-pads single-digit month / day / time fields', () => {
    expect(formatTimestamp(new Date(2026, 0, 3, 4, 5, 6), { full: true })).toBe(
      '2026-01-03 04:05:06',
    );
  });

  it('accepts a millisecond timestamp and an ISO string (same instant → same output)', () => {
    const d = new Date(2026, 6, 7, 8, 9, 10);
    expect(formatTimestamp(d.getTime())).toBe('08:09:10');
    // ISO round-trips to the same instant; local-field formatting yields the original local time.
    expect(formatTimestamp(d.toISOString())).toBe('08:09:10');
  });

  it('returns the raw string for an unparseable input, "" for an unparseable non-string', () => {
    expect(formatTimestamp('not-a-date')).toBe('not-a-date');
    expect(formatTimestamp(Number.NaN)).toBe('');
  });
});

describe('formatDate', () => {
  it('formats yyyy-mm-dd (local, no time)', () => {
    expect(formatDate(new Date(2026, 6, 5, 23, 0, 0))).toBe('2026-07-05');
    expect(formatDate(new Date(2026, 0, 9))).toBe('2026-01-09');
  });

  it('returns the raw string for an unparseable input', () => {
    expect(formatDate('nope')).toBe('nope');
  });
});
