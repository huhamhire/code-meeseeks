import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { PlatformCapabilities, PrComment, StoredPullRequest } from '@meebox/shared';
import { invoke, subscribe } from '../../../../../api';
import i18n from '../../../../../i18n';
import { formatBackendError, type FormattedError } from '../../../../../errors';
import { REMOTE_REHYPE_PLUGINS } from '../../../../../lib/markdown';
import { Avatar } from '../../../../common/Avatar';
import { PaneLoading } from '../../../../common/Loading';
import { makeBitbucketImageFor, transformBitbucketUrl } from '../../../../common/BitbucketImage';
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
 * 内容不变的评论：相等就跳过 setComments、保留旧引用，让 React bail-out，避免整棵评论树（含内联
 * Monaco）无谓重渲染（刷新抖动）。
 */
function sameCommentList(a: readonly PrComment[], b: readonly PrComment[]): boolean {
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

interface CommentsPanelProps {
  pr: StoredPullRequest;
  /** 拉取成功后回调，把顶层评论数 (不含 replies) 报给父组件用于 tab 角标 */
  onCommentsLoaded?: (count: number) => void;
  /** 活动连接能力位；此处用 commentHardBreaks 决定评论是否启用 remark-breaks。 */
  capabilities?: PlatformCapabilities;
}

/**
 * PR 全量评论视图（独立标签页，跟 Diff inline 评论互补）。
 *
 * 数据来源 跟 DiffView 的 inline 评论同一份 (`diff:listComments`)，main 层有
 * `pr_updated_at` 缓存；进入本面板时优先回缓存，远端变更后失效自动重拉。
 *
 * 排版：summary 评论 (anchor=null) 跟 inline 评论 (anchor!=null) 都展示，inline
 * 顶部标 `path:line` chip 让用户知道这条评论锚在哪。replies 嵌套缩进 1 层渲染。
 */
export function CommentsPanel({ pr, onCommentsLoaded, capabilities }: CommentsPanelProps) {
  // 评论换行：GitHub/Bitbucket hard-break；GitLab CommonMark 软换行。缺省回退 true。
  const hardBreaks = capabilities?.commentHardBreaks ?? true;
  const { t } = useTranslation();
  // 已展示的视图：评论与其配对的 pr 一起冻结。切 PR 时**不立刻清空**——旧视图继续渲染、上盖 loading
  // 遮罩，新数据 ready 后整体替换（stale-while-loading），消除「先闪『加载中』再渲新」的空窗。
  // pr 与评论必须配对：旧评论要用旧 PR 的上下文（图片代理 / 回复目标）渲染，且该 ref 跨 poll 稳定，
  // 给评论树（含内联 Monaco）稳定引用避免重渲染。
  const [view, setView] = useState<{ pr: StoredPullRequest; comments: PrComment[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FormattedError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    // 不清 view：切 PR 期间旧评论继续显示、由遮罩盖住，避免空窗闪烁。
    const fetchList = async (force: boolean): Promise<void> => {
      try {
        const list = await invoke('diff:listComments', { localId: pr.localId, force });
        if (cancelled) return;
        // 同 PR 且内容相等：保留旧 view 引用让 React bail（comments:changed 无实质变化时不重渲评论树）。
        setView((prev) =>
          prev && prev.pr.localId === pr.localId && sameCommentList(prev.comments, list)
            ? prev
            : { pr, comments: list },
        );
        setLoading(false);
        onCommentsLoaded?.(list.length);
      } catch (e) {
        if (!cancelled) {
          setError(formatBackendError(e));
          setLoading(false);
        }
      }
    };
    void fetchList(true);
    // 监听 main 端 comments:changed 事件 — 用户回复评论 / 其他 PR 操作触发评论
    // 树变化时重拉远端最新 (force=true 跳过 cache 比对)
    const unsub = subscribe('comments:changed', (e) => {
      if (e.localId === pr.localId) void fetchList(true);
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // onCommentsLoaded 故意不放依赖：父组件每次 render 都会重传新 ref，会触发误重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.localId]);

  const viewPr = view?.pr;
  // 按 createdAt **倒序** (newest first)：评论页主要给用户快速看最新动态用，
  // 不是逐条对话回溯，最新在顶部更合理
  const ordered = useMemo(
    () => (view?.comments ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [view],
  );
  // inline 评论自动挂 Monaco 上限：前 N 条 (按倒序后的顺序，最新 N 个 inline) 直接
  // 挂；超额走 click-to-expand 懒加载。CAP 取 10 跟用户感知节奏一致 —— 一屏内大
  // 概看完，再多就需要主动展开
  const AUTO_EXPAND_CAP = 10;
  const autoExpandSet = useMemo(() => {
    const out = new Set<string>();
    let i = 0;
    for (const c of ordered) {
      if (c.anchor) {
        if (i < AUTO_EXPAND_CAP) out.add(c.remoteId);
        i++;
      }
    }
    return out;
  }, [ordered]);

  // 缓存顶层评论元素列表：deps 全是稳定引用（ordered 经 sameCommentList 跳过后不变、viewPr 与评论配对
  // 冻结、autoExpandSet 随 ordered）。poll 无评论变化时元素引用不变 → React 跳过整棵评论子树（含内联
  // Monaco），消除刷新抖动。
  const commentEls = useMemo(
    () =>
      viewPr
        ? ordered.map((c) => (
            <CommentItem
              key={c.remoteId}
              comment={c}
              pr={viewPr}
              depth={0}
              autoExpandCode={autoExpandSet.has(c.remoteId)}
              hardBreaks={hardBreaks}
            />
          ))
        : [],
    [ordered, viewPr, autoExpandSet, hardBreaks],
  );

  // 首载失败 / 切 PR 失败（无可信展示内容，或现有 view 属于旧 PR）：整块错误，不拿旧 PR 的评论冒充新的。
  if (error && (!view || view.pr.localId !== pr.localId)) {
    return (
      <div className="pr-comments-panel">
        <div className="pr-comments-scroll">
          <div className="pr-comments-error" role="alert">
            <strong>{t('commentsPanel.loadError', { title: error.title })}</strong>
            <pre>{error.detail}</pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-comments-panel">
      <div className="pr-comments-scroll">
        {view && ordered.length > 0 && <ul className="pr-comments-list">{commentEls}</ul>}
        {view && ordered.length === 0 && !loading && (
          <p className="muted">{t('commentsPanel.empty')}</p>
        )}
      </div>
      {/* 加载遮罩盖住旧内容（或首载空面板），ready 后整体替换。PaneLoading 默认 delayMs=150：
          命中本地缓存的快切换遮罩根本不出现、旧内容直接换新（零闪）；只有慢加载才显 spinner。 */}
      {loading && <PaneLoading overlay label={t('commentsPanel.loading')} />}
    </div>
  );
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
 */
function CommentItem({
  comment,
  pr,
  depth,
  autoExpandCode = false,
  hardBreaks,
}: {
  comment: PrComment;
  pr: StoredPullRequest;
  depth: number;
  /** 顶层 (depth=0) 由父组件按 CAP 决定 true/false；replies 总是 false (不渲染 code) */
  autoExpandCode?: boolean;
  hardBreaks: boolean;
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
        {comment.anchor && (
          // inline 评论锚点 chip：path:line + 侧别 (old=base / new=head)。
          // 让用户在评论面板里也能定位到代码位置 (后续可点击跳 Diff 视图)
          <span
            className={`pr-comment-anchor pr-comment-anchor-${comment.anchor.side}`}
            title={t('commentsPanel.anchorTitle', {
              side: comment.anchor.side === 'old' ? 'base' : 'head',
              lineType: comment.anchor.lineType,
            })}
          >
            <code>{comment.anchor.path}</code>:{comment.anchor.line}
          </span>
        )}
        <time className="pr-comment-time muted" dateTime={comment.createdAt}>
          {formatRelativeTime(comment.createdAt)}
        </time>
      </div>
      {/* inline 评论：在正文上方嵌一段代码上下文 (Monaco read-only)，锚定行高亮。
          replies (depth > 0) 不重复展示，避免冗余 —— 父评论已经给了上下文。
          autoExpandCode 由父组件按"最新 N 条"决定，超额条目用户点开才挂 editor */}
      {comment.anchor && depth === 0 && (
        <Suspense
          fallback={
            <div className="pane-loading muted">{t('commentsPanel.loadingCodeContext')}</div>
          }
        >
          <InlineCodeContext pr={pr} anchor={comment.anchor} autoExpand={autoExpandCode} />
        </Suspense>
      )}
      {/* 编辑态：textarea 占位替换 markdown 正文；非编辑态：渲染 markdown */}
      {editOpen && typeof comment.version === 'number' ? (
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
      )}
      {/* 操作行：编辑态隐藏所有按钮 (避免跟编辑器底部按钮组重复)；非编辑态展示
          回复 / 编辑 / 删除三个按钮 */}
      {!editOpen && (
        <div className="pr-comment-foot">
          {!replyOpen && (
            <button
              type="button"
              className="pr-comment-reply-btn"
              onClick={() => setReplyOpen(true)}
            >
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
      )}
      {deleteError && (
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
      )}
      {replyOpen && (
        <CommentReplyEditor
          prLocalId={pr.localId}
          // 回复目标抽象（threadId）：GitLab=discussion id（reply 必需）；Bitbucket 空 / GitHub=remoteId → 回退 remoteId。
          parentCommentId={comment.threadId ?? comment.remoteId}
          onCancel={() => setReplyOpen(false)}
          onPosted={() => setReplyOpen(false)}
        />
      )}
      {comment.replies.length > 0 && (
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
      )}
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
    </li>
  );
}

function formatRelativeTime(iso: string): string {
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
