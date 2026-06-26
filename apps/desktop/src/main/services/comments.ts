import type { PrComment } from '@meebox/shared';
import type { PlatformAdapter } from '@meebox/platform-core';

/**
 * 给每条评论 (含 replies 子树) 打 canDelete / canEdit 标志。不依赖 controller 上下文。
 *
 * - canDelete: author.name === 当前 PAT 用户 && 无 reply && 有 version
 *   (Bitbucket 拒删带 reply 的；DELETE 必带 version 乐观锁)
 * - canEdit:   author.name === 当前 PAT 用户 && 有 version
 *   (Bitbucket 允许编辑带 reply 的评论；PUT 也带 version)
 *
 * 当前用户拿不到 (ping 未完成 / 失败) → 全部 false。renderer 直读 flag 不再
 * 自己比对 author / version / replies，链路最短最稳。
 */
export function annotateOwnership(comments: PrComment[], adapter: PlatformAdapter): PrComment[] {
  const me = adapter.connection.getCurrentUser();
  if (!me) {
    return setOwnershipRecursive(comments, () => ({ canDelete: false, canEdit: false }));
  }
  // 「带 reply 的评论不可删」是 Bitbucket 限制（删父评论会孤立子评论）；GitHub / GitLab 允许删
  // 自己的评论（含有 reply 的）。用乐观锁能力位作 Bitbucket 代理。
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
