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
  const [showBlame, setShowBlame] = useState<boolean>(
    () => localStorage.getItem('pr-pilot.showBlame') === '1',
  );
  useEffect(() => {
    localStorage.setItem('pr-pilot.diffMode', renderSideBySide ? 'side-by-side' : 'unified');
  }, [renderSideBySide]);
  useEffect(() => {
    localStorage.setItem('pr-pilot.showBlame', showBlame ? '1' : '0');
  }, [showBlame]);

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
          {pr.localStatus !== 'skipped' && (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => onSetStatus('skipped')}
            >
              跳过
            </button>
          )}
          {pr.localStatus !== 'reviewed' && (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => onSetStatus('reviewed')}
            >
              已评
            </button>
          )}
          {pr.localStatus !== 'ignored' && (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => onSetStatus('ignored')}
            >
              忽略
            </button>
          )}
          {pr.localStatus !== 'pending' && (
            <button
              className="btn btn-sm"
              type="button"
              onClick={() => onSetStatus('pending')}
            >
              重置
            </button>
          )}
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
              title={showBlame ? '关闭 blame 显示' : '开启 blame 显示（仅 head 侧）'}
              aria-pressed={showBlame}
            >
              <BlameIcon /> Blame
            </button>
            <div className="diff-mode-toggle" role="tablist" aria-label="diff 显示模式">
              <button
                type="button"
                className={renderSideBySide ? 'active' : ''}
                onClick={() => setRenderSideBySide(true)}
                role="tab"
                aria-selected={renderSideBySide}
              >
                并列
              </button>
              <button
                type="button"
                className={!renderSideBySide ? 'active' : ''}
                onClick={() => setRenderSideBySide(false)}
                role="tab"
                aria-selected={!renderSideBySide}
              >
                合并
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
