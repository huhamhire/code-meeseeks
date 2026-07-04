import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  LocalPrStatus,
  PlatformCapabilities,
  PrCommentAnchor,
  PrCommit,
  ReviewRunCommitScope,
  StoredPullRequest,
} from '@meebox/shared';
import { invoke } from '../../../api';
import { useDraftsForPr } from '../../../stores/drafts-store';
import { PaneLoading } from '../../common';
import { ActivityPanel } from './tabs/activity/ActivityPanel';
import { CommitsPanel } from './tabs/CommitsPanel';
// Monaco editor (~10MB) lazy-loaded: the DiffView chunk is fetched only when actually switching to the Diff tab,
// so it doesn't block the window's first frame / PR list / first-run wizard.
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
  /** Hide PR lifecycle actions (merge / approval): always set for the closed scope (departed PRs no longer take review decisions / merges). */
  hideLifecycle?: boolean;
  /** Content read-only (declined / cannot participate): hides comment / draft and other write entries, browse-only. False for merged / still-open archived PRs. */
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
  /** External request to switch to a given tab (e.g. clicking a summary comment notification → 'activity'); cleared via onPendingTabConsumed after consumption. */
  pendingTab?: PrTab | null;
  onPendingTabConsumed?: () => void;
  /** Reports changes to the single-commit scope currently viewed in the Diff view (→ App → ChatPane implicit scope); null for all changes / root commit. */
  onViewCommitScopeChange?: (scope: ReviewRunCommitScope | null) => void;
}

/**
 * PR review workspace: header (title / actions) + tab bar + tab content (diff / comments / drafts / commits / info) +
 * publish-comments modal. Holds all PR-detail-related state (current tab / diff view options / comment + commit counts /
 * draft pool / publish modal), mounted by layout/MainPane when a PR is selected.
 */
