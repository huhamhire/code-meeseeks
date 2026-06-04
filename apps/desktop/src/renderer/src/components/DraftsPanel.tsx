import { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { ReviewDraft, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../api';
import { useDraftsForPr } from '../stores/drafts-store';
import { ConfirmModal } from './ConfirmModal';

// posted 已不存在 (发布成功即删本地)，筛选项只保留 publishable / all / rejected
type Filter = 'all' | 'publishable' | 'rejected';

interface DraftsPanelProps {
  pr: StoredPullRequest;
  /** 点 anchor 跳 Diff 视图。父端 wire 到 pendingDiffNav (走 App 顶层) */
  onJumpToAnchor?: (draftId: string) => void;
}

/**
 * 草稿管理面板 (M4)。跟 CommentsPanel 同一个 tab 层级、视觉权重对齐 —— 一个看
 * 远端已发评论，一个看本地未发草稿，互补。
 *
 * 跟 DiffView 内嵌 DraftZone / PublishReviewModal 的关系：
 * - DraftZone：行内就地编辑，"看到代码 + 改"的主路径
 * - PublishReviewModal：一次性"批量发布"入口，全选默认 + 发布动作流
 * - DraftsPanel：常驻"草稿总览"，跨文件 + 跨 status 浏览 / 单条 actions
 *
 * status 筛选默认落在"待发布" — 用户最关心还没发的那批；筛选切到"已发布"可
 * 检视本 PR 自己发出去的评论历史，"已拒绝"可恢复 (M4 暂未做 unreject UI)
 */
export function DraftsPanel({ pr, onJumpToAnchor }: DraftsPanelProps) {
  const drafts = useDraftsForPr(pr.localId);
  const [filter, setFilter] = useState<Filter>('publishable');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // 多条草稿可能同时在发，用 Set 跟踪并发的 draftId 各自 disable / 文案
  const [publishingIds, setPublishingIds] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, publishable: 0, rejected: 0 };
    for (const d of drafts ?? []) {
      c.all++;
      if (d.status === 'pending' || d.status === 'edited') c.publishable++;
      else if (d.status === 'rejected') c.rejected++;
    }
    return c;
  }, [drafts]);

  const filtered = useMemo<ReviewDraft[]>(() => {
    const list = drafts ?? [];
    // 排序：同文件按 startLine 升序 (跟代码自上而下阅读顺序一致)；不同文件按
    // path 字典序 (跟文件树顺序对齐，扫起来不跳跃)
    const sorted = list.slice().sort((a, b) =>
      a.anchor.path === b.anchor.path
        ? a.anchor.startLine - b.anchor.startLine
        : a.anchor.path.localeCompare(b.anchor.path),
    );
    if (filter === 'all') return sorted;
    if (filter === 'publishable')
      return sorted.filter((d) => d.status === 'pending' || d.status === 'edited');
    return sorted.filter((d) => d.status === filter);
  }, [drafts, filter]);

  const setError = (draftId: string, msg: string | null): void => {
    setErrors((prev) => {
      const next = new Map(prev);
      if (msg === null) next.delete(draftId);
      else next.set(draftId, msg);
      return next;
    });
  };
  const markPublishing = (draftId: string, on: boolean): void => {
    setPublishingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(draftId);
      else next.delete(draftId);
      return next;
    });
  };

  const handlePublish = async (draftId: string): Promise<void> => {
    if (publishingIds.has(draftId)) return;
    setError(draftId, null);
    markPublishing(draftId, true);
    try {
      const resp = await invoke('drafts:publishBatch', {
        localId: pr.localId,
        draftIds: [draftId],
      });
      const r = resp.results[0];
      if (!r || !r.ok) {
        setError(draftId, r?.error ?? '发布失败');
      }
      // 成功 → main 端直接删本地草稿 (不留 posted 历史)，broadcastDraftsChanged
      // 让本面板重拉，被删的条目从列表里消失。远端评论由 force-refresh comments
      // 拉回，在 CommentsPanel / DiffView CommentZone 看
    } catch (e) {
      setError(draftId, e instanceof Error ? e.message : String(e));
    } finally {
      markPublishing(draftId, false);
    }
  };

  const handleDelete = async (draftId: string): Promise<void> => {
    await invoke('drafts:delete', { localId: pr.localId, draftId });
    setConfirmDelete(null);
  };

  // 草稿池正在 hydrate (首次进 PR) → 占位；fetched 后空数组才显示"无草稿"。
  // 空态也包在 .drafts-panel 里让 flex:1 撑满横向，不变成"随内容缩"的小盒子
  if (drafts === null) {
    return (
      <div className="drafts-panel">
        <div className="drafts-panel-empty muted">加载草稿中…</div>
      </div>
    );
  }
  if (drafts.length === 0) {
    return (
      <div className="drafts-panel">
        <div className="drafts-panel-empty muted">
          本 PR 暂无草稿。在「变更」视图行 hover「+」可创建评论草稿；或在「对话」
          视图里把 AI 建议 (/review、/ask) 转为草稿。
        </div>
      </div>
    );
  }

  return (
    <div className="drafts-panel">
      <nav className="drafts-panel-filter" role="tablist" aria-label="按状态筛选草稿">
        {(['publishable', 'all', 'rejected'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`drafts-panel-filter-btn${filter === f ? ' active' : ''}`}
            onClick={() => setFilter(f)}
            role="tab"
            aria-selected={filter === f}
          >
            {FILTER_LABEL[f]}
            {counts[f] > 0 && (
              <span className="drafts-panel-filter-badge">{counts[f]}</span>
            )}
          </button>
        ))}
      </nav>
      {filtered.length === 0 ? (
        <div className="drafts-panel-empty muted">当前筛选下没有草稿。</div>
      ) : (
        <ul className="drafts-panel-list">
          {filtered.map((d) => {
            const lineLabel =
              d.anchor.endLine !== d.anchor.startLine
                ? `${String(d.anchor.startLine)}-${String(d.anchor.endLine)}`
                : String(d.anchor.startLine);
            const sideLabel = d.anchor.side === 'old' ? '基线' : '新版';
            const publishable = d.status === 'pending' || d.status === 'edited';
            const pubErr = errors.get(d.id);
            const isPublishing = publishingIds.has(d.id);
            return (
              <li
                key={d.id}
                className={`drafts-panel-item drafts-panel-item-${d.status}`}
              >
                <div className="drafts-panel-item-head">
                  {onJumpToAnchor ? (
                    <button
                      type="button"
                      className="drafts-panel-item-anchor drafts-panel-item-anchor-link"
                      onClick={() => onJumpToAnchor(d.id)}
                      title="跳到 Diff 查看代码上下文"
                    >
                      {d.anchor.path}:{lineLabel}
                      <span className="muted"> · {sideLabel}</span>
                    </button>
                  ) : (
                    <code className="drafts-panel-item-anchor">
                      {d.anchor.path}:{lineLabel}
                      <span className="muted"> · {sideLabel}</span>
                    </code>
                  )}
                  <span className={`drafts-panel-item-status status-${d.status}`}>
                    {STATUS_LABEL[d.status]}
                  </span>
                  <span className="drafts-panel-item-origin muted">
                    {d.origin === 'finding' ? 'AI 建议' : '我的评论'}
                  </span>
                  <div className="drafts-panel-item-actions">
                    {publishable && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => void handlePublish(d.id)}
                        disabled={isPublishing || !d.body.trim()}
                        title={
                          !d.body.trim()
                            ? '空草稿不能发布'
                            : '发布这一条 (跟 DraftZone 内"发布"按钮同路径)'
                        }
                      >
                        {isPublishing ? '发布中…' : '发布'}
                      </button>
                    )}
                    {d.status !== 'posted' && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setConfirmDelete(d.id)}
                        disabled={isPublishing}
                        title="删除草稿（本地，不影响远端）"
                      >
                        删除
                      </button>
                    )}
                    {d.posted_remote_id && (
                      <span className="drafts-panel-item-remote muted">
                        远端 id: {d.posted_remote_id}
                      </span>
                    )}
                  </div>
                </div>
                <div className="drafts-panel-item-body markdown">
                  {d.body.trim() ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>
                      {d.body}
                    </ReactMarkdown>
                  ) : (
                    <span className="muted">(空草稿)</span>
                  )}
                </div>
                {pubErr && (
                  <div className="drafts-panel-item-error" role="alert">
                    发布失败：{pubErr}
                    <button
                      type="button"
                      className="drafts-panel-item-error-dismiss"
                      onClick={() => setError(d.id, null)}
                      aria-label="关闭错误"
                      title="知道了"
                    >
                      ✕
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirmDelete && (
        <ConfirmModal
          title="删除草稿"
          message="确定删除此草稿？删除后无法恢复。"
          confirmLabel="删除"
          cancelLabel="取消"
          danger
          onConfirm={() => void handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

const FILTER_LABEL: Record<Filter, string> = {
  publishable: '待发布',
  all: '全部',
  rejected: '已拒绝',
};

const STATUS_LABEL: Record<ReviewDraft['status'], string> = {
  pending: '待处理',
  edited: '已编辑',
  posted: '已发布',
  rejected: '已拒绝',
};
