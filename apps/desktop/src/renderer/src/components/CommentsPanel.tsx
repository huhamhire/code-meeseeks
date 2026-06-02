import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { PrComment, StoredPullRequest } from '@pr-pilot/shared';
import { invoke } from '../api';
import { formatBackendError, type FormattedError } from '../errors';
import { Avatar } from './Avatar';
import { InlineCodeContext } from './InlineCodeContext';

interface CommentsPanelProps {
  pr: StoredPullRequest;
  /** 拉取成功后回调，把顶层评论数 (不含 replies) 报给父组件用于 tab 角标 */
  onCommentsLoaded?: (count: number) => void;
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
export function CommentsPanel({ pr, onCommentsLoaded }: CommentsPanelProps) {
  const [comments, setComments] = useState<PrComment[] | null>(null);
  const [error, setError] = useState<FormattedError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setComments(null);
    setError(null);
    void (async () => {
      try {
        const list = await invoke('diff:listComments', { localId: pr.localId });
        if (!cancelled) {
          setComments(list);
          onCommentsLoaded?.(list.length);
        }
      } catch (e) {
        if (!cancelled) setError(formatBackendError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
    // onCommentsLoaded 故意不放依赖：父组件每次 render 都会重传新 ref，会触发误重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.localId]);

  // 按 createdAt **倒序** (newest first)：评论页主要给用户快速看最新动态用，
  // 不是逐条对话回溯，最新在顶部更合理
  const ordered = useMemo(
    () => (comments ?? []).slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    [comments],
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

  if (error) {
    return (
      <div className="pr-comments-panel">
        <div className="pr-comments-error" role="alert">
          <strong>评论加载失败 · {error.title}</strong>
          <pre>{error.detail}</pre>
        </div>
      </div>
    );
  }
  if (comments === null) {
    return (
      <div className="pr-comments-panel">
        <p className="muted">加载评论中…</p>
      </div>
    );
  }
  if (ordered.length === 0) {
    return (
      <div className="pr-comments-panel">
        <p className="muted">这条 PR 还没有任何评论</p>
      </div>
    );
  }

  return (
    <div className="pr-comments-panel">
      <ul className="pr-comments-list">
        {ordered.map((c) => (
          <CommentItem
            key={c.remoteId}
            comment={c}
            pr={pr}
            depth={0}
            autoExpandCode={autoExpandSet.has(c.remoteId)}
          />
        ))}
      </ul>
    </div>
  );
}

/**
 * 单条评论 + 嵌套 replies。inline 评论顶部显示 `path:line side` chip 区分锚点位置；
 * summary 评论不挂 chip。replies 走递归，depth 控制左侧缩进 (BBS 实际只一层 reply
 * 但 schema 允许深嵌套，递归更稳)。
 */
function CommentItem({
  comment,
  pr,
  depth,
  autoExpandCode = false,
}: {
  comment: PrComment;
  pr: StoredPullRequest;
  depth: number;
  /** 顶层 (depth=0) 由父组件按 CAP 决定 true/false；replies 总是 false (不渲染 code) */
  autoExpandCode?: boolean;
}) {
  return (
    <li className={`pr-comment pr-comment-depth-${String(depth)}`}>
      <div className="pr-comment-head">
        <Avatar
          connectionId={pr.connectionId}
          slug={comment.author.slug ?? comment.author.name}
          displayName={comment.author.displayName}
          size={22}
        />
        <span className="pr-comment-author">{comment.author.displayName}</span>
        {comment.anchor && (
          // inline 评论锚点 chip：path:line + 侧别 (old=base / new=head)。
          // 让用户在评论面板里也能定位到代码位置 (后续可点击跳 Diff 视图)
          <span
            className={`pr-comment-anchor pr-comment-anchor-${comment.anchor.side}`}
            title={`锚定 ${comment.anchor.side === 'old' ? 'base' : 'head'} 侧 · ${comment.anchor.lineType}`}
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
        <InlineCodeContext pr={pr} anchor={comment.anchor} autoExpand={autoExpandCode} />
      )}
      <div className="pr-comment-body markdown">
        <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{comment.body}</ReactMarkdown>
      </div>
      {comment.replies.length > 0 && (
        <ul className="pr-comments-list pr-comments-replies">
          {comment.replies.map((r) => (
            <CommentItem key={r.remoteId} comment={r} pr={pr} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

function formatRelativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (diffSec < 60) return '刚刚';
  if (diffSec < 3600) return `${String(Math.round(diffSec / 60))} 分钟前`;
  if (diffSec < 86400) return `${String(Math.round(diffSec / 3600))} 小时前`;
  if (diffSec < 86400 * 7) return `${String(Math.round(diffSec / 86400))} 天前`;
  return new Date(t).toLocaleDateString();
}
