import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type ReactMarkdown from 'react-markdown';
import type { PrComment } from '@meebox/shared';
import { Avatar } from '../../../../../common/Avatar';
import { makeBitbucketImageFor } from '../../../../../common/BitbucketImage';
import { ConfirmModal } from '../../../../../common/ConfirmModal';
import { CommentEditEditor } from '../../comments/CommentEditEditor';
import { CommentReplyEditor } from '../../comments/CommentReplyEditor';
import { CommentMarkdown } from '../../shared/CommentMarkdown';
import { useCommentThread } from '../../shared/useCommentThread';

/**
 * 估算 view zone 高度（行数）。每段评论 = header(avatar+name+date, 1.3 行) + body
 * 字数 / 80 行向上取整。回复递归计算，每条 reply 多 0.3 行 (margin/border)。
 * 同行多评论叠加，最后顶天 32 行避免独吞屏幕。
 */
export function estimateZoneHeight(comments: PrComment[]): number {
  let h = 1; // 上下 padding
  for (const c of comments) h += commentHeight(c) + 0.3; // item 间分隔
  return Math.min(Math.ceil(h), 32);
}

function commentHeight(c: PrComment): number {
  let h = 1.3 + Math.max(1, Math.ceil(c.body.length / 80));
  for (const r of c.replies) h += commentHeight(r) + 0.3;
  return h;
}

