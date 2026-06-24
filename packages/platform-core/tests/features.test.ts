import { describe, it, expect } from 'vitest';
import type { PlatformUser } from '@meebox/shared';
import {
  BaseConnection,
  MutableConnectionContext,
  composePlatformAdapter,
  type CommentService,
  type ConnectionContext,
  type MediaService,
  type PullRequestService,
} from '../src/index.js';

const fakeTransport = {} as ConnectionContext['transport'];

class FakeConnection extends BaseConnection {
  readonly kind = 'github' as const;
  capabilities() {
    return {} as ReturnType<BaseConnection['capabilities']>;
  }
  async ping() {
    return { ok: true };
  }
  async getCloneUrl() {
    return 'https://example/repo.git';
  }
}

describe('MutableConnectionContext + BaseConnection', () => {
  it('shares the user cache through ctx (set on connection, read back)', () => {
    const ctx = new MutableConnectionContext(fakeTransport);
    const conn = new FakeConnection(ctx);
    expect(conn.getCurrentUser()).toBeNull();
    const user: PlatformUser = { name: 'me', displayName: 'Me' };
    conn.setCurrentUser(user);
    expect(conn.getCurrentUser()).toBe(user);
    // 写到 connection 即写进共享 ctx —— 其它领域服务读同一份。
    expect(ctx.getCurrentUser()).toBe(user);
  });

  it('exposes transport to subclasses via ctx', () => {
    const ctx = new MutableConnectionContext(fakeTransport);
    expect(ctx.transport).toBe(fakeTransport);
  });
});

describe('composePlatformAdapter', () => {
  it('wires the four domain services and derives kind from connection', () => {
    const ctx = new MutableConnectionContext(fakeTransport);
    const connection = new FakeConnection(ctx);
    const prs = {} as PullRequestService;
    const comments = {} as CommentService;
    const media = {} as MediaService;
    const adapter = composePlatformAdapter({ connection, prs, comments, media });
    expect(adapter.kind).toBe('github');
    expect(adapter.connection).toBe(connection);
    expect(adapter.prs).toBe(prs);
    expect(adapter.comments).toBe(comments);
    expect(adapter.media).toBe(media);
  });
});