export function PrPanel({
  pr,
  onSetStatus,
  onMerge,
  merging = false,
  capabilities,
  currentUserName,
  hideLifecycle = false,
  readOnly = false,
  pendingDiffNav,
  onDiffNavConsumed,
  onRequestDiffNav,
  pendingTab,
  onPendingTabConsumed,
  onViewCommitScopeChange,
}: PrPanelProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<PrTab>('diff');
  // Activity tab "new comment" editor toggle (triggered by the tab bar's "comment" button; the editor appears at the top of the timeline)
  const [composingComment, setComposingComment] = useState(false);
  // "View a specific commit" request: clicking a commit in the commits / activity tab → switch to Diff tab and locally render that commit's changes
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
  // On receiving a jump request → force-switch to the Diff tab; DiffView consumes the anchor itself
  useEffect(() => {
    if (pendingDiffNav) setTab('diff');
  }, [pendingDiffNav]);
  // External tab-switch request (clicking a summary comment notification → activity tab): clear the request right after switching.
  useEffect(() => {
    if (!pendingTab) return;
    setTab(pendingTab);
    onPendingTabConsumed?.();
  }, [pendingTab, onPendingTabConsumed]);
  const [renderSideBySide, setRenderSideBySide] = useState<boolean>(() => {
    const v = localStorage.getItem('meebox.diffMode');
    return v === null ? true : v === 'side-by-side';
  });
  // Blame off by default: must be turned on manually each launch (blame fetch may be slow/fail; we don't want users greeted by an error banner on entry)
  const [showBlame, setShowBlame] = useState<boolean>(false);
  // Whitespace visualization: off by default (most reviews don't care about spaces / tabs; turn on when it matters)
  const [showWhitespace, setShowWhitespace] = useState<boolean>(
    () => localStorage.getItem('meebox.showWhitespace') === '1',
  );
  useEffect(() => {
    localStorage.setItem('meebox.showWhitespace', showWhitespace ? '1' : '0');
  }, [showWhitespace]);
  // Comment / commit count chips: each fetched once on PR switch, cancelled token guards against races. deps include pr.updatedAt:
  // after a remote change the poller pulls it → store updates → this reruns to refresh counts, so counts keep up with remote changes even with the app left open.
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
          // force:true skips the cache stale comparison — the local PR.updatedAt may lag the remote (poller pulls periodically).
          invoke('diff:listComments', { localId: prLocalId, force: true }),
          invoke('diff:commitCount', { localId: prLocalId }),
        ]);
        if (cancelled) return;
        setCommentCount(cm.length);
        setCommitCount(cc?.count ?? null);
      } catch {
        // Silent: the badge shows no number, shouldn't block the user's view
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [prLocalId, prUpdatedAt]);
  useEffect(() => {
    localStorage.setItem('meebox.diffMode', renderSideBySide ? 'side-by-side' : 'unified');
  }, [renderSideBySide]);
  // Clear the legacy persisted showBlame value; the new logic no longer reads/writes it
  useEffect(() => {
    if (localStorage.getItem('meebox.showBlame') !== null) {
      localStorage.removeItem('meebox.showBlame');
    }
  }, []);

  // M4 draft pool → the N in the "publish comments (N)" button. Only pending + edited count as publishable;
  // rejected (user decided not to send) / posted (already sent remotely) are both excluded
  const drafts = useDraftsForPr(prLocalId);
  const publishableCount = useMemo(
    () =>
      (drafts ?? []).reduce(
        (n, d) => (d.status === 'pending' || d.status === 'edited' ? n + 1 : n),
        0,
      ),
    [drafts],
  );
  // The drafts tab's visibility uses the total count (any status counts); only PRs that never created a draft hide the tab entirely
  const totalDraftCount = (drafts ?? []).length;
  const [publishModalOpen, setPublishModalOpen] = useState(false);
  // Fallback: sitting on the 'drafts' tab but all drafts cleared → switch back to 'diff' to avoid showing an orphan blank content area
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
        hideLifecycle={hideLifecycle}
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
        readOnly={readOnly}
        onNewComment={() => setComposingComment(true)}
        showWhitespace={showWhitespace}
        onToggleWhitespace={() => setShowWhitespace((b) => !b)}
        showBlame={showBlame}
        onToggleBlame={() => setShowBlame((b) => !b)}
        renderSideBySide={renderSideBySide}
        onSetRenderSideBySide={setRenderSideBySide}
      />
      <div className="pr-tab-content">
        {/* keep-alive: each tab mounts only on first visit, then stays alive with only CSS show/hide (see KeepAliveTab).
            Switching away and back is instant, no refetch, embedded Monaco / scroll position / expanded state all preserved, eliminating switch jitter. */}
        <KeepAliveTab active={tab === 'diff'}>
          <Suspense fallback={<PaneLoading label={t('mainPane.loadingEditor')} />}>
            <DiffView
              pr={pr}
              renderSideBySide={renderSideBySide}
              showBlame={showBlame}
              showWhitespace={showWhitespace}
              capabilities={capabilities}
              readOnly={readOnly}
              pendingNav={pendingDiffNav ?? null}
              onNavConsumed={onDiffNavConsumed}
              pendingCommitView={pendingCommitView}
              onCommitViewConsumed={() => setPendingCommitView(null)}
              onViewCommitScopeChange={onViewCommitScopeChange}
            />
          </Suspense>
        </KeepAliveTab>
        <KeepAliveTab active={tab === 'activity'}>
          <ActivityPanel
            pr={pr}
            onCommentsLoaded={(n) => setCommentCount(n)}
            capabilities={capabilities}
            readOnly={readOnly}
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
            readOnly={readOnly}
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
            // Click anchor → close modal + turn into pendingDiffNav bubbled up to App. runId/findingId omitted →
            // DiffView only navigates, doesn't enter edit (the user wants to see the code context, not necessarily edit the draft).
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
 * Tab content keep-alive container: mounts only on first active (preserving DiffView's etc. lazy-load benefit), thereafter **never unmounts**,
 * relying only on CSS `display` to show/hide. Switching away and back is instant, no refetch, embedded Monaco / scroll position / expanded state all preserved →
 * eliminates switch jitter. While hidden the Monaco container size is 0 and reshowing needs a reflow — handled automatically by the editor-side `automaticLayout`
 * (see DiffView / InlineCodeContext).
 */
function KeepAliveTab({ active, children }: { active: boolean; children: ReactNode }) {
  // "Stay alive once active" latch: writing the ref during render is an idempotent latch, same pattern as this repo's stablePr.
  const mounted = useRef(false);
  if (active) mounted.current = true;
  if (!mounted.current) return null;
  return (
    <div className="pr-tab-pane" style={{ display: active ? undefined : 'none' }}>
      {children}
    </div>
  );
}
