import type { PrComment } from '@meebox/shared';
import type { PlatformAdapter } from '@meebox/platform-core';

/**
 * Tags each comment (including the replies subtree) with canDelete / canEdit flags. No controller context needed.
 *
 * - canDelete: author.name === current PAT user && no reply && has version
 *   (Bitbucket refuses to delete ones with a reply; DELETE must carry a version optimistic lock)
 * - canEdit:   author.name === current PAT user && has version
 *   (Bitbucket allows editing comments with a reply; PUT also carries a version)
 *
 * If the current user is unavailable (ping not done / failed) → all false. The renderer reads the flag directly and no longer
 * compares author / version / replies itself, keeping the path shortest and most stable.
 */
export function annotateOwnership(comments: PrComment[], adapter: PlatformAdapter): PrComment[] {
  const me = adapter.connection.getCurrentUser();
  if (!me) {
    return setOwnershipRecursive(comments, () => ({ canDelete: false, canEdit: false }));
  }
  // "Comments with a reply cannot be deleted" is a Bitbucket limitation (deleting a parent comment would orphan child comments); GitHub / GitLab allow deleting
  // one's own comments (including those with a reply). Use the optimistic-lock capability bit as a proxy for Bitbucket.
  const noDeleteWithReplies = adapter.connection.capabilities().commentOptimisticLock;
  return setOwnershipRecursive(comments, (c) => {
    const isMine = c.author.name === me.name;
    const hasVersion = typeof c.version === 'number';
    return {
      canDelete: isMine && hasVersion && (!noDeleteWithReplies || c.replies.length === 0),
      canEdit: isMine && hasVersion,
    };
  });
}

function setOwnershipRecursive(
  comments: PrComment[],
  judge: (c: PrComment) => { canDelete: boolean; canEdit: boolean },
): PrComment[] {
  return comments.map((c) => {
    const flags = judge(c);
    return {
      ...c,
      canDelete: flags.canDelete,
      canEdit: flags.canEdit,
      replies: setOwnershipRecursive(c.replies, judge),
    };
  });
}
