import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { LocalPrStatus, PlatformCapabilities, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../api';
import { useDraftsForPr } from '../../../stores/drafts-store';
import { PaneLoading } from '../../common/Loading';
import { CommentsPanel } from './comments/CommentsPanel';
import { CommitsPanel } from './CommitsPanel';
// Monaco 编辑器（~10MB）懒加载：只有真正切到 Diff tab 才拉取 DiffView chunk，
// 不阻塞窗口首帧 / PR 列表 / 首启向导。
const DiffView = lazy(() => import('./diff/DiffView').then((m) => ({ default: m.DiffView })));
import { DraftsPanel } from './drafts/DraftsPanel';
import { PrInfoView } from './PrInfoView';
import { PublishReviewModal } from './drafts/PublishReviewModal';
import { PrHeader } from './PrHeader';
import { PrTabs, type PrTab } from './PrTabs';

export interface PrPanelProps {
  pr: StoredPullRequest;
  onSetStatus: (status: LocalPrStatus) => void;
  onMerge: () => void;
  merging?: boolean;
  capabilities?: PlatformCapabilities;
  currentUserName?: string | null;
  pendingDiffNav?: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  } | null;
  onDiffNavConsumed?: () => void;
  onRequestDiffNav?: (target: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  }) => void;
}

/**
 * PR 评审工作区：头部（标题 / 动作）+ tab 栏 + tab 内容（diff / 评论 / 草稿 / 提交 / 信息）+
 * 发布评论弹窗。承载 PR 详情相关的全部状态（当前 tab / diff 视图选项 / 评论 + 提交计数 /
 * 草稿池 / 发布弹窗），由 layout/MainPane 在选中 PR 时挂载。
 */
