import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  PlatformCapabilities,
  PrActivityEvent,
  PrActivityKind,
  PrComment,
  PrCommentAnchor,
  PrCommit,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke, subscribe } from '../../../../../api';
import { formatBackendError, type FormattedError } from '../../../../../errors';
import {
  Avatar,
  ApproveIcon,
  ChatIcon,
  CloseIcon,
  CommitIcon,
  NeedsWorkIcon,
  PaneLoading,
} from '../../../../common';
import { CommentComposer } from '../comments/CommentComposer';
import {
  CommentItem,
  formatExactTime,
  formatRelativeTime,
  sameCommentList,
} from '../comments/CommentItem';

interface ActivityPanelProps {
  pr: StoredPullRequest;
  /** 顶层评论数（不含 replies）拉取成功后回调，供父组件 tab 角标用 */
  onCommentsLoaded?: (count: number) => void;
  /** 活动连接能力位；此处用 commentHardBreaks 决定评论是否启用 remark-breaks。 */
  capabilities?: PlatformCapabilities;
  /** 内容只读（decline / 不可参与归档 PR）：隐藏评论回复 / 编辑 / 删除及新建编辑框。 */
  readOnly?: boolean;
  /** 是否展开「新建评论」编辑框（由标签栏「评论」按钮控制，出现在时间线顶部） */
  composing?: boolean;
  /** 新建评论编辑框收起（取消 / 发布成功）回调 */
  onComposeClose?: () => void;
  /** 当前 PAT 用户名（新建评论编辑框头像用） */
  currentUserName?: string | null;
  /** 点击时间线上的 commit 事件 → 在 Diff 标签页本地渲染该 commit 的变更（不再跳浏览器） */
  onViewCommit?: (commit: PrCommit) => void;
  /** 点击 inline 评论锚点 chip → 跳到 Diff 对应文件/行 */
  onJumpToAnchor?: (anchor: PrCommentAnchor) => void;
}

/** 三路数据 + 其配对 PR 一起冻结，跨 poll 稳定引用，给评论树（含内联 Monaco）稳定身份避免重渲染。 */
interface ActivityView {
  pr: StoredPullRequest;
  comments: PrComment[];
  commits: PrCommit[];
  activity: PrActivityEvent[];
}

/** 按 id 列表逐项比对（顺序敏感）。commits 用 sha、activity 用 remoteId，相等则跳过 setState 让 React bail。 */
function sameIds<T>(a: readonly T[], b: readonly T[], id: (x: T) => string): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (id(a[i]!) !== id(b[i]!)) return false;
  }
  return true;
}

/**
 * PR 活动时间线（原「评论」标签页演进而来）。把三路数据按时间归并成一条时间线：
 *   1. 评论（summary + inline，含 replies / 编辑 / 删除 / 内联代码，沿用 {@link CommentItem}）
 *   2. 提交更新（{@link PrCommit}）
 *   3. reviewer 评审决断事件（approve / needs-work / unapprove / dismiss，{@link PrActivityEvent}）
 *
 * 排序沿用评论页规则：**按时间倒序（newest first）**，最新动态在顶部。评论数据源与 DiffView 的 inline
 * 评论同一份（`diff:listComments`，main 端有 pr_updated_at 缓存）；提交 / 决断各走自己的 IPC，二者
 * 为增益信息，单独失败不影响评论时间线（catch 降级为空）。
 *
 * 切 PR 时不立刻清空（stale-while-loading）：旧时间线继续渲染、上盖 loading 遮罩，新数据 ready 后
 * 整体替换，消除「先闪加载中再渲新」的空窗。
 */
