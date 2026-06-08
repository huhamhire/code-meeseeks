import { useEffect, useMemo, useState } from 'react';
import type {
  LocalPrStatus,
  PlatformCapabilities,
  ReviewerStatus,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke } from '../api';
import { useDraftsForPr } from '../stores/drafts-store';
import { CommentsPanel } from './CommentsPanel';
import { CommitsPanel } from './CommitsPanel';
import { DiffView } from './DiffView';
import { DraftsPanel } from './DraftsPanel';
import { PrInfoView } from './PrInfoView';
import { PublishReviewModal } from './PublishReviewModal';
import { PullRequestIcon } from './icons';

// Globe 网格图标：地球经纬度示意，跟"在远端浏览器打开"语义匹配
function GlobeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6.5" />
      <ellipse cx="8" cy="8" rx="3" ry="6.5" />
      <line x1="1.5" y1="8" x2="14.5" y2="8" />
    </svg>
  );
}

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

/** 空白字符显示图标：·→· 暗示 space + tab 可视化 */
function WhitespaceIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="3" cy="8" r="0.8" fill="currentColor" />
      <path d="M6 8 h6 m-2 -2 l2 2 l-2 2" />
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
  /** 合并当前 PR（仅在 mergeStatus.canMerge 时由 header 按钮触发） */
  onMerge: () => void;
  /**
   * 当前 PR 所属连接的平台能力（多平台降级用）。undefined = 未知（无连接/旧数据）→ 不降级。
   * 据此决定审批按钮 显/隐（reviewStatuses）等。
   */
  capabilities?: PlatformCapabilities;
  /** 当前 PR 所属连接的 PAT 用户登录名；用于判定「是否自己的 PR」（不能审批自己）。 */
  currentUserName?: string | null;
  /**
   * M4 跨组件跳转：ChatPane finding card 点"编辑"时由 App 设置，MainPane 据此
   * 切到 Diff tab + 把 nav 透传给 DiffView 做 scroll/highlight/open zone。
   * DiffView 消费完应调用 onDiffNavConsumed 清掉。
   */
  pendingDiffNav?: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  } | null;
  onDiffNavConsumed?: () => void;
  /**
   * 反向通道：MainPane 内部组件 (e.g., PublishReviewModal) 也能触发 Diff 跳转。
   * App 端实际跑 setPendingDiffNav；MainPane 自己 useEffect 切 tab='diff' 并把
   * nav 透传给 DiffView，复用同一条消费链路
   */
  onRequestDiffNav?: (target: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  }) => void;
}

type Tab = 'diff' | 'comments' | 'drafts' | 'commits' | 'info';

