import { describe, it, expect, vi } from 'vitest';
import type { ProxyConfig } from '@meebox/shared';
import {
  parseNextLink,
  buildUrl,
  extractApiMessage,
  collect,
  hostOf,
  stripTrailingSlash,
  fetchWithTimeout,
  resolveConnectionFetch,
  type PlatformConnectionConfig,
} from '../src/index.js';

describe('stripTrailingSlash', () => {
  it('removes trailing slashes', () => {
    expect(stripTrailingSlash('https://x/')).toBe('https://x');
    expect(stripTrailingSlash('https://x///')).toBe('https://x');
    expect(stripTrailingSlash('https://x')).toBe('https://x');
  });
});

describe('hostOf', () => {
  it('returns host', () => expect(hostOf('https://api.example.com/x')).toBe('api.example.com'));
  it('empty on unparsable', () => expect(hostOf('not a url')).toBe(''));
});

describe('buildUrl', () => {
  it('joins base + path', () => {
    expect(buildUrl('https://api.example.com', '/repos/x')).toBe('https://api.example.com/repos/x');
  });
  it('passes through absolute path', () => {
    expect(buildUrl('https://api.example.com', 'https://other/y')).toBe('https://other/y');
  });
  it('sets query params', () => {
    expect(buildUrl('https://api.example.com', '/s', { q: 'a b', n: '2' })).toBe(
      'https://api.example.com/s?q=a+b&n=2',
    );
  });
});

describe('parseNextLink', () => {
  it('extracts rel="next"', () => {
    expect(
      parseNextLink('<https://api/x?page=2>; rel="next", <https://api/x?page=9>; rel="last"'),
    ).toBe('https://api/x?page=2');
  });
  it('null when absent', () => {
    expect(parseNextLink('<https://api/x?page=9>; rel="last"')).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe('extractApiMessage', () => {
  it('reads {message}', () => expect(extractApiMessage('{"message":"boom"}')).toBe('boom'));
  it('reads {error}', () => expect(extractApiMessage('{"error":"nope"}')).toBe('nope'));
  it('serializes object message', () =>
    expect(extractApiMessage('{"message":{"a":1}}')).toBe('{"a":1}'));
  it('empty on non-json', () => expect(extractApiMessage('<html>boom</html>')).toBe(''));
});

describe('collect', () => {
  it('drains async iterable', async () => {
    async function* gen(): AsyncIterable<number> {
      yield 1;
      yield 2;
      yield 3;
    }
    expect(await collect(gen())).toEqual([1, 2, 3]);
  });
});

describe('fetchWithTimeout', () => {
  it('aborts after timeout', async () => {
    const slow: FetchLikeStub = (_url, init) =>
      new Promise((_res, rej) => {
        init?.signal?.addEventListener('abort', () => rej(new Error('aborted')));
      });
    await expect(fetchWithTimeout(slow, 'https://x', {}, 5)).rejects.toThrow('aborted');
  });
  it('passes response through', async () => {
    const ok: FetchLikeStub = async () => new Response('hi');
    const res = await fetchWithTimeout(ok, 'https://x', {}, 1000);
    expect(await res.text()).toBe('hi');
  });
});

describe('resolveConnectionFetch', () => {
  const proxy = { enabled: true } as unknown as ProxyConfig;
  const cfg = (over?: Partial<PlatformConnectionConfig>): PlatformConnectionConfig => ({
    baseUrl: 'https://api.example.com',
    token: 't',
    ...over,
  });

  it('prefers explicit fetch override', () => {
    const f: FetchLikeStub = async () => new Response();
    expect(resolveConnectionFetch(cfg({ fetch: f }))).toBe(f);
  });

  it('uses proxy factory keyed by baseUrl host', () => {
    const proxied: FetchLikeStub = async () => new Response();
    const factory = vi.fn().mockReturnValue(proxied);
    expect(resolveConnectionFetch(cfg({ proxy, proxyFetch: factory }))).toBe(proxied);
    expect(factory).toHaveBeenCalledWith(proxy, 'api.example.com');
  });

  it('falls back to global fetch when factory returns undefined (loopback / off)', () => {
    const factory = vi.fn().mockReturnValue(undefined);
    const resolved = resolveConnectionFetch(cfg({ proxy, proxyFetch: factory }));
    expect(typeof resolved).toBe('function');
  });

  it('ignores proxy when no factory injected (direct)', () => {
    const resolved = resolveConnectionFetch(cfg({ proxy }));
    expect(typeof resolved).toBe('function');
  });

  it('uses global fetch when no proxy / factory given', () => {
    expect(typeof resolveConnectionFetch(cfg())).toBe('function');
  });
});

type FetchLikeStub = (input: string, init?: RequestInit) => Promise<Response>;
