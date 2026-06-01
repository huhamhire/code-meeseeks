import { useEffect, useState } from 'react';
import type { LocalPrStatus, StoredPullRequest } from '@pr-pilot/shared';
import { DiffView } from './DiffView';
import { PrInfoView } from './PrInfoView';

function BlameIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 13c0-2.5 2.2-4 5-4s5 1.5 5 4" />
    </svg>
  );
}

function ApproveIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M5 8.3l2.2 2.2L11 6.5" />
    </svg>
  );
}

function NeedsWorkIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5v4.2" />
      <circle cx="8" cy="11.3" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

interface MainPaneProps {
  pr: StoredPullRequest | null;
  hasConnections: boolean;
  onSetStatus: (status: LocalPrStatus) => void;
}

type Tab = 'diff' | 'info';

export function MainPane({ pr, hasConnections, onSetStatus }: MainPaneProps) {
  const [tab, setTab] = useState<Tab>('diff');
  const [renderSideBySide, setRenderSideBySide] = useState<boolean>(() => {
    const v = localStorage.getItem('pr-pilot.diffMode');
    return v === null ? true : v === 'side-by-side';
  });
  // Blame 默认关：每次启动都得手动开（blame fetch 可能慢/失败，不希望
  // 用户进来就被错误 banner 干扰）
  const [showBlame, setShowBlame] = useState<boolean>(false);
  useEffect(() => {
    localStorage.setItem('pr-pilot.diffMode', renderSideBySide ? 'side-by-side' : 'unified');
  }, [renderSideBySide]);
  // 清掉历史遗留的 showBlame 持久化值；新逻辑不再读写它
  useEffect(() => {
    if (localStorage.getItem('pr-pilot.showBlame') !== null) {
      localStorage.removeItem('pr-pilot.showBlame');
    }
  }, []);

  if (!pr) {
    return (
      <main className="main">
        <div className="main-empty">
          {hasConnections ? (
            <div>
              <p>← 从左侧选择一个 PR</p>
              <p className="muted" style={{ marginTop: 12 }}>
                选中后会自动 sync 本地镜像并显示 side-by-side diff
              </p>
            </div>
          ) : (
            <div>
              <p>尚未配置任何连接</p>
              <p className="muted" style={{ marginTop: 12 }}>
                右下"设置"→"编辑 config.yaml"添加 Bitbucket Server 连接
              </p>
            </div>
          )}
        </div>
      </main>
    );
  }

  return (
    <main className="main">
      <header className="pr-header">
        <h2 className="pr-header-title">
          <span className="muted">#{pr.remoteId}</span> {pr.title}
        </h2>
        <div className="pr-header-meta">
          {pr.hasConflict && (
            <>
              <span className="conflict-tag" title="远端 BBS 报告存在合并冲突">
                ⚠️ 冲突
              </span>
              <span> · </span>
            </>
          )}
          <strong>
            {pr.repo.projectKey}/{pr.repo.repoSlug}
          </strong>
          <span> · {pr.author.displayName}</span>
          <span>
            {' '}
            · {pr.sourceRef.displayId} → {pr.targetRef.displayId}
          </span>
          <span> · </span>
          <span className={`status-tag status-${pr.localStatus}`}>{pr.localStatus}</span>
        </div>
        <div className="pr-header-actions">
          <a className="btn btn-primary btn-sm" href={pr.url} target="_blank" rel="noreferrer">
            浏览器打开
          </a>
          {/* approve / needs work：当前状态 = 高亮；点已高亮的回退到 pending（撤销远端标记）。
              这两个 review 决断按钮右对齐，跟"浏览器打开"在左侧拉开距离 */}
          <div className="pr-header-actions-right">
            <button
              className={`btn btn-sm review-action review-action-approve ${pr.localStatus === 'approved' ? 'active' : ''}`}
              type="button"
              onClick={() =>
                onSetStatus(pr.localStatus === 'approved' ? 'pending' : 'approved')
              }
              title={pr.localStatus === 'approved' ? '撤销通过' : '标记为通过'}
              aria-pressed={pr.localStatus === 'approved'}
            >
              <ApproveIcon /> 通过
            </button>
            <button
              className={`btn btn-sm review-action review-action-needs-work ${pr.localStatus === 'needs_work' ? 'active' : ''}`}
              type="button"
              onClick={() =>
                onSetStatus(pr.localStatus === 'needs_work' ? 'pending' : 'needs_work')
              }
              title={pr.localStatus === 'needs_work' ? '撤销"需修改"' : '标记为需修改'}
              aria-pressed={pr.localStatus === 'needs_work'}
            >
              <NeedsWorkIcon /> 需修改
            </button>
          </div>
        </div>
      </header>
      <nav className="pr-tabs" role="tablist">
        <button
          type="button"
          className={`pr-tab ${tab === 'diff' ? 'active' : ''}`}
          onClick={() => setTab('diff')}
          role="tab"
          aria-selected={tab === 'diff'}
        >
          Diff
        </button>
        <button
          type="button"
          className={`pr-tab ${tab === 'info' ? 'active' : ''}`}
          onClick={() => setTab('info')}
          role="tab"
          aria-selected={tab === 'info'}
        >
          详情
        </button>
        {tab === 'diff' && (
          <div className="pr-tabs-right">
            <button
              type="button"
              className={`blame-toggle ${showBlame ? 'active' : ''}`}
              onClick={() => setShowBlame((b) => !b)}
              title={showBlame ? '关闭追溯显示' : '开启追溯显示（仅 head 侧）'}
              aria-pressed={showBlame}
            >
              <BlameIcon /> 追溯
            </button>
            <div className="diff-mode-toggle" role="tablist" aria-label="diff 显示模式">
              <button
                type="button"
                className={renderSideBySide ? 'active' : ''}
                onClick={() => setRenderSideBySide(true)}
                role="tab"
                aria-selected={renderSideBySide}
              >
                并排
              </button>
              <button
                type="button"
                className={!renderSideBySide ? 'active' : ''}
                onClick={() => setRenderSideBySide(false)}
                role="tab"
                aria-selected={!renderSideBySide}
              >
                统一
              </button>
            </div>
          </div>
        )}
      </nav>
      <div className="pr-tab-content">
        {tab === 'diff' ? (
          <DiffView pr={pr} renderSideBySide={renderSideBySide} showBlame={showBlame} />
        ) : (
          <PrInfoView pr={pr} />
        )}
      </div>
    </main>
  );
}
