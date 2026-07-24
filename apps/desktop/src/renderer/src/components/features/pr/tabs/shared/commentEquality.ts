import type { PrComment } from '@meebox/shared';

/**
 * Structural equality comparison of the comment tree (by remoteId + body + version + edit/delete permissions + recursive replies). poll mostly returns
 * comments with unchanged content: on equality, callers skip setState and keep the old reference so React bails out, avoiding pointless re-render of the
 * whole comment tree (including inline Monaco) and — in the diff view — the teardown/rebuild of open inline editors driven by the comments-array churn.
 */
export function sameCommentList(a: readonly PrComment[], b: readonly PrComment[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.remoteId !== y.remoteId ||
      x.body !== y.body ||
      x.version !== y.version ||
      x.canEdit !== y.canEdit ||
      x.canDelete !== y.canDelete ||
      !sameReactions(x.reactions, y.reactions) ||
      !sameCommentList(x.replies, y.replies)
    ) {
      return false;
    }
  }
  return true;
}

/** Equality comparison of the reactions array (emoji + count + mine triple matching item by item): lets reaction changes after a toggle trigger a re-render. */
function sameReactions(a: PrComment['reactions'], b: PrComment['reactions']): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    if (x[i]!.emoji !== y[i]!.emoji || x[i]!.count !== y[i]!.count || x[i]!.mine !== y[i]!.mine) {
      return false;
    }
  }
  return true;
}