export function ActivityPanel({
  pr,
  onCommentsLoaded,
  capabilities,
  readOnly = false,
  composing = false,
  onComposeClose,
  currentUserName,
  onViewCommit,
  onJumpToAnchor,
}: ActivityPanelProps) {
  // 评论换行：GitHub/Bitbucket hard-break；GitLab CommonMark 软换行。缺省回退 true。
  const hardBreaks = capabilities?.commentHardBreaks ?? true;
  // 评论 emoji 反应：平台支持时在评论下渲染反应条 + 选择器。缺省（capabilities 未到）保守关闭。
  const reactionsEnabled = capabilities?.commentReactions ?? false;
  // 差异化：GitHub/Bitbucket 渲染评论+提交+决断的活动时间线；GitLab（activityTimeline=false）退化为
  // 纯评论视图（不拉提交/决断、沿用「评论」文案）。缺省（capabilities 未到）保守按纯评论。
  const showTimeline = capabilities?.activityTimeline ?? false;
  // 文案命名空间：时间线模式用 activityPanel.*，纯评论模式沿用 commentsPanel.*（保持 GitLab 原体验）。
  const ns = showTimeline ? 'activityPanel' : 'commentsPanel';
  const { t } = useTranslation();
  const [view, setView] = useState<ActivityView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<FormattedError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const fetchAll = async (): Promise<void> => {
      try {
        // 评论是核心（失败=整块错误）；提交 / 决断是增益，单独失败 catch 成空，时间线照常展示评论。
        // 纯评论模式（GitLab）跳过提交 / 决断拉取。
        const [comments, commits, activity] = await Promise.all([
          invoke('diff:listComments', { localId: pr.localId, force: true }),
          showTimeline
            ? invoke('diff:listCommits', { localId: pr.localId }).catch(() => [] as PrCommit[])
            : Promise.resolve([] as PrCommit[]),
          showTimeline
            ? invoke('diff:listActivity', { localId: pr.localId }).catch(
                () => [] as PrActivityEvent[],
              )
            : Promise.resolve([] as PrActivityEvent[]),
        ]);
        if (cancelled) return;
        // 三路都与上次相等：保留旧 view 引用让 React bail（poll 无实质变化时不重渲时间线）。
        setView((prev) =>
          prev &&
          prev.pr.localId === pr.localId &&
          sameCommentList(prev.comments, comments) &&
          sameIds(prev.commits, commits, (c) => c.sha) &&
          sameIds(prev.activity, activity, (a) => a.remoteId)
            ? prev
            : { pr, comments, commits, activity },
        );
        setLoading(false);
        onCommentsLoaded?.(comments.length);
      } catch (e) {
        if (!cancelled) {
          setError(formatBackendError(e));
          setLoading(false);
        }
      }
    };
    void fetchAll();
    // 用户回复 / 编辑 / 删除 / 发布草稿后 main 广播 comments:changed → 重拉
    const unsub = subscribe('comments:changed', (e) => {
      if (e.localId === pr.localId) void fetchAll();
    });
    return () => {
      cancelled = true;
      unsub();
    };
    // onCommentsLoaded 故意不放依赖：父组件每次 render 都会重传新 ref，会触发误重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pr.localId, showTimeline]);

  const viewPr = view?.pr;
  // inline 评论自动挂 Monaco 上限：按 createdAt 倒序后的前 N 条 inline 直接挂；超额走 click-to-expand。
  // 跟评论页一致取 10——一屏内大概看完，再多需主动展开。
  const autoExpandSet = useMemo(() => {
    const out = new Set<string>();
    const inlineByNewest = (view?.comments ?? [])
      .filter((c) => c.anchor)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    for (let i = 0; i < inlineByNewest.length && i < 10; i++) out.add(inlineByNewest[i]!.remoteId);
    return out;
  }, [view]);

  // 归并三路为时间线条目并按时间倒序。deps 全是稳定引用（view 经上面三路相等比对跳过后不变、
  // autoExpandSet 随 view）→ poll 无变化时整条时间线（含内联 Monaco）元素身份不变，React 跳过重渲。
  const timeline = useMemo<ReactElement[]>(() => {
    if (!viewPr || !view) return [];
    type Row = { key: string; at: number; node: ReactElement };
    const rows: Row[] = [];
    for (const c of view.comments) {
      rows.push({
        key: `comment:${c.remoteId}`,
        at: Date.parse(c.createdAt) || 0,
        node: (
          <CommentItem
            key={`comment:${c.remoteId}`}
            comment={c}
            pr={viewPr}
            depth={0}
            autoExpandCode={autoExpandSet.has(c.remoteId)}
            hardBreaks={hardBreaks}
            reactionsEnabled={reactionsEnabled}
            timeline={showTimeline}
            readOnly={readOnly}
            onJumpToAnchor={onJumpToAnchor}
          />
        ),
      });
    }
    for (const cm of view.commits) {
      rows.push({
        key: `commit:${cm.sha}`,
        at: Date.parse(cm.committedAt || cm.authoredAt) || 0,
        node: (
          <CommitEvent key={`commit:${cm.sha}`} commit={cm} pr={viewPr} onView={onViewCommit} />
        ),
      });
    }
    for (const ev of view.activity) {
      rows.push({
        key: `review:${ev.remoteId}`,
        at: Date.parse(ev.createdAt) || 0,
        node: <ReviewEvent key={`review:${ev.remoteId}`} event={ev} pr={viewPr} />,
      });
    }
    // newest first；稳定排序下同刻条目按 评论→提交→决断 入队序排列
    rows.sort((a, b) => b.at - a.at);
    return rows.map((r) => r.node);
  }, [
    view,
    viewPr,
    autoExpandSet,
    hardBreaks,
    reactionsEnabled,
    showTimeline,
    readOnly,
    onViewCommit,
    onJumpToAnchor,
  ]);

  // 首载失败 / 切 PR 失败（无可信展示内容，或现有 view 属于旧 PR）：整块错误，不拿旧 PR 内容冒充新的。
  if (error && (!view || view.pr.localId !== pr.localId)) {
    return (
      <div className="pr-comments-panel">
        <div className="pr-comments-scroll">
          <div className="pr-comments-error" role="alert">
            <strong>{t(`${ns}.loadError`, { title: error.title })}</strong>
            <pre>{error.detail}</pre>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pr-comments-panel">
      <div className="pr-comments-scroll">
        {(composing || (view && timeline.length > 0)) && (
          <ul className="pr-comments-list pr-activity-list">
            {/* 新建评论编辑框作为时间线首个节点：与其它条目同款图标节点 + 头像，编辑框缩进挂在轨上。 */}
            {composing && !readOnly && (
              <li className="pr-comment pr-comment-timeline pr-comment-depth-0">
                <div className="pr-activity-item pr-activity-comment-head">
                  <span className="pr-activity-icon pr-activity-icon-comment" aria-hidden="true">
                    <ChatIcon size={18} />
                  </span>
                  <Avatar
                    connectionId={pr.connectionId}
                    slug={currentUserName ?? ''}
                    displayName={currentUserName ?? ''}
                    size={22}
                  />
                </div>
                <div className="pr-activity-compose-card">
                  <CommentComposer
                    prLocalId={pr.localId}
                    onCancel={() => onComposeClose?.()}
                    onPosted={() => onComposeClose?.()}
                  />
                </div>
              </li>
            )}
            {view ? timeline : null}
          </ul>
        )}
        {view && timeline.length === 0 && !composing && !loading && (
          <p className="muted">{t(`${ns}.empty`)}</p>
        )}
      </div>
      {/* 加载遮罩盖住旧内容（或首载空面板），ready 后整体替换。PaneLoading 默认 delayMs=150：
          命中缓存的快切换遮罩根本不出现、旧内容直接换新（零闪）；只有慢加载才显 spinner。 */}
      {loading && <PaneLoading overlay label={t(`${ns}.loading`)} />}
    </div>
  );
}

/** 时间线上的提交事件：commit 图标 + 短 SHA + 主题 + 作者 + 时间；可点击跳远端 commit 页。 */
function CommitEvent({
  commit,
  pr,
  onView,
}: {
  commit: PrCommit;
  pr: StoredPullRequest;
  onView?: (commit: PrCommit) => void;
}) {
  const { t } = useTranslation();
  const isMerge = commit.parents.length > 1;
  const subject = commit.message.split('\n', 1)[0]!;
  return (
    <li
      className={`pr-activity-item pr-activity-commit ${onView ? 'pr-activity-clickable' : ''}`}
      onClick={() => onView?.(commit)}
      title={commit.message}
    >
      <span className="pr-activity-icon pr-activity-icon-commit" aria-hidden="true">
        <CommitIcon size={18} />
      </span>
      {/* 作者展示与评论主体人对齐：同尺寸头像 + 加粗名，不做差异化 */}
      <Avatar
        connectionId={pr.connectionId}
        slug={commit.author.slug ?? commit.author.name}
        displayName={commit.author.displayName}
        avatarUrl={commit.author.avatarUrl}
        size={22}
      />
      <div className="pr-activity-main">
        <span className="pr-activity-actor">{commit.author.displayName}</span>
        <span className="pr-activity-commit-subject">{subject}</span>
        {isMerge && (
          <span
            className="pr-activity-merge-tag"
            title={t('activityPanel.mergeCommit', { parents: commit.parents.length })}
          >
            merge
          </span>
        )}
        <code className="pr-activity-sha">{commit.abbreviatedSha}</code>
      </div>
      <time
        className="pr-activity-time muted time-tip"
        dateTime={commit.committedAt}
        data-tip={formatExactTime(commit.committedAt || commit.authoredAt)}
      >
        {formatRelativeTime(commit.committedAt || commit.authoredAt)}
      </time>
    </li>
  );
}

/** kind → 图标 + 语义色 class。approved 绿、needsWork 琥珀、unapproved/dismissed 中性。 */
const REVIEW_ICON: Record<PrActivityKind, ReactElement> = {
  approved: <ApproveIcon size={18} />,
  needsWork: <NeedsWorkIcon size={18} />,
  unapproved: <CloseIcon size={18} />,
  dismissed: <CloseIcon size={18} />,
};

/** 时间线上的评审决断事件：actor + 判定动词 + 时间。 */
function ReviewEvent({ event, pr }: { event: PrActivityEvent; pr: StoredPullRequest }) {
  const { t } = useTranslation();
  return (
    <li className={`pr-activity-item pr-activity-review pr-activity-review-${event.kind}`}>
      <span className={`pr-activity-icon pr-activity-icon-${event.kind}`} aria-hidden="true">
        {REVIEW_ICON[event.kind]}
      </span>
      <Avatar
        connectionId={pr.connectionId}
        slug={event.actor.slug ?? event.actor.name}
        displayName={event.actor.displayName}
        avatarUrl={event.actor.avatarUrl}
        size={22}
      />
      <div className="pr-activity-main">
        <span className="pr-activity-actor">{event.actor.displayName}</span>
        <span className={`pr-activity-chip pr-activity-chip-${event.kind}`}>
          {t(`activityPanel.verb.${event.kind}`)}
        </span>
      </div>
      <time
        className="pr-activity-time muted time-tip"
        dateTime={event.createdAt}
        data-tip={formatExactTime(event.createdAt)}
      >
        {formatRelativeTime(event.createdAt)}
      </time>
    </li>
  );
}