export function CommentZone({
  comments,
  connectionId,
  attachmentBase,
  prLocalId,
  prWebUrl,
  hardBreaks,
}: {
  comments: PrComment[];
  connectionId: string;
  attachmentBase: string | null;
  prLocalId: string;
  prWebUrl: string;
  hardBreaks: boolean;
}) {
  return (
    <div className="comment-zone-inner">
      {comments.map((c, i) => (
        <div
          key={c.remoteId}
          className={`comment-zone-item${i > 0 ? ' comment-zone-item-divider' : ''}`}
        >
          <CommentNode
            comment={c}
            connectionId={connectionId}
            depth={0}
            attachmentBase={attachmentBase}
            prLocalId={prLocalId}
            prWebUrl={prWebUrl}
            hardBreaks={hardBreaks}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * 把 Bitbucket 评论 markdown 里 `attachment:HASH` 形态的 URL 改写为可点击的 Bitbucket 链接。
 * 返回 null = 不是附件 URL，调用方按原样处理。
 */
function resolveAttachmentUrl(href: string, base: string | null): string | null {
  if (!base || !href.startsWith('attachment:')) return null;
  const hash = href.slice('attachment:'.length).trim();
  if (!hash) return null;
  return `${base}/${encodeURIComponent(hash)}`;
}

/**
 * react-markdown components 覆盖：a/img 检测 attachment: 协议，改写到 Bitbucket URL。
 * 图片附件因为 Bitbucket 需要会话鉴权，渲染器 fetch 不到，统一退化为可点击链接
 * （📎 alt 文本），点击走 setWindowOpenHandler → shell.openExternal 在系统
 * 浏览器打开，用户的 Bitbucket 登录 session 能正常加载。
 */
function makeCommentMarkdownComponents(
  attachmentBase: string | null,
  prLocalId: string,
  prWebUrl: string,
): Parameters<typeof ReactMarkdown>[0]['components'] {
  const BitbucketImage = makeBitbucketImageFor(prLocalId, prWebUrl);
  return {
    a: ({ href, children, ...rest }) => {
      const resolved = href ? resolveAttachmentUrl(href, attachmentBase) : null;
      const finalHref = resolved ?? href;
      return (
        <a {...rest} href={finalHref} target="_blank" rel="noreferrer">
          {resolved ? '📎 ' : null}
          {children}
        </a>
      );
    },
    img: ({ src, alt }) => {
      if (typeof src !== 'string' || !src) return null;
      // 把 src 原样传 IPC — main 端 adapter 懂 Bitbucket `attachment:HASH` 协议 + 绝对/
      // 相对 URL，renderer 不需要前置 resolve。外部公网 URL 在 main 端会被认为
      // 跨 host 返回 null，BitbucketImage 内部 fallback 到原生 <img>
      return <BitbucketImage src={src} alt={alt} />;
    },
  };
}

/**
 * 递归渲染单条评论 + 它的回复子树。comment.replies 是任意层级的；这里递归到底。每往下一层
 * 步进缩进 + 一道左竖线（缩进量 / 边框色与评论 tab 的 .pr-comments-replies 对齐，见 comment-zone.scss）。
 */
/** 嵌套缩进最大 5 层；超过此层级的更深回复**拉平**（comment-zone-reply-flat：去步进 / 边框 / 左 padding），
 *  平铺在第 5 层缩进上、上下排列，避免无限嵌套一直右滑。 */
const MAX_REPLY_INDENT_DEPTH = 5;

function CommentNode({
  comment,
  connectionId,
  depth,
  attachmentBase,
  prLocalId,
  prWebUrl,
  hardBreaks,
}: {
  comment: PrComment;
  connectionId: string;
  depth: number;
  attachmentBase: string | null;
  prLocalId: string;
  prWebUrl: string;
  hardBreaks: boolean;
}) {
  const { t } = useTranslation();
  const components = useMemo(
    () => makeCommentMarkdownComponents(attachmentBase, prLocalId, prWebUrl),
    [attachmentBase, prLocalId, prWebUrl],
  );
  // 回复 / 编辑 / 删除 交互状态机（与评论/活动 tab 的 CommentItem 共用，见 shared/useCommentThread）
  const {
    replyOpen,
    setReplyOpen,
    editOpen,
    setEditOpen,
    confirmDelete,
    setConfirmDelete,
    deleting,
    deleteError,
    setDeleteError,
    canEdit,
    canDelete,
    handleDelete,
  } = useCommentThread(prLocalId, comment);

  // body 只包 author + 正文 + 回复按钮 / 编辑器；replies 作为 sibling 放外面 —
  // 不让 hover 内层 replies 冒泡触发外层 :hover 导致所有祖先 reply 按钮一齐显示
  const inner = (
    <>
      <div className="comment-zone-item-body">
        <CommentAuthorRow
          displayName={comment.author.displayName}
          slug={comment.author.slug ?? comment.author.name}
          avatarUrl={comment.author.avatarUrl}
          connectionId={connectionId}
          at={comment.createdAt}
        />
        {editOpen && typeof comment.version === 'number' ? (
          <CommentEditEditor
            prLocalId={prLocalId}
            commentId={comment.remoteId}
            version={comment.version}
            initialBody={comment.body}
            onCancel={() => setEditOpen(false)}
            onSaved={() => setEditOpen(false)}
          />
        ) : (
          <CommentMarkdown
            body={comment.body}
            hardBreaks={hardBreaks}
            components={components}
            className="comment-zone-body markdown"
          />
        )}
        {/* 回复 / 编辑 / 删除按钮：默认 hidden，hover comment-zone-item-body 显示 (CSS)。
            编辑态隐藏全部按钮 (避免跟编辑器底部按钮组重复) */}
        {!replyOpen && !editOpen && (
          <div className="comment-zone-foot">
            <button
              type="button"
              className="comment-zone-reply-btn"
              onClick={() => setReplyOpen(true)}
            >
              {t('commentsPanel.reply')}
            </button>
            {canEdit && (
              <button
                type="button"
                className="comment-zone-edit-btn"
                onClick={() => setEditOpen(true)}
                title={t('commentsPanel.editTitle')}
              >
                {t('common.edit')}
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                className="comment-zone-delete-btn"
                onClick={() => setConfirmDelete(true)}
                disabled={deleting}
                title={t('commentsPanel.deleteTitle')}
              >
                {deleting ? t('commentsPanel.deleting') : t('common.delete')}
              </button>
            )}
          </div>
        )}
        {replyOpen && (
          <CommentReplyEditor
            prLocalId={prLocalId}
            // 回复目标抽象（threadId）：GitLab=discussion id（reply 必需）；Bitbucket 空 / GitHub=remoteId → 回退 remoteId。
            parentCommentId={comment.threadId ?? comment.remoteId}
            onCancel={() => setReplyOpen(false)}
            onPosted={() => setReplyOpen(false)}
          />
        )}
        {deleteError && (
          <div className="comment-zone-delete-error" role="alert">
            {t('commentsPanel.deleteFailed', { msg: deleteError })}
            <button
              type="button"
              className="comment-zone-delete-error-dismiss"
              onClick={() => setDeleteError(null)}
              aria-label={t('commentsPanel.dismissErrorAria')}
              title={t('commentsPanel.dismissErrorTitle')}
            >
              ✕
            </button>
          </div>
        )}
      </div>
      {comment.replies.map((r) => (
        <CommentNode
          key={r.remoteId}
          comment={r}
          connectionId={connectionId}
          depth={depth + 1}
          attachmentBase={attachmentBase}
          prLocalId={prLocalId}
          prWebUrl={prWebUrl}
          hardBreaks={hardBreaks}
        />
      ))}
      {confirmDelete && (
        <ConfirmModal
          title={t('commentsPanel.deleteConfirmTitle')}
          message={t('commentsPanel.deleteConfirmMessage')}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => void handleDelete()}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  );
  if (depth === 0) return inner;
  // 满 MAX_REPLY_INDENT_DEPTH 层后**拉平**：去掉步进缩进与左竖线，更深回复平铺在上限层级上
  // （与评论 tab 设计一致）。关键：必须同时去掉 padding-left 与 border —— 仅去步进、保留每层的
  // padding/border 会逐级累加仍右移（之前"还是有缩进"的根因）。
  const flat = depth > MAX_REPLY_INDENT_DEPTH;
  return (
    <div className={`comment-zone-reply${flat ? ' comment-zone-reply-flat' : ''}`}>{inner}</div>
  );
}

function CommentAuthorRow({
  displayName,
  slug,
  avatarUrl,
  connectionId,
  at,
}: {
  displayName: string;
  slug: string;
  avatarUrl?: string;
  connectionId: string;
  at: string;
}) {
  return (
    <div className="comment-zone-head">
      <Avatar
        connectionId={connectionId}
        slug={slug}
        displayName={displayName}
        avatarUrl={avatarUrl}
        size={18}
      />
      <strong>{displayName}</strong>
      <span className="muted">{new Date(at).toLocaleString()}</span>
    </div>
  );
}

/** 把多条同行评论合成 markdown hover 文本（含回复嵌套） */
export function renderHoverMd(comments: PrComment[]): string {
  return comments
    .map((c) => {
      const head = `**${c.author.displayName}** · ${new Date(c.createdAt).toLocaleString()}`;
      const body = c.body.length > 600 ? c.body.slice(0, 600) + '…' : c.body;
      const replies = c.replies
        .map(
          (r) =>
            `> **${r.author.displayName}**: ${r.body.length > 200 ? r.body.slice(0, 200) + '…' : r.body}`,
        )
        .join('\n');
      return `${head}\n\n${body}${replies ? '\n\n' + replies : ''}`;
    })
    .join('\n\n---\n\n');
}
