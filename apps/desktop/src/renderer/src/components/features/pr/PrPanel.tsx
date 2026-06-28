import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LocalPrStatus,
  PlatformCapabilities,
  PrCommentAnchor,
  PrCommit,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke } from '../../../api';
import { useDraftsForPr } from '../../../stores/drafts-store';
import { PaneLoading } from '../../common';
import { ActivityPanel } from './tabs/activity/ActivityPanel';
import { CommitsPanel } from './tabs/CommitsPanel';
// Monaco 编辑器（~10MB）懒加载：只有真正切到 Diff tab 才拉取 DiffView chunk，
// 不阻塞窗口首帧 / PR 列表 / 首启向导。
const DiffView = lazy(() => import('./tabs/diff/DiffView').then((m) => ({ default: m.DiffView })));
import type { PendingCommitView } from './tabs/diff/DiffView';
import { DraftsPanel } from './tabs/drafts/DraftsPanel';
import { PrInfoView } from './tabs/PrInfoView';
import { PublishReviewModal } from './tabs/drafts/PublishReviewModal';
import { PrHeader } from './PrHeader';
import { PrTabs, type PrTab } from './tabs/PrTabs';

export interface PrPanelProps {
  pr: StoredPullRequest;
  onSetStatus: (status: LocalPrStatus) => void;
  onMerge: () => void;
  merging?: boolean;
  capabilities?: PlatformCapabilities;
  currentUserName?: string | null;
  /** 只读模式（已关闭 / 归档 PR）：隐藏评审决断 / 合并等写操作入口，仅供浏览。 */
  readOnly?: boolean;
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
  readOnly = false,
  pendingDiffNav,
  onDiffNavConsumed,
  onRequestDiffNav,
}: PrPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PrTab>('diff');
  // 活动标签页「新建评论」编辑框开关（由标签栏「评论」按钮触发，编辑框出现在时间线顶部）
  const [composingComment, setComposingComment] = useState(false);
  // 「查看特定 commit」请求：提交 / 活动标签页点击某 commit → 切到 Diff tab 本地渲染该 commit 变更
  const [pendingCommitView, setPendingCommitView] = useState<PendingCommitView | null>(null);
  const viewCommit = (commit: PrCommit): void => {
    setPendingCommitView({
      sha: commit.sha,
      parent: commit.parents[0] ?? null,
      abbreviatedSha: commit.abbreviatedSha,
      subject: commit.message.split('\n', 1)[0] ?? commit.abbreviatedSha,
    });
    setTab('diff');
  };
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
        readOnly={readOnly}
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
        activityTimeline={capabilities?.activityTimeline ?? false}
        onNewComment={() => setComposingComment(true)}
        showWhitespace={showWhitespace}
        onToggleWhitespace={() => setShowWhitespace((b) => !b)}
        showBlame={showBlame}
        onToggleBlame={() => setShowBlame((b) => !b)}
        renderSideBySide={renderSideBySide}
        onSetRenderSideBySide={setRenderSideBySide}
      />
      <div className="pr-tab-content">
        {/* keep-alive：各 tab 首访才挂载、之后保活仅 CSS 显隐（见 KeepAliveTab）。
            切走再切回瞬时、无重拉、内嵌 Monaco / 滚动位置 / 展开态全部保留，消除切换抖动。 */}
        <KeepAliveTab active={tab === 'diff'}>
          <Suspense fallback={<PaneLoading label={t('mainPane.loadingEditor')} />}>
            <DiffView
              pr={pr}
              renderSideBySide={renderSideBySide}
              showBlame={showBlame}
              showWhitespace={showWhitespace}
              capabilities={capabilities}
              pendingNav={pendingDiffNav ?? null}
              onNavConsumed={onDiffNavConsumed}
              pendingCommitView={pendingCommitView}
              onCommitViewConsumed={() => setPendingCommitView(null)}
            />
          </Suspense>
        </KeepAliveTab>
        <KeepAliveTab active={tab === 'activity'}>
          <ActivityPanel
            pr={pr}
            onCommentsLoaded={(n) => setCommentCount(n)}
            capabilities={capabilities}
            composing={composingComment}
            onComposeClose={() => setComposingComment(false)}
            currentUserName={currentUserName}
            onViewCommit={viewCommit}
            onJumpToAnchor={(a: PrCommentAnchor) =>
              onRequestDiffNav?.({
                anchor: { path: a.path, startLine: a.line, endLine: a.line },
              })
            }
          />
        </KeepAliveTab>
        <KeepAliveTab active={tab === 'drafts'}>
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
        </KeepAliveTab>
        <KeepAliveTab active={tab === 'commits'}>
          <CommitsPanel pr={pr} onViewCommit={viewCommit} />
        </KeepAliveTab>
        <KeepAliveTab active={tab === 'info'}>
          <PrInfoView pr={pr} />
        </KeepAliveTab>
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

/**
 * tab 内容保活容器：首次 active 才挂载（保留 DiffView 等的懒加载优势），此后**不卸载**，
 * 仅靠 CSS `display` 显隐。切走再切回瞬时、无重拉、内嵌 Monaco / 滚动位置 / 展开态全保留 →
 * 消除切换抖动。隐藏期 Monaco 容器尺寸为 0，再显示需重排——由编辑器侧 `automaticLayout`
 * 自动处理（见 DiffView / InlineCodeContext）。
 */
function KeepAliveTab({ active, children }: { active: boolean; children: ReactNode }) {
  // 「一旦 active 过就保活」latch：ref 在 render 期写入是幂等闩锁，与本仓 stablePr 同模式。
  const mounted = useRef(false);
  if (active) mounted.current = true;
  if (!mounted.current) return null;
  return (
    <div className="pr-tab-pane" style={{ display: active ? undefined : 'none' }}>
      {children}
    </div>
  );
}
