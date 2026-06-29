import { describe, expect, it } from 'vitest';
import type { PlatformUser, PrComment, StoredPullRequest } from '@meebox/shared';
import { collectCommentsToMeAt, latestCommentToMeAt } from '../src/unread.js';
import {
  computeUnread,
  computeUnreadMentionCount,
  type PrIndexEntry,
  type PrReadStateFile,
} from '../src/pr-state.js';

const me: PlatformUser = { name: 'alice', displayName: 'Alice', slug: 'alice-slug' };
const bob: PlatformUser = { name: 'bob', displayName: 'Bob' };

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';

function comment(overrides: Partial<PrComment> & Pick<PrComment, 'author' | 'body'>): PrComment {
  return {
    remoteId: 'c1',
    createdAt: T1,
    updatedAt: T1,
    anchor: null,
    replies: [],
    ...overrides,
  };
}

describe('latestCommentToMeAt', () => {
  it('detects an @mention by name', () => {
    const comments = [comment({ author: bob, body: 'ping @alice please look' })];
    expect(latestCommentToMeAt(comments, me)).toBe(T1);
  });

  it('detects an @mention by slug', () => {
    const comments = [comment({ author: bob, body: 'cc @alice-slug' })];
    expect(latestCommentToMeAt(comments, me)).toBe(T1);
  });

  it('does not match a different handle that contains mine as a prefix', () => {
    const comments = [comment({ author: bob, body: 'thanks @alicia' })];
    expect(latestCommentToMeAt(comments, me)).toBeNull();
  });

  it('detects a reply to my comment', () => {
    const comments = [
      comment({
        author: me,
        body: 'my top-level comment',
        replies: [comment({ author: bob, body: 'I disagree' })],
      }),
    ];
    expect(latestCommentToMeAt(comments, me)).toBe(T1);
  });

  it('ignores comments authored by me (self mention / self reply)', () => {
    const comments = [comment({ author: me, body: 'note to self @alice' })];
    expect(latestCommentToMeAt(comments, me)).toBeNull();
  });

  it('ignores unrelated comments (no mention, not a reply to me)', () => {
    const comments = [comment({ author: bob, body: 'general chatter' })];
    expect(latestCommentToMeAt(comments, me)).toBeNull();
  });

  it('does not flag a reply to someone else', () => {
    const comments = [
      comment({
        author: bob,
        body: 'bob top-level',
        replies: [comment({ author: me, body: 'my reply to bob' })],
      }),
    ];
    expect(latestCommentToMeAt(comments, me)).toBeNull();
  });

  it('returns the latest timestamp across multiple related comments', () => {
    const comments = [
      comment({ author: bob, body: 'first @alice', createdAt: T1 }),
      comment({ author: bob, body: 'later @alice', createdAt: T2 }),
    ];
    expect(latestCommentToMeAt(comments, me)).toBe(T2);
  });
});

describe('collectCommentsToMeAt', () => {
  it('collects every @mention / reply-to-me timestamp, excluding my own and unrelated', () => {
    const comments = [
      comment({ author: bob, body: 'ping @alice', createdAt: T1 }),
      comment({ author: bob, body: 'general chatter', createdAt: T2 }), // unrelated
      comment({ author: me, body: 'self @alice', createdAt: T2 }), // mine, excluded
      comment({
        author: me,
        body: 'my thread',
        createdAt: T1,
        replies: [comment({ author: bob, body: 'reply to me', createdAt: T2 })],
      }),
    ];
    expect(collectCommentsToMeAt(comments, me).sort()).toEqual([T1, T2]);
  });

  it('returns an empty array when nothing is related', () => {
    const comments = [comment({ author: bob, body: 'general chatter' })];
    expect(collectCommentsToMeAt(comments, me)).toEqual([]);
  });
});

function entry(over: Partial<PrIndexEntry> = {}): PrIndexEntry {
  return {
    identity: {} as PrIndexEntry['identity'],
    updatedAt: T1,
    discoveredAt: T1,
    lastSeenAt: T1,
    archivedAt: null,
    ...over,
  };
}

function pr(headSha: string): StoredPullRequest {
  return { sourceRef: { displayId: 'feat', sha: headSha } } as StoredPullRequest;
}

function read(over: Partial<PrReadStateFile>): PrReadStateFile {
  return { schema_version: 1, lastReadHeadSha: 'h0', lastReadAt: T1, ...over };
}

describe('computeUnread', () => {
  it('flags a PR that has never been opened (new arrival / cleared dir / fresh install)', () => {
    expect(computeUnread(entry(), null, pr('h1'))).toBe(true);
  });

  it('clears unread once opened, when nothing else changed', () => {
    const rs = read({ lastReadHeadSha: 'h1', lastReadAt: T2 });
    expect(computeUnread(entry(), rs, pr('h1'))).toBe(false);
  });

  it('flags a new commit pushed after the PR was opened', () => {
    const rs = read({ lastReadHeadSha: 'h1', lastReadAt: T2 });
    expect(computeUnread(entry(), rs, pr('h2'))).toBe(true);
  });

  it('flags a mention newer than the read watermark', () => {
    const rs = read({ lastReadHeadSha: 'h1', lastReadAt: T1 });
    expect(computeUnread(entry({ lastMentionAt: T2 }), rs, pr('h1'))).toBe(true);
  });

  it('does not flag a mention older than the read watermark', () => {
    const rs = read({ lastReadHeadSha: 'h1', lastReadAt: T2 });
    expect(computeUnread(entry({ lastMentionAt: T1 }), rs, pr('h1'))).toBe(false);
  });
});

describe('computeUnreadMentionCount', () => {
  const T0 = '2025-12-31T00:00:00.000Z';

  it('returns 0 when there are no mention timestamps', () => {
    expect(computeUnreadMentionCount(entry(), read({ lastReadAt: T1 }))).toBe(0);
  });

  it('counts every mention when the PR was never opened (no read-state)', () => {
    expect(computeUnreadMentionCount(entry({ mentionAts: [T1, T2] }), null)).toBe(2);
  });

  it('counts only mentions newer than the read watermark', () => {
    const rs = read({ lastReadAt: T1 });
    expect(computeUnreadMentionCount(entry({ mentionAts: [T0, T1, T2] }), rs)).toBe(1);
  });

  it('returns 0 once all mentions are at or below the watermark', () => {
    const rs = read({ lastReadAt: T2 });
    expect(computeUnreadMentionCount(entry({ mentionAts: [T0, T1, T2] }), rs)).toBe(0);
  });
});
