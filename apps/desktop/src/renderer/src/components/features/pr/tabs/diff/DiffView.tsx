// Must run before @monaco-editor/react is used (loader.config points to the local monaco).
// This file is dynamically loaded via React.lazy, so Monaco is fetched on demand with this chunk and stays out of the entry bundle.
import '../../../../../lib/monaco-setup';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { type editor as MonacoEditor } from 'monaco-editor';
import type {
  PlatformCapabilities,
  ReviewRunCommitScope,
  StoredPullRequest,
} from '@meebox/shared';
import { useDraftsForPr } from '../../../../../stores/drafts-store';
import { ErrorBoundary, PaneLoading, FileTreeIcon, SearchIcon } from '../../../../common';
import { collectMentionCandidates } from '../shared/mentionCandidates';
import { DiffSearchPanel } from './DiffSearchPanel';
import { FileTree } from './FileTree';
import { DiffScopeSelect } from './DiffScopeSelect';
import { DiffPane } from './DiffPane';
import { FileCommentStrip } from './FileCommentStrip';
import { BackendErrorBanner, BackendErrorView, SyncProgress } from './DiffStatus';
import { BlameColumn } from './blame/BlameColumn';
import { fileKey, type PendingCommitView } from './diff-types';
import {
  useBlame,
  useChangedFiles,
  useCommentZones,
  useConflictFiles,
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

// Payload type for the "view specific commit" request (referenced by PrPanel); defined in diff-types, re-exported here to keep the entry stable.
export type { PendingCommitView } from './diff-types';

interface DiffViewProps {
  pr: StoredPullRequest;
  renderSideBySide: boolean;
  showBlame: boolean;
  showWhitespace: boolean;
  /** Active connection capability bits; here commentHardBreaks decides whether comments enable remark-breaks. */
  capabilities?: PlatformCapabilities;
  /** Content read-only (declined / non-participatable archived PR): don't mount the inline "+" new-comment affordance, hide reply / edit / delete on inline comments. */
  readOnly?: boolean;
  /**
   * Navigation target: from a ChatPane finding card → App pendingDiffNav.
   * When non-null, DiffView switches to that file + scrolls to the anchor line + briefly highlights + (when runId/findingId
   * are present) opens the inline draft edit zone (the draft is already lazily created on the ChatPane side).
   * When runId/findingId are absent (PublishReviewModal anchor click) → navigate only, don't enter edit.
   * Once consumed, call onNavConsumed to clear the token
   */
  pendingNav?: {
    runId?: string;
    findingId?: string;
    anchor: { path: string; startLine: number; endLine: number };
  } | null;
  onNavConsumed?: () => void;
  /**
   * External request to switch to the "view specific commit" view (from clicking a commit on the Commits / Activity tab).
   * When non-null, DiffView switches the scope to that commit's `parent..sha`; once consumed, calls onCommitViewConsumed.
   */
  pendingCommitView?: PendingCommitView | null;
  onCommitViewConsumed?: () => void;
  /**
   * Reported when the current scope switches to / leaves a single commit (commit has a parent → pass that commit's scope, all changes / root commit → null).
   * The parent (App) uses this to treat the "currently viewed commit" as the implicit scope for chat-pane commands (see ChatPane viewCommitScope).
   */
  onViewCommitScopeChange?: (scope: ReviewRunCommitScope | null) => void;
}

/**
 * PR diff view (composition root): file tree / scope select / cross-file search on the left, Monaco DiffEditor + blame column +
 * inline comment / draft view zones on the right. Data flow (changed files / content / comments / blame / scope / navigation) is split into ./hooks/*;
 * inline view-zone mounting goes through ./zones/mountInlineZones; inline comment rendering is in ./inline-comments/.
 */
export function DiffView({
  pr,
  renderSideBySide,
  showBlame,
  showWhitespace,
  capabilities,
  readOnly = false,
  pendingNav,
  onNavConsumed,
  pendingCommitView,
  onCommitViewConsumed,
  onViewCommitScopeChange,
}: DiffViewProps) {
  // Comment line-break policy: GitHub/Bitbucket hard-break (single \n → <br>); GitLab CommonMark soft-wrap.
  // When the capability bit is absent (old data / no connection), fall back to true to preserve existing behavior.
  const commentHardBreaks = capabilities?.commentHardBreaks ?? true;
  // Inline comment emoji reaction / image attachment capabilities (same capability bits as the comments / activity tab): absent = unsupported (don't render the add-reaction button / don't enable paste upload).
  const reactionsMode = capabilities?.commentReactions || undefined;
  const attachmentsEnabled = capabilities?.commentAttachments ?? false;
  // Remote @mention user search: enables the draft editor's remote fallback (search users beyond this PR's participants) when the platform supports it.
  const userSearchEnabled = capabilities?.userSearch ?? false;
  const { t } = useTranslation();
  // Draft pool: store shared across ChatPane / DiffView; this component needs it to render inline zones
  const drafts = useDraftsForPr(pr.localId);
  // Use state, not a ref: onMount fires asynchronously, so a state change is required to re-run the subsequent useEffect decoration logic.
  const [diffEditor, setDiffEditor] = useState<MonacoEditor.IStandaloneDiffEditor | null>(null);

  const progress = useSyncProgress(pr);
  const { fileListWidth, startFileListResize } = useFileListWidth();
  const { scope, setScope, scopeCommits, loadScopeCommits, viewKey, range } = useDiffScope(
    pr,
    pendingCommitView,
    onCommitViewConsumed,
  );
  // Report the "currently viewed single commit" to the parent as the implicit scope for chat-pane commands. Only a commit with a parent can be bounded as parent..sha;
  // all changes / root commit (no parent) reports null.
  useEffect(() => {
    if (!onViewCommitScopeChange) return;
    onViewCommitScopeChange(
      scope.kind === 'commit' && scope.parent
        ? {
            sha: scope.sha,
            parent: scope.parent,
            abbreviatedSha: scope.abbreviatedSha,
            subject: scope.subject,
          }
        : null,
    );
  }, [scope, onViewCommitScopeChange]);
  const { files, filesError, retryFiles, selectedKey, setSelectedKey, selected, loadedKey } =
    useChangedFiles(pr, range, viewKey);
  // Set of file paths that would conflict on merge (only fetched when pr.hasConflict), the file tree marks a triangle warning based on this.
  const conflictPaths = useConflictFiles(pr);
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
  // Capture the Diff selection → selectionStore, so ChatPane can carry the selected code as implicit context into agent/ask questions.
  useSelectionCapture({ diffEditor, selected, prLocalId: pr.localId, renderSideBySide });

  // sidebar mode: 'tree' (file tree) / 'search' (cross-file search), defaults to the file tree. Returns to 'tree' on PR switch.
  const [sidebarMode, setSidebarMode] = useState<'tree' | 'search'>('tree');
  useEffect(() => {
    setSidebarMode('tree');
  }, [pr.localId]);

  // Bitbucket comment attachment markdown looks like `![alt](attachment:HASH)`; CommentNode rewrites
  // the `attachment:` protocol to this base + `/HASH` so the <a> can open (clicking goes through Electron's
  // setWindowOpenHandler to shell.openExternal, and the user views the attachment in the system browser).
  const attachmentBase = useMemo(() => {
    try {
      const u = new URL(pr.url);
      return `${u.protocol}//${u.host}/projects/${pr.repo.projectKey}/repos/${pr.repo.repoSlug}/attachments`;
    } catch {
      return null;
    }
  }, [pr.url, pr.repo.projectKey, pr.repo.repoSlug]);

  // @mention candidates for inline draft editing: same bounded/safe source as the activity composer — loaded comment
  // authors (incl. replies) seeded with the PR author (who may not have commented). No extra fetches; the user can still type any @name.
  const mentionCandidates = useMemo(
    () => collectMentionCandidates(comments, [], [pr.author]),
    [comments, pr.author],
  );

  // For the file tree: path → number of comments anchored to that file (including dual-path aliases + renamed oldPath)
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

  // For the file tree: path → number of unpublished drafts under that file (pending + edited).
  // Both rejected (user decided not to post) and posted (already posted, already counted in the comments chip) are excluded.
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

  // diff add/delete/modify projected onto the left lane of the scrollbar overview ruler (edit-mode style; comment anchors take the right lane, see below)
  useDiffOverviewMarks({ diffEditor, content, selected, renderSideBySide });
  // Inline comment marks + view zone
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
    reactionsMode,
    attachmentsEnabled,
    mentionCandidates,
    platform: pr.platform,
    userSearchEnabled,
    readOnly,
  });
  // Inline draft view zone (not rendered in the commit read-only view)
  useDraftZones({
    diffEditor,
    drafts,
    content,
    selected,
    prLocalId: pr.localId,
    registerEditTrigger,
    renderSideBySide,
    commentHardBreaks,
    attachmentsEnabled,
    mentionCandidates,
    platform: pr.platform,
    userSearchEnabled,
    scopeKind: scope.kind,
  });
  // Line hover '+' to create a new draft (not mounted in the commit read-only view)
  useLineCommentAdder({
    diffEditor,
    content,
    selected,
    drafts,
    prLocalId: pr.localId,
    platform: pr.platform,
    scopeKind: scope.kind,
    renderSideBySide,
    readOnly,
    triggerAutoEdit,
    t,
  });

  // PR switch in progress: still render the old PR's tree/content (stale), covered by the overlay below, replaced wholesale once the new files arrive.
  const switching = files !== null && loadedKey !== viewKey;
  // The error is shown as a full block only when "there's no trustworthy content to display": initial load failed (no files) or PR switch failed (existing files belong to the old PR).
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
      {/* PR-switch loading overlay: covers the old tree/content, disappears automatically and swaps in the new one once the new data is ready (loadedKey advances).
          PaneLoading defaults to delayMs=150: cache-hit fast switches don't show the overlay and swap directly (zero flash). */}
      {switching && <PaneLoading overlay label={t('mainPane.loadingEditor')} />}
      <aside className="diff-file-list" style={{ width: `${String(fileListWidth)}px` }}>
        {/* header is always shown. In tree mode the right side is the "search" icon (enter search); in search mode
            it becomes the "file tree" icon (making clear this is the entry back to the file tree) */}
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
            conflictPaths={conflictPaths}
            onSelect={(f) => setSelectedKey(fileKey(f))}
          />
        )}
        {sidebarMode === 'search' && (
          <DiffSearchPanel
            files={files}
            prLocalId={pr.localId}
            onJumpToMatch={(f, line, side) => {
              setSelectedKey(fileKey(f));
              // Reuse the existing pendingScroll mechanism to locate the line — no draftId, navigate only
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
          <FileCommentStrip
            pr={pr}
            path={selected.path}
            oldPath={selected.oldPath}
            comments={comments}
            capabilities={capabilities}
            hardBreaks={commentHardBreaks}
            reactionsMode={reactionsMode}
            mentionCandidates={mentionCandidates}
            attachmentsEnabled={attachmentsEnabled}
            userSearchEnabled={userSearchEnabled}
            readOnly={readOnly}
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
