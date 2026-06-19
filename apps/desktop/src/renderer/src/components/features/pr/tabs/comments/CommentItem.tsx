import { lazy, Suspense, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { PrComment, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../../api';
import i18n from '../../../../../i18n';
import { REMOTE_REHYPE_PLUGINS } from '../../../../../lib/markdown';
import { Avatar } from '../../../../common/Avatar';
import { makeBitbucketImageFor, transformBitbucketUrl } from '../../../../common/BitbucketImage';
import { ChatIcon } from '../../../../common/icons';
import { CommentEditEditor } from './CommentEditEditor';
import { CommentReplyEditor } from './CommentReplyEditor';
import { ConfirmModal } from '../../../../common/ConfirmModal';
import { mermaidComponents } from '../../../../common/markdownMermaid';
// 行内代码上下文用 Monaco，懒加载随 DiffView 同一套 Monaco chunk 按需拉取，不进入口包。
const InlineCodeContext = lazy(() =>
  import('./InlineCodeContext').then((m) => ({ default: m.InlineCodeContext })),
);

/**
 * 评论树结构相等比较（按 remoteId + 正文 + version + 编辑/删除权限 + 递归 replies）。poll 多数返回
 * 内容不变的评论：相等就跳过 setState、保留旧引用，让 React bail-out，避免整棵评论树（含内联
 * Monaco）无谓重渲染（刷新抖动）。
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
      !sameCommentList(x.replies, y.replies)
    ) {
      return false;
    }
  }
  return true;
}

/**
 * 嵌套回复的最大缩进层级：满此层级后继续递归但**不再加缩进**（拉平展示），避免深嵌套把内容挤到
 * 右侧极窄。depth 0 为顶层评论；depth 1..MAX 逐级缩进，超过 MAX 的更深回复一律平铺在 MAX 层缩进上，
 * 仍按作者归属可读。Bitbucket 实际只一层 reply，GitHub / GitLab 可深嵌套，故设上限。
 */
const MAX_REPLY_DEPTH = 5;

/**
 * 单条评论 + 嵌套 replies。inline 评论顶部显示 `path:line side` chip 区分锚点位置；
 * summary 评论不挂 chip。replies 走递归，depth 控制左侧缩进；满 MAX_REPLY_DEPTH 层后拉平
 * （不再加缩进，见该常量）。
 *
 * `timeline` 模式（活动时间线，GitHub/Bitbucket）下的**顶层评论**改走时间线行版式：与其它事件统一
 * 「评论图标 + 头像 + 加粗作者名 + 『评论』动词 + 时间」标题，正文整体缩进成挂在时间线轨上的卡片。
 * 非 timeline（GitLab 纯评论视图）或回复（depth>0）维持原卡片版式。
 */
export function CommentItem({
  comment,
  pr,
  depth,
  autoExpandCode = false,
  hardBreaks,
  timeline = false,
}: {
  comment: PrComment;
  pr: StoredPullRequest;
  depth: number;
  /** 顶层 (depth=0) 由父组件按 CAP 决定 true/false；replies 总是 false (不渲染 code) */
  autoExpandCode?: boolean;
  hardBreaks: boolean;
  /** 是否处于活动时间线模式（仅影响顶层评论版式，见上方说明） */
  timeline?: boolean;
}) {
  const { t } = useTranslation();
  // 评论 body 内嵌图片走 IPC 代理 (Bitbucket 私有资源需 PAT 鉴权)
  const mdComponents = useMemo(
    () => ({ ...mermaidComponents, img: makeBitbucketImageFor(pr.localId, pr.url) }),
    [pr.localId, pr.url],
  );
  const [replyOpen, setReplyOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // 删除/编辑条件 main 端预判好了 (annotateOwnership)。renderer 直读 flag，
  // 不再自己比对 author / version / replies
  const canDelete = comment.canDelete === true;
  const canEdit = comment.canEdit === true;

  const handleDelete = async (): Promise<void> => {
    if (!canDelete || comment.version === undefined) return;
    setConfirmDelete(false);
    setDeleting(true);
    setDeleteError(null);
    try {
      await invoke('comments:delete', {
        localId: pr.localId,
        commentId: comment.remoteId,
        version: comment.version,
      });
      // 成功 → main 端清 cache + 广播 comments:changed → 本面板 useEffect 重拉，
      // 这条评论自然从列表里消失，不用手动维护本地 state
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  };

  // inline 评论锚点 chip：path:line + 侧别 (old=base / new=head)，让用户在评论里定位到代码位置
  const anchorChip = comment.anchor ? (
    <span
      className={`pr-comment-anchor pr-comment-anchor-${comment.anchor.side}`}
      title={t('commentsPanel.anchorTitle', {
        side: comment.anchor.side === 'old' ? 'base' : 'head',
        lineType: comment.anchor.lineType,
      })}
    >
      <code>{comment.anchor.path}</code>:{comment.anchor.line}
    </span>
  ) : null;

  // inline 评论：在正文上方嵌一段代码上下文 (Monaco read-only)。replies (depth > 0) 不重复展示。
  const inlineCode =
    comment.anchor && depth === 0 ? (
      <Suspense
        fallback={<div className="pane-loading muted">{t('commentsPanel.loadingCodeContext')}</div>}
      >
        <InlineCodeContext pr={pr} anchor={comment.anchor} autoExpand={autoExpandCode} />
      </Suspense>
    ) : null;

  // 编辑态：textarea 占位替换 markdown 正文；非编辑态：渲染 markdown
  const bodyOrEdit =
    editOpen && typeof comment.version === 'number' ? (
      <CommentEditEditor
        prLocalId={pr.localId}
        commentId={comment.remoteId}
        version={comment.version}
        initialBody={comment.body}
        onCancel={() => setEditOpen(false)}
        onSaved={() => setEditOpen(false)}
      />
    ) : (
      <div className="pr-comment-body markdown">
        {/* hardBreaks（Bitbucket/GitHub）挂 remarkBreaks 单 \n→<br>；GitLab CommonMark 不挂 */}
        <ReactMarkdown
          remarkPlugins={hardBreaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
          rehypePlugins={REMOTE_REHYPE_PLUGINS}
          components={mdComponents}
          urlTransform={transformBitbucketUrl}
        >
          {comment.body}
        </ReactMarkdown>
      </div>
    );

  // 操作行：编辑态隐藏所有按钮（避免跟编辑器底部按钮组重复）
  const foot = !editOpen ? (
    <div className="pr-comment-foot">
      {!replyOpen && (
        <button type="button" className="pr-comment-reply-btn" onClick={() => setReplyOpen(true)}>
          {t('commentsPanel.reply')}
        </button>
      )}
      {canEdit && !replyOpen && (
        <button
          type="button"
          className="pr-comment-edit-btn"
          onClick={() => setEditOpen(true)}
          title={t('commentsPanel.editTitle')}
        >
          {t('common.edit')}
        </button>
      )}
      {/* 删除按钮在最后，跟其它按钮风格对齐 — disable 期间文案变"删除中…" */}
      {canDelete && !replyOpen && (
        <button
          type="button"
          className="pr-comment-delete-btn"
          onClick={() => setConfirmDelete(true)}
          disabled={deleting}
          title={t('commentsPanel.deleteTitle')}
        >
          {deleting ? t('commentsPanel.deleting') : t('common.delete')}
        </button>
      )}
    </div>
  ) : null;

  const deleteErrorEl = deleteError ? (
    <div className="pr-comment-delete-error" role="alert">
      {t('commentsPanel.deleteFailed', { msg: deleteError })}
      <button
        type="button"
        className="pr-comment-delete-error-dismiss"
        onClick={() => setDeleteError(null)}
        aria-label={t('commentsPanel.dismissErrorAria')}
        title={t('commentsPanel.dismissErrorTitle')}
      >
        ✕
      </button>
    </div>
  ) : null;

  const replyEditor = replyOpen ? (
    <CommentReplyEditor
      prLocalId={pr.localId}
      // 回复目标抽象（threadId）：GitLab=discussion id（reply 必需）；Bitbucket 空 / GitHub=remoteId → 回退 remoteId。
      parentCommentId={comment.threadId ?? comment.remoteId}
      onCancel={() => setReplyOpen(false)}
      onPosted={() => setReplyOpen(false)}
    />
  ) : null;

  const repliesEl =
    comment.replies.length > 0 ? (
      // 满 MAX_REPLY_DEPTH 层后用 pr-comments-flat 取代 pr-comments-replies（不再缩进 / 左边框）→
      // 更深回复拉平在该层缩进上；pr-comments-flat 据此给同层级相邻评论加横向分割线区分。
      <ul
        className={`pr-comments-list ${depth < MAX_REPLY_DEPTH ? 'pr-comments-replies' : 'pr-comments-flat'}`}
      >
        {comment.replies.map((r) => (
          <CommentItem
            key={r.remoteId}
            comment={r}
            pr={pr}
            depth={depth + 1}
            hardBreaks={hardBreaks}
          />
        ))}
      </ul>
    ) : null;

  const confirmModalEl = confirmDelete ? (
    <ConfirmModal
      title={t('commentsPanel.deleteConfirmTitle')}
      message={t('commentsPanel.deleteConfirmMessage')}
      confirmLabel={t('common.delete')}
      cancelLabel={t('common.cancel')}
      danger
      onConfirm={() => void handleDelete()}
      onCancel={() => setConfirmDelete(false)}
    />
  ) : null;

  // 时间线模式的顶层评论：与其它事件统一的标题行（图标 + 头像 + 作者 + 『评论』+ 时间），正文挂成缩进卡片。
  if (timeline && depth === 0) {
    return (
      <li className="pr-comment pr-comment-timeline pr-comment-depth-0">
        <div className="pr-activity-item pr-activity-comment-head">
          <span className="pr-activity-icon pr-activity-icon-comment" aria-hidden="true">
            <ChatIcon size={18} />
          </span>
          <Avatar
            connectionId={pr.connectionId}
            slug={comment.author.slug ?? comment.author.name}
            displayName={comment.author.displayName}
            avatarUrl={comment.author.avatarUrl}
            size={22}
          />
          <div className="pr-activity-main">
            <span className="pr-activity-actor">{comment.author.displayName}</span>
            <span className="pr-activity-verb">{t('activityPanel.verb.commented')}</span>
            {anchorChip}
          </div>
          <time className="pr-activity-time muted" dateTime={comment.createdAt}>
            {formatRelativeTime(comment.createdAt)}
          </time>
        </div>
        <div className="pr-comment-card">
          {inlineCode}
          {bodyOrEdit}
          {foot}
          {deleteErrorEl}
          {replyEditor}
          {repliesEl}
        </div>
        {confirmModalEl}
      </li>
    );
  }

  return (
    <li className={`pr-comment pr-comment-depth-${String(Math.min(depth, MAX_REPLY_DEPTH))}`}>
      <div className="pr-comment-head">
        <Avatar
          connectionId={pr.connectionId}
          slug={comment.author.slug ?? comment.author.name}
          displayName={comment.author.displayName}
          avatarUrl={comment.author.avatarUrl}
          size={22}
        />
        <span className="pr-comment-author">{comment.author.displayName}</span>
        {anchorChip}
        <time className="pr-comment-time muted" dateTime={comment.createdAt}>
          {formatRelativeTime(comment.createdAt)}
        </time>
      </div>
      {inlineCode}
      {bodyOrEdit}
      {foot}
      {deleteErrorEl}
      {replyEditor}
      {repliesEl}
      {confirmModalEl}
    </li>
  );
}

/**
 * 相对时间文案（刚刚 / N 分钟前 / …），一周以上回退本地日期。供评论与活动事件共用。
 */
export function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return i18n.t('commentsPanel.justNow');
  if (diffSec < 3600)
    return i18n.t('commentsPanel.minutesAgo', { count: Math.round(diffSec / 60) });
  if (diffSec < 86400)
    return i18n.t('commentsPanel.hoursAgo', { count: Math.round(diffSec / 3600) });
  if (diffSec < 86400 * 7)
    return i18n.t('commentsPanel.daysAgo', { count: Math.round(diffSec / 86400) });
  return new Date(t).toLocaleDateString();
}