export function PrPanel({
  pr,
  onSetStatus,
  onMerge,
  merging = false,
  capabilities,
  currentUserName,
  pendingDiffNav,
  onDiffNavConsumed,
  onRequestDiffNav,
}: PrPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PrTab>('diff');
  // 收到跳转请求 → 强制切到 Diff tab，DiffView 自己负责消费 anchor
  useEffect(() => {
    if (pendingDiffNav) setTab('diff');
  }, [pendingDiffNav]);
  const [renderSideBySide, setRenderSideBySide] = useState<boolean>(() => {
    const v = localStorage.getItem('meebox.diffMode');
    return v === null ? true : v === 'side-by-side';
  });
  // Blame 默认关：每次启动都得手动开（blame fetch 可能慢/失败，不希望用户进来就被错误 banner 干扰）
  const [showBlame, setShowBlame] = useState<boolean>(false);
  // 空白字符可视化：默认关（大多数 review 不关心空格 / tab；强调时再开）
  const [showWhitespace, setShowWhitespace] = useState<boolean>(
    () => localStorage.getItem('meebox.showWhitespace') === '1',
  );
  useEffect(() => {
    localStorage.setItem('meebox.showWhitespace', showWhitespace ? '1' : '0');
  }, [showWhitespace]);
  // 评论 / commits 数 chip：PR 切换时各拉一次，cancelled token 防 race。deps 含 pr.updatedAt：
  // 远端变更后 poller 拉到 → store 更新 → 这里重跑刷新计数，app 一直开着也能跟上远端变动。
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [commitCount, setCommitCount] = useState<number | null>(null);
  const prLocalId = pr.localId;
  const prUpdatedAt = pr.updatedAt;
  useEffect(() => {
    setCommentCount(null);
    setCommitCount(null);
    let cancelled = false;
    void (async () => {
      try {
        const [cm, cc] = await Promise.all([
          // force:true 跳过 cache stale 比对 — 本地 PR.updatedAt 可能滞后于远端（poller 周期性拉）。
          invoke('diff:listComments', { localId: prLocalId, force: true }),
          invoke('diff:commitCount', { localId: prLocalId }),
        ]);
        if (cancelled) return;
        setCommentCount(cm.length);
        setCommitCount(cc?.count ?? null);
      } catch {
        // 静默：角标不显示数字，不该挡用户视线
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prLocalId, prUpdatedAt]);
  useEffect(() => {
    localStorage.setItem('meebox.diffMode', renderSideBySide ? 'side-by-side' : 'unified');
  }, [renderSideBySide]);
  // 清掉历史遗留的 showBlame 持久化值；新逻辑不再读写它
  useEffect(() => {
    if (localStorage.getItem('meebox.showBlame') !== null) {
      localStorage.removeItem('meebox.showBlame');
    }
  }, []);

  // M4 草稿池 → "提交评论 (N)" 按钮的 N。pending + edited 才算 publishable；
  // rejected（用户决断不发）/ posted（远端已发）都排除
  const drafts = useDraftsForPr(prLocalId);
  const publishableCount = useMemo(
    () =>
      (drafts ?? []).reduce(
        (n, d) => (d.status === 'pending' || d.status === 'edited' ? n + 1 : n),
        0,
      ),
    [drafts],
  );
  // 草稿 tab 显示条件用总数（任何 status 都算）；只有从来没创建过草稿的 PR 才完全隐藏 tab
  const totalDraftCount = (drafts ?? []).length;
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  // 兜底：停在 'drafts' tab 但草稿全清空 → 切回 'diff' 避免显示孤儿空白内容区
  useEffect(() => {
    if (tab === 'drafts' && totalDraftCount === 0) setTab('diff');
  }, [tab, totalDraftCount]);

  return (
    <>
      <PrHeader
        pr={pr}
        capabilities={capabilities}
        currentUserName={currentUserName}
        merging={merging}
        onMerge={onMerge}
        onSetStatus={onSetStatus}
        publishableCount={publishableCount}
        onPublish={() => setPublishModalOpen(true)}
      />
      <PrTabs
        tab={tab}
        onTab={setTab}
        commentCount={commentCount}
        commitCount={commitCount}
        totalDraftCount={totalDraftCount}
        publishableCount={publishableCount}
        showWhitespace={showWhitespace}
        onToggleWhitespace={() => setShowWhitespace((b) => !b)}
        showBlame={showBlame}
        onToggleBlame={() => setShowBlame((b) => !b)}
        renderSideBySide={renderSideBySide}
        onSetRenderSideBySide={setRenderSideBySide}
      />
      <div className="pr-tab-content">
        {tab === 'diff' && (
          <Suspense fallback={<PaneLoading label={t('mainPane.loadingEditor')} />}>
            <DiffView
              pr={pr}
              renderSideBySide={renderSideBySide}
              showBlame={showBlame}
              showWhitespace={showWhitespace}
              capabilities={capabilities}
              pendingNav={pendingDiffNav ?? null}
              onNavConsumed={onDiffNavConsumed}
            />
          </Suspense>
        )}
        {tab === 'comments' && (
          <CommentsPanel
            pr={pr}
            onCommentsLoaded={(n) => setCommentCount(n)}
            capabilities={capabilities}
          />
        )}
        {tab === 'drafts' && (
          <DraftsPanel
            pr={pr}
            capabilities={capabilities}
            onJumpToAnchor={(draftId) => {
              const d = (drafts ?? []).find((x) => x.id === draftId);
              if (!d) return;
              onRequestDiffNav?.({
                anchor: {
                  path: d.anchor.path,
                  startLine: d.anchor.startLine,
                  endLine: d.anchor.endLine,
                },
              });
            }}
          />
        )}
        {tab === 'commits' && <CommitsPanel pr={pr} />}
        {tab === 'info' && <PrInfoView pr={pr} />}
      </div>
      {publishModalOpen && (
        <PublishReviewModal
          localId={pr.localId}
          drafts={drafts ?? []}
          onClose={() => setPublishModalOpen(false)}
          onJumpToAnchor={(draftId) => {
            // 点 anchor → 关 modal + 转 pendingDiffNav 上抛给 App。runId/findingId 不带 →
            // DiffView 仅 navigate 不进 edit（用户想看代码上下文，不一定是要改草稿）。
            const d = (drafts ?? []).find((x) => x.id === draftId);
            if (!d) return;
            setPublishModalOpen(false);
            onRequestDiffNav?.({
              anchor: {
                path: d.anchor.path,
                startLine: d.anchor.startLine,
                endLine: d.anchor.endLine,
              },
            });
          }}
        />
      )}
    </>
  );
}
