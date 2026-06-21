// 必须在用到 @monaco-editor/react 之前执行（loader.config 指向本地 monaco）。
// 本文件经 React.lazy 动态加载，故 Monaco 随本 chunk 按需拉取，不进入口包。
import '../../../../../lib/monaco-setup';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type editor as MonacoEditor } from 'monaco-editor';
import type { PlatformCapabilities, StoredPullRequest } from '@meebox/shared';
import { useDraftsForPr } from '../../../../../stores/drafts-store';
import { ErrorBoundary, PaneLoading, FileTreeIcon, SearchIcon } from '../../../../common';
import { DiffSearchPanel } from './DiffSearchPanel';
import { FileTree } from './FileTree';
import { DiffScopeSelect } from './DiffScopeSelect';
import { DiffPane } from './DiffPane';
import { BackendErrorBanner, BackendErrorView, SyncProgress } from './DiffStatus';
import { BlameColumn } from './blame/BlameColumn';
import { fileKey, type PendingCommitView } from './diff-types';
import {
  useBlame,
  useChangedFiles,
  useCommentZones,
  useDiffComments,
  useDiffNav,
  useDiffOverviewMarks,
  useDiffScope,
  useDraftAutoEdit,
  useDraftZones,
  useFileContent,
  useFileListWidth,
  useLineCommentAdder,
  useSelectionCapture,
  useSyncProgress,
} from './hooks';

// commit「查看特定 commit」请求载荷类型（PrPanel 引用）；定义在 diff-types，此处 re-export 保持入口稳定。
export type { PendingCommitView } from './diff-types';

interface DiffViewProps {
  pr: StoredPullRequest;
  renderSideBySide: boolean;
  showBlame: boolean;
  showWhitespace: boolean;
  /** 活动连接能力位；此处用 commentHardBreaks 决定评论是否启用 remark-breaks。 */
  capabilities?: PlatformCapabilities;
  /**
   * 跳转目标：来自 ChatPane finding card → App pendingDiffNav。
   * 非 null 时 DiffView 切到该文件 + 滚到 anchor 行 + 短暂高亮 + (带 runId/findingId
   * 时) 打开 inline 草稿编辑 zone (草稿已由 ChatPane 端懒创建)。
   * runId/findingId 缺省 (PublishReviewModal anchor 点击) → 仅 navigate 不 enter edit。
   * 消费完调 onNavConsumed 清空 token
   */
  pendingNav?: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  } | null;
  onNavConsumed?: () => void;
  /**
   * 外部请求切到「查看特定 commit」视图（来自 提交 / 活动 标签页点击某 commit）。
   * 非 null 时 DiffView 把变更范围切到该 commit 的 `parent..sha`；消费完调 onCommitViewConsumed。
   */
  pendingCommitView?: PendingCommitView | null;
  onCommitViewConsumed?: () => void;
}

/**
 * PR diff 视图（组合根）：左侧文件树 / 范围选择 / 跨文件搜索，右侧 Monaco DiffEditor + blame 列 +
 * 行内评论 / 草稿 view zone。数据流（变更文件 / 内容 / 评论 / blame / 范围 / 跳转）拆到 ./hooks/*；
 * 行内 view-zone 挂载走 ./zones/mountInlineZones；行内评论渲染见 ./inline-comments/。
 */
