import { describe, expect, it } from 'vitest';
import { isDiffBaseCacheReusable } from '../src/diff-base-cache.js';

describe('isDiffBaseCacheReusable', () => {
  it('目标分支已被 merge 到源分支时失效旧 base', async () => {
    const ancestors = new Set(['old-base..head', 'target..head', 'old-base..target']);

    const reusable = await isDiffBaseCacheReusable({
      cachedBaseSha: 'old-base',
      targetSha: 'target',
      headSha: 'head',
      isAncestor: async (ancestor, descendant) => ancestors.has(`${ancestor}..${descendant}`),
    });

    expect(reusable).toBe(false);
  });

  it('目标分支前移但尚未进入源分支时复用旧 base', async () => {
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
