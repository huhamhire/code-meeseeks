import { describe, expect, it } from 'vitest';
import { isDiffBaseCacheReusable } from '../src/diff-base-cache.js';

describe('isDiffBaseCacheReusable', () => {
  it('invalidates stale base when target branch has been merged into source branch', async () => {
    const ancestors = new Set(['old-base..head', 'target..head', 'old-base..target']);

    const reusable = await isDiffBaseCacheReusable({
      cachedBaseSha: 'old-base',
      targetSha: 'target',
      headSha: 'head',
      isAncestor: async (ancestor, descendant) => ancestors.has(`${ancestor}..${descendant}`),
    });

    expect(reusable).toBe(false);
  });

  it('reuses stale base when target branch advances but has not yet landed in source branch', async () => {
    const ancestors = new Set(['old-base..head', 'old-base..target']);

    const reusable = await isDiffBaseCacheReusable({
      cachedBaseSha: 'old-base',
      targetSha: 'target',
      headSha: 'head',
      isAncestor: async (ancestor, descendant) => ancestors.has(`${ancestor}..${descendant}`),
    });

    expect(reusable).toBe(true);
  });
});