export function MainPane({
  pr,
  hasConnections,
  onSetStatus,
  onMerge,
  capabilities,
  currentUserName,
  pendingDiffNav,
  onDiffNavConsumed,
  onRequestDiffNav,
}: MainPaneProps) {
  const [tab, setTab] = useState<Tab>('diff');
  // 收到跳转请求 → 强制切到 Diff tab，DiffView 自己负责消费 anchor
  useEffect(() => {
    if (pendingDiffNav) setTab('diff');
  }, [pendingDiffNav]);
  const [renderSideBySide, setRenderSideBySide] = useState<boolean>(() => {
    const v = localStorage.getItem('meebox.diffMode');
    return v === null ? true : v === 'side-by-side';
  });
  // Blame 默认关：每次启动都得手动开（blame fetch 可能慢/失败，不希望
  // 用户进来就被错误 banner 干扰）
  const [showBlame, setShowBlame] = useState<boolean>(false);
  // 空白字符可视化：默认关 (大多数代码 review 不关心空格 / tab；强调时再开)
  const [showWhitespace, setShowWhitespace] = useState<boolean>(
    () => localStorage.getItem('meebox.showWhitespace') === '1',
  );
  useEffect(() => {
    localStorage.setItem('meebox.showWhitespace', showWhitespace ? '1' : '0');
  }, [showWhitespace]);
  // 评论 / commits 数 chip：
  //   - 评论：调 diff:listComments — cache 命中 (pr.updatedAt 跟缓存一致) 时
  //     cheap 回缓存；stale / cache miss 时主动拉远端写回缓存。打开 PR 时
  //     按需异步刷新最新评论计数，不依赖用户去点 Comments tab 触发
  //   - commits：走本地 git rev-list base..head，镜像没拉齐 → 不显示数字
  // 都是 PR 切换时各拉一次，cancelled token 防 race。deps 含 pr?.updatedAt：
  // Bitbucket 上加评论 / 状态变更后远端 updatedAt 跳变 → poller 拉到 → store 更新 →
  // 这里 useEffect 重跑 → force 刷新评论 + 计数。用户 app 一直开着不切走 PR 时
  // 也能跟上远端变动
  const [commentCount, setCommentCount] = useState<number | null>(null);
  const [commitCount, setCommitCount] = useState<number | null>(null);
  const prLocalId = pr?.localId;
  const prUpdatedAt = pr?.updatedAt;
  useEffect(() => {
    setCommentCount(null);
    setCommitCount(null);
    if (!prLocalId) return;
    let cancelled = false;
    void (async () => {
      try {
        const [cm, cc] = await Promise.all([
          // force:true 跳过 cache stale 比对 — 本地 PR.updatedAt 可能滞后于远端
          // (poller 周期性拉)，stale 比对会误判命中。打开 PR 时强制刷一次拿到
          // 最新评论 + 计数
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
  // rejected (用户决断不发) / posted (远端已发) 都排除
  const drafts = useDraftsForPr(prLocalId);
  const publishableCount = useMemo(
    () =>
      (drafts ?? []).reduce(
        (n, d) => (d.status === 'pending' || d.status === 'edited' ? n + 1 : n),
        0,
      ),
    [drafts],
  );
  // 草稿 tab 显示条件用总数 (任何 status 都算) —— 用户发完所有 pending 后仍可
  // 进 tab 看 posted/rejected 历史；只有从来没创建过草稿的 PR 才完全隐藏 tab
  const totalDraftCount = (drafts ?? []).length;
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  // 兜底：当前停在 'drafts' tab 但草稿全清空 (e.g., 用户手动删了最后一条) → 切回
  // 'diff' 避免显示孤儿空白内容区
  useEffect(() => {
    if (tab === 'drafts' && totalDraftCount === 0) setTab('diff');
  }, [tab, totalDraftCount]);

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

  // 能力位降级：reviewStatuses 决定审批按钮显隐；自己作者的 PR 不能审批（GitHub 422，
  // 其它平台也无意义）→ 灰显 + 原因。capabilities undefined（旧数据/无连接）时不降级。
  const reviewAllowed = (s: ReviewerStatus): boolean =>
    !capabilities || capabilities.reviewStatuses.includes(s);
  const isOwnPr = !!currentUserName && pr.author.name === currentUserName;
  const ownPrReason = isOwnPr ? '不能审批自己的 PR' : undefined;

  return (
    <main className="main">
      <header className="pr-header">
        <h2 className="pr-header-title">
          <span className="muted">#{pr.remoteId}</span> {pr.title}
        </h2>
        <div className="pr-header-meta">
          {pr.hasConflict && (
            <>
              <span className="conflict-tag" title="远端 Bitbucket 报告存在合并冲突">
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
          <a
            className="btn btn-primary btn-sm pr-header-open-browser"
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            title="在系统默认浏览器打开 PR 远端页面"
          >
            <GlobeIcon /> 浏览器打开
          </a>
          {/* approve / needs work：当前状态 = 高亮；点已高亮的回退到 pending（撤销远端标记）。
              这两个 review 决断按钮右对齐，跟"浏览器打开"在左侧拉开距离。
              "提交评论 (N)" 放在决断按钮左边 — 评审动作分两步：先发评论 (左)，
              再下决断 (右)，从左到右符合阅读顺序。
              文案用"评论"不用"评审"：跟右侧"通过/需修改"两个评审决断按钮区分，
              本按钮只发评论，不下决断 (那是 /approve /needswork 的事) */}
          <div className="pr-header-actions-right">
            {/* "提交评论" 仅在有待发布草稿时渲染：N=0 时整按钮隐藏 (而非 disabled
                灰显)，减少 header 的视觉噪音。用户感知"还有 N 没发"的入口由文件树
                amber chip + 草稿 tab badge 共同承担 */}
            {publishableCount > 0 && (
              <button
                type="button"
                className="btn btn-sm pr-header-publish"
                onClick={() => setPublishModalOpen(true)}
                title={`批量发布 ${String(publishableCount)} 条草稿到 Bitbucket`}
              >
                提交评论 ({String(publishableCount)})
              </button>
            )}
            {/* 合并按钮：仅在服务端判定可合并 (canMerge) 时出现。放在「通过」左侧、
                review 决断区内，避免与左侧「浏览器打开」相邻造成误触。点击直接合并
                (无二次确认)；成功后 App 刷新列表，PR 转 MERGED 退场。 */}
            {pr.mergeStatus?.canMerge && (
              <button
                type="button"
                className="btn btn-sm pr-header-merge"
                onClick={onMerge}
                title="合并此 PR 到目标分支"
              >
                <PullRequestIcon size={14} /> 合并
              </button>
            )}
            {reviewAllowed('approved') && (
              <button
                className={`btn btn-sm review-action review-action-approve ${pr.localStatus === 'approved' ? 'active' : ''}`}
                type="button"
                disabled={isOwnPr}
                onClick={() =>
                  onSetStatus(pr.localStatus === 'approved' ? 'pending' : 'approved')
                }
                title={ownPrReason ?? (pr.localStatus === 'approved' ? '撤销通过' : '标记为通过')}
                aria-pressed={pr.localStatus === 'approved'}
              >
                <ApproveIcon /> 通过
              </button>
            )}
            {reviewAllowed('needsWork') && (
              <button
                className={`btn btn-sm review-action review-action-needs-work ${pr.localStatus === 'needs_work' ? 'active' : ''}`}
                type="button"
                disabled={isOwnPr}
                onClick={() =>
                  onSetStatus(pr.localStatus === 'needs_work' ? 'pending' : 'needs_work')
                }
                title={ownPrReason ?? (pr.localStatus === 'needs_work' ? '撤销"需修改"' : '标记为需修改')}
                aria-pressed={pr.localStatus === 'needs_work'}
              >
                <NeedsWorkIcon /> 需修改
              </button>
            )}
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
          变更
        </button>
        {/* comments 在 commits 前：评审决断时评论的权重大于 commit 时间线 */}
        <button
          type="button"
          className={`pr-tab ${tab === 'comments' ? 'active' : ''}`}
          onClick={() => setTab('comments')}
          role="tab"
          aria-selected={tab === 'comments'}
        >
          评论
          {commentCount !== null && commentCount > 0 && (
            <span className="pr-tab-badge" aria-label={`${String(commentCount)} 条评论`}>
              {commentCount}
            </span>
          )}
        </button>
        {/* 草稿 tab：紧贴评论 — 本地未发 vs 远端已发是互补对照。
            tab 显示条件用总数 — 全发完 (publishable=0 但有 posted 历史) 仍能进
            tab 看自己发过什么；从未创建草稿的 PR 才完全隐藏 tab，避免冗余入口 */}
        {totalDraftCount > 0 && (
          <button
            type="button"
            className={`pr-tab ${tab === 'drafts' ? 'active' : ''}`}
            onClick={() => setTab('drafts')}
            role="tab"
            aria-selected={tab === 'drafts'}
          >
            草稿
            {publishableCount > 0 && (
              <span
                className="pr-tab-badge pr-tab-badge-warning"
                aria-label={`${String(publishableCount)} 条待发布草稿`}
                title="待发布 (pending + edited)"
              >
                {publishableCount}
              </span>
            )}
          </button>
        )}
        <button
          type="button"
          className={`pr-tab ${tab === 'commits' ? 'active' : ''}`}
          onClick={() => setTab('commits')}
          role="tab"
          aria-selected={tab === 'commits'}
        >
          提交
          {commitCount !== null && commitCount > 0 && (
            <span className="pr-tab-badge" aria-label={`${String(commitCount)} 个提交`}>
              {commitCount}
            </span>
          )}
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
              className={`blame-toggle ${showWhitespace ? 'active' : ''}`}
              onClick={() => setShowWhitespace((b) => !b)}
              title={showWhitespace ? '隐藏空白字符' : '显示空白字符（空格 / Tab）'}
              aria-pressed={showWhitespace}
            >
              <WhitespaceIcon /> 空白
            </button>
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
        {tab === 'diff' && (
          <DiffView
            pr={pr}
            renderSideBySide={renderSideBySide}
            showBlame={showBlame}
            showWhitespace={showWhitespace}
            pendingNav={pendingDiffNav ?? null}
            onNavConsumed={onDiffNavConsumed}
          />
        )}
        {tab === 'comments' && (
          <CommentsPanel pr={pr} onCommentsLoaded={(n) => setCommentCount(n)} />
        )}
        {tab === 'drafts' && (
          <DraftsPanel
            pr={pr}
            onJumpToAnchor={(draftId) => {
              // 跟 PublishReviewModal 同套：查 draft 拿 anchor → 上抛 pendingDiffNav
              // → App 切到 Diff tab。不带 runId/findingId 仅 navigate 不进 edit
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
            // 点 anchor → 关 modal + 转 pendingDiffNav 上抛给 App。从本 PR 草稿池
            // 反查 draft 拿 anchor；runId/findingId 不带 → DiffView 仅 navigate
            // 不进 edit (用户想看代码上下文，不一定是要改草稿)
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
    </main>
  );
}