export function DiffView({
  pr,
  renderSideBySide,
  showBlame,
  showWhitespace,
  capabilities,
  pendingNav,
  onNavConsumed,
  pendingCommitView,
  onCommitViewConsumed,
}: DiffViewProps) {
  // 评论换行策略：GitHub/Bitbucket hard-break（单 \n → <br>）；GitLab CommonMark 软换行。
  // 能力位缺省（旧数据/无连接）回退 true，保持既有行为。
  const commentHardBreaks = capabilities?.commentHardBreaks ?? true;
  const { t } = useTranslation();
  // 草稿池：跨 ChatPane / DiffView 共享 store；本组件需要它来渲染 inline zones
  const drafts = useDraftsForPr(pr.localId);
  // 用 state 而非 ref：onMount 异步触发，必须靠 state 变更触发后续 useEffect 重新运行装饰逻辑。
  const [diffEditor, setDiffEditor] = useState<MonacoEditor.IStandaloneDiffEditor | null>(null);

  const progress = useSyncProgress(pr);
  const { fileListWidth, startFileListResize } = useFileListWidth();
  const { scope, setScope, scopeCommits, loadScopeCommits, viewKey, range } = useDiffScope(
    pr,
    pendingCommitView,
    onCommitViewConsumed,
  );
  const { files, filesError, retryFiles, selectedKey, setSelectedKey, selected, loadedKey } =
    useChangedFiles(pr, range, viewKey);
  const { content, contentLoading, contentError, setContentError } = useFileContent(
    pr,
    selected,
    range,
    loadedKey,
    viewKey,
  );
  const { comments, commentsError, retryComments, setCommentsError } = useDiffComments(
    pr,
    scope.kind,
    loadedKey,
    viewKey,
  );
  const { registerEditTrigger, triggerAutoEdit } = useDraftAutoEdit(pr);
  const { blame, blameError, blameLayout, setBlameError } = useBlame(
    pr,
    selected,
    content,
    showBlame,
    range,
    loadedKey,
    viewKey,
    diffEditor,
  );
  const { setPendingScroll } = useDiffNav({
    files,
    drafts,
    diffEditor,
    content,
    selected,
    setSelectedKey,
    pendingNav,
    onNavConsumed,
    triggerAutoEdit,
  });
  // 捕获 Diff 选区 → selectionStore，供 ChatPane 把选中代码作为隐式上下文带进 agent/ask 提问。
  useSelectionCapture({ diffEditor, selected, prLocalId: pr.localId, renderSideBySide });

  // sidebar 模式：'tree' (文件树) / 'search' (跨文件搜索)，默认进文件树。PR 切换时回到 'tree'。
  const [sidebarMode, setSidebarMode] = useState<'tree' | 'search'>('tree');
  useEffect(() => {
    setSidebarMode('tree');
  }, [pr.localId]);

  // Bitbucket 评论附件 markdown 形如 `![alt](attachment:HASH)`；CommentNode 里把
  // `attachment:` 协议改写成此基址 + `/HASH`，让 <a> 能打开（点击走 Electron
  // setWindowOpenHandler 转 shell.openExternal，用户在系统浏览器看附件）。
  const attachmentBase = useMemo(() => {
    try {
      const u = new URL(pr.url);
      return `${u.protocol}//${u.host}/projects/${pr.repo.projectKey}/repos/${pr.repo.repoSlug}/attachments`;
    } catch {
      return null;
    }
  }, [pr.url, pr.repo.projectKey, pr.repo.repoSlug]);

  // 给文件树用：path → 锚到该文件的评论数（含双 path 别名 + renamed 的 oldPath）
  const commentCountByPath = useMemo(() => {
    const m = new Map<string, number>();
    if (!files) return m;
    for (const f of files) {
      const n = comments.filter(
        (c) => c.anchor && (c.anchor.path === f.path || (f.oldPath && c.anchor.path === f.oldPath)),
      ).length;
      if (n > 0) m.set(f.path, n);
    }
    return m;
  }, [files, comments]);

  // 给文件树用：path → 该文件下的待发布草稿数 (pending + edited)。
  // rejected (用户决断不发) / posted (已发，已在 comments chip 算了) 都排除。
  const draftCountByPath = useMemo(() => {
    const m = new Map<string, number>();
    if (!files || !drafts) return m;
    const publishable = drafts.filter((d) => d.status === 'pending' || d.status === 'edited');
    for (const f of files) {
      const n = publishable.filter(
        (d) => d.anchor.path === f.path || (f.oldPath && d.anchor.path === f.oldPath),
      ).length;
      if (n > 0) m.set(f.path, n);
    }
    return m;
  }, [files, drafts]);

  // diff 增/删/改投影到滚动条总览标尺左道（编辑模式风格；评论锚点走右道，见下）
  useDiffOverviewMarks({ diffEditor, content, selected, renderSideBySide });
  // 行内评论标记 + view zone
  useCommentZones({
    diffEditor,
    comments,
    content,
    selected,
    connectionId: pr.connectionId,
    attachmentBase,
    prLocalId: pr.localId,
    prWebUrl: pr.url,
    renderSideBySide,
    commentHardBreaks,
  });
  // 内联草稿 view zone（commit 只读视图不渲染）
  useDraftZones({
    diffEditor,
    drafts,
    content,
    selected,
    prLocalId: pr.localId,
    registerEditTrigger,
    renderSideBySide,
    commentHardBreaks,
    scopeKind: scope.kind,
  });
  // 行 hover '+' 新建草稿（commit 只读视图不挂）
  useLineCommentAdder({
    diffEditor,
    content,
    selected,
    drafts,
    comments,
    prLocalId: pr.localId,
    platform: pr.platform,
    scopeKind: scope.kind,
    renderSideBySide,
    triggerAutoEdit,
    t,
  });

  // 切 PR 进行中：仍渲染旧 PR 的树/内容（stale），由下方遮罩盖住，待新 files 到位再整体替换。
  const switching = files !== null && loadedKey !== viewKey;
  // 错误仅在「无可信内容可展示」时整块呈现：首载失败（无 files）或切 PR 失败（现有 files 属于旧 PR）。
  if (filesError && (!files || loadedKey !== viewKey)) {
    return (
      <BackendErrorView
        err={filesError}
        scope={t('diffView.loadChangedFilesFailed')}
        onRetry={retryFiles}
      />
    );
  }
  if (!files) {
    return (
      <div className="diff-empty">
        <SyncProgress progress={progress} />
      </div>
    );
  }
  if (files.length === 0) {
    return <div className="diff-empty">{t('diffView.noFileChanges')}</div>;
  }

  return (
    <div className="diff-view">
      {/* 切 PR 加载遮罩：盖住旧树/内容，新数据 ready（loadedKey 推进）后自动消失整体换新。
          PaneLoading 默认 delayMs=150：命中缓存的快切换遮罩不出现、直接换新（零闪）。 */}
      {switching && <PaneLoading overlay label={t('mainPane.loadingEditor')} />}
      <aside className="diff-file-list" style={{ width: `${String(fileListWidth)}px` }}>
        {/* header 一直显示。tree 模式右侧是"搜索"图标 (进搜索)；search 模式
            换"文件树"图标 (明示这是回到文件树的入口) */}
        <div className="diff-file-list-header">
          {sidebarMode === 'search' ? (
            <span>{t('diffView.searchChanges')}</span>
          ) : (
            <DiffScopeSelect
              fileCount={files.length}
              scope={scope}
              commits={scopeCommits}
              connectionId={pr.connectionId}
              onOpen={loadScopeCommits}
              onPick={setScope}
            />
          )}
          <button
            type="button"
            className="diff-file-list-search-btn"
            onClick={() => setSidebarMode((m) => (m === 'search' ? 'tree' : 'search'))}
            title={
              sidebarMode === 'search'
                ? t('diffView.backToFileTree')
                : t('diffView.searchChangesTitle')
            }
            aria-label={
              sidebarMode === 'search' ? t('diffView.backToFileTree') : t('diffView.searchAria')
            }
          >
            {sidebarMode === 'search' ? <FileTreeIcon /> : <SearchIcon />}
          </button>
        </div>
        {sidebarMode === 'tree' && (
          <FileTree
            files={files}
            selectedKey={selectedKey}
            commentCountByPath={commentCountByPath}
            draftCountByPath={draftCountByPath}
            onSelect={(f) => setSelectedKey(fileKey(f))}
          />
        )}
        {sidebarMode === 'search' && (
          <DiffSearchPanel
            files={files}
            prLocalId={pr.localId}
            onJumpToMatch={(f, line, side) => {
              setSelectedKey(fileKey(f));
              // 复用现有 pendingScroll 机制定位行 — 不带 draftId 仅 navigate
              setPendingScroll({ line, side });
            }}
            onExit={() => setSidebarMode('tree')}
          />
        )}
        <div
          className="diff-file-list-resize-handle"
          onMouseDown={startFileListResize}
          title={t('diffView.resizeFileListTitle')}
          aria-label="resize diff file list"
        />
      </aside>
      <div className="diff-content">
        {commentsError && (
          <BackendErrorBanner
            err={commentsError}
            scope={t('diffView.loadCommentsFailed')}
            onRetry={retryComments}
            onDismiss={() => setCommentsError(null)}
          />
        )}
        {contentError && (
          <BackendErrorBanner
            err={contentError}
            scope={
              selected
                ? t('diffView.readFileContentFailedNamed', { path: selected.path })
                : t('diffView.readFileContentFailed')
            }
            onDismiss={() => setContentError(null)}
          />
        )}
        {showBlame && blameError && (
          <BackendErrorBanner
            err={blameError}
            scope={
              selected
                ? t('diffView.blameFailedNamed', { path: selected.path })
                : t('diffView.blameFailed')
            }
            onDismiss={() => setBlameError(null)}
          />
        )}
        {selected && (
          <div className="diff-pane-wrapper">
            {showBlame && blame && blameLayout && diffEditor && (
              <BlameColumn
                blame={blame}
                layout={blameLayout}
                connectionId={pr.connectionId}
                diffEditor={diffEditor}
              />
            )}
            <ErrorBoundary
              label="DiffPane"
              fallback={(err, reset) => (
                <div className="diff-empty diff-error">
                  <p>{t('diffView.diffRenderFailed', { message: err.message })}</p>
                  <p className="muted" style={{ marginTop: 8 }}>
                    {t('diffView.diffRenderFailedHint')}
                  </p>
                  <button type="button" className="btn btn-sm" onClick={reset}>
                    {t('diffView.retry')}
                  </button>
                </div>
              )}
            >
              <DiffPane
                key={`${selected.path}|${selected.oldPath ?? ''}`}
                file={selected}
                content={content}
                loading={contentLoading}
                renderSideBySide={renderSideBySide}
                showBlame={showBlame}
                showWhitespace={showWhitespace}
                onMount={setDiffEditor}
              />
            </ErrorBoundary>
          </div>
        )}
      </div>
    </div>
  );
}
