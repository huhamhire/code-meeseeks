import { useEffect, useMemo, useState } from 'react';
import type { ReviewDraft } from '@meebox/shared';
import { invoke } from '../api';

/**
 * 批量发布草稿到 Bitbucket 的确认 modal。M4 发布闭环最后一公里。
 *
 * 流程：
 *   1. confirm: 列出本 PR 所有可发布草稿 (pending + edited)，用户可勾选 / 取消
 *   2. publishing: 调 drafts:publishBatch，main 端串行 POST 到 Bitbucket
 *   3. done: 显示成功 N 条 / 失败 M 条 + 每条失败明细
 *
 * - rejected 草稿不在列表里 (用户决断不发)
 * - posted 草稿不在列表里 (远端已经有，避免重复)
 * - 默认全部勾选 — 用户进 modal 已经表达"想发评论"的意图，全选符合多数场景；
 *   不想发的单条可取消
 */
type Phase = 'confirm' | 'publishing' | 'done';

interface PublishResult {
  draftId: string;
  ok: boolean;
  postedRemoteId?: string;
  error?: string;
}

export function PublishReviewModal({
  localId,
  drafts,
  onClose,
  onJumpToAnchor,
}: {
  localId: string;
  /** 本 PR 全部草稿；modal 自己过滤出 publishable (pending + edited) */
  drafts: ReadonlyArray<ReviewDraft>;
  onClose: () => void;
  /**
   * 用户点 anchor (path:line) 时调用。父端通常实现为：关闭 modal + 触发 Diff
   * 跳转到该草稿位置 (复用 pendingDiffNav 链路)。不传则 anchor 不可点
   */
  onJumpToAnchor?: (draftId: string) => void;
}) {
  // 列表用快照：进入 modal 时定下，避免 drafts 变动 (其它窗口编辑) 把当前选择洗掉
  const candidates = useMemo<ReviewDraft[]>(
    () => drafts.filter((d) => d.status === 'pending' || d.status === 'edited'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(candidates.map((d) => d.id)),
  );
  const [phase, setPhase] = useState<Phase>('confirm');
  const [results, setResults] = useState<PublishResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Esc 关闭 (publishing 阶段禁用避免误中断；done 阶段允许)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && phase !== 'publishing') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = (): void => {
    setSelected((prev) =>
      prev.size === candidates.length ? new Set() : new Set(candidates.map((d) => d.id)),
    );
  };

  const handlePublish = async (): Promise<void> => {
    if (selected.size === 0) return;
    setError(null);
    setPhase('publishing');
    try {
      const resp = await invoke('drafts:publishBatch', {
        localId,
        draftIds: Array.from(selected),
      });
      setResults(resp.results);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('confirm');
    }
  };

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  // 进入时本 PR 没有 publishable 草稿 → 直接显示空态 (理论上 header 按钮 disabled
  // 时不会触发开 modal，但作 fallback)
  if (candidates.length === 0) {
    return (
      <div className="publish-review-backdrop" onClick={onClose}>
        <div className="publish-review-modal" onClick={(e) => e.stopPropagation()}>
          <header className="publish-review-head">
            <h3>提交评论</h3>
          </header>
          <div className="publish-review-body">
            <p className="muted">当前 PR 没有待发布的草稿。</p>
          </div>
          <footer className="publish-review-foot">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              关闭
            </button>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className="publish-review-backdrop" onClick={onClose}>
      <div className="publish-review-modal" onClick={(e) => e.stopPropagation()}>
        <header className="publish-review-head">
          <h3>
            {phase === 'done'
              ? '发布完成'
              : phase === 'publishing'
                ? '发布中…'
                : `提交评论 (${selected.size}/${candidates.length})`}
          </h3>
        </header>

        {phase === 'confirm' && (
          <>
            <div className="publish-review-body">
              <div className="publish-review-toolbar">
                <button type="button" className="btn-link" onClick={toggleAll}>
                  {selected.size === candidates.length ? '取消全选' : '全选'}
                </button>
                <span className="muted">
                  共 {candidates.length} 条，已选 {selected.size}
                </span>
              </div>
              <ul className="publish-review-list">
                {candidates.map((d) => {
                  const lineLabel =
                    d.anchor.endLine !== d.anchor.startLine
                      ? `${String(d.anchor.startLine)}-${String(d.anchor.endLine)}`
                      : String(d.anchor.startLine);
                  const sideLabel = d.anchor.side === 'old' ? '基线' : '新版';
                  return (
                    <li key={d.id} className="publish-review-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.has(d.id)}
                          onChange={() => toggle(d.id)}
                        />
                        <div className="publish-review-item-meta">
                          {/* anchor 可点 → 关 modal + 跳 Diff；checkbox label 是 outer，
                              这里 stopPropagation 防 click 触发勾选切换 */}
                          {onJumpToAnchor ? (
                            <button
                              type="button"
                              className="publish-review-item-anchor publish-review-item-anchor-link"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onJumpToAnchor(d.id);
                              }}
                              title="跳到 Diff 查看代码上下文"
                            >
                              {d.anchor.path}:{lineLabel}
                              <span className="muted"> · {sideLabel}</span>
                            </button>
                          ) : (
                            <code className="publish-review-item-anchor">
                              {d.anchor.path}:{lineLabel}
                              <span className="muted"> · {sideLabel}</span>
                            </code>
                          )}
                          <span className={`publish-review-item-status status-${d.status}`}>
                            {d.status === 'pending' ? '待处理' : '已编辑'}
                          </span>
                        </div>
                      </label>
                      <pre className="publish-review-item-body">{d.body}</pre>
                    </li>
                  );
                })}
              </ul>
              {error && <div className="publish-review-error">{error}</div>}
            </div>
            <footer className="publish-review-foot">
              <button type="button" className="btn btn-sm" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={selected.size === 0}
                onClick={() => void handlePublish()}
                title={selected.size === 0 ? '至少选择一条' : '发布到 Bitbucket'}
              >
                发布 {selected.size} 条
              </button>
            </footer>
          </>
        )}

        {phase === 'publishing' && (
          <div className="publish-review-body publish-review-publishing">
            <div className="publish-review-spinner" aria-hidden="true" />
            <p>正在串行发布 {selected.size} 条评论到 Bitbucket…</p>
            <p className="muted">请勿关闭窗口</p>
          </div>
        )}

        {phase === 'done' && (
          <>
            <div className="publish-review-body">
              <div className="publish-review-summary">
                <span className="publish-review-summary-ok">✓ 成功 {okCount}</span>
                {failCount > 0 && (
                  <span className="publish-review-summary-fail">✗ 失败 {failCount}</span>
                )}
              </div>
              {failCount > 0 && (
                <ul className="publish-review-failures">
                  {results
                    .filter((r) => !r.ok)
                    .map((r) => {
                      const d = candidates.find((c) => c.id === r.draftId);
                      return (
                        <li key={r.draftId}>
                          <code>
                            {d ? `${d.anchor.path}:${d.anchor.startLine}` : r.draftId}
                          </code>
                          <span className="publish-review-failure-msg"> — {r.error}</span>
                        </li>
                      );
                    })}
                </ul>
              )}
              {failCount === 0 && (
                <p className="muted">所有草稿已写入远端，评论列表会立即刷新。</p>
              )}
            </div>
            <footer className="publish-review-foot">
              <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
                关闭
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
