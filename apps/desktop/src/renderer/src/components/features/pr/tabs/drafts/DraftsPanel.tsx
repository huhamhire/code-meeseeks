import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import type { PlatformCapabilities, ReviewDraft, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { formatBackendError } from '../../../../../errors';
import { useDraftsForPr } from '../../../../../stores/drafts-store';
import { ConfirmModal } from '../../../../common';

// posted no longer exists (successful publish deletes the local draft), filters keep only publishable / all / rejected
type Filter = 'all' | 'publishable' | 'rejected';

interface DraftsPanelProps {
  pr: StoredPullRequest;
  /** Click anchor to jump to Diff view. Parent wires to pendingDiffNav (goes through App top level) */
  onJumpToAnchor?: (draftId: string) => void;
  /** Active connection capability bits; here commentHardBreaks decides whether the draft preview enables remark-breaks. */
  capabilities?: PlatformCapabilities;
  /** Content read-only (decline / archived PR that can't be participated in): hides draft publish / delete actions, browse only. */
  readOnly?: boolean;
}

/**
 * Draft management panel (M4). Same tab level as CommentsPanel, aligned visual weight — one views
 * remote published comments, the other views local unpublished drafts, complementary.
 *
 * Relationship with DiffView's embedded DraftZone / PublishReviewModal:
 * - DraftZone: inline in-place editing, the main path of "see the code + edit"
 * - PublishReviewModal: one-shot "batch publish" entry, select-all default + publish action flow
 * - DraftsPanel: persistent "draft overview", browse across files + across status / single-item actions
 *
 * status filter defaults to "to-publish" — users care most about the not-yet-published batch; switching the filter to "published"
 * lets you inspect this PR's own published comment history, "rejected" can be restored (M4 has no unreject UI yet)
 */
export function DraftsPanel({ pr, onJumpToAnchor, capabilities, readOnly = false }: DraftsPanelProps) {
  // Draft preview line breaks: GitHub/Bitbucket hard-break; GitLab CommonMark soft break. Fallback true by default.
  const hardBreaks = capabilities?.commentHardBreaks ?? true;
  const { t } = useTranslation();
  const drafts = useDraftsForPr(pr.localId);
  const [filter, setFilter] = useState<Filter>('publishable');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  // Multiple drafts may be publishing at once; use a Set to track concurrent draftIds for per-item disable / label
  const [publishingIds, setPublishingIds] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, publishable: 0, rejected: 0 };
    for (const d of drafts ?? []) {
      c.all++;
      if (d.status === 'pending' || d.status === 'edited') c.publishable++;
      else if (d.status === 'rejected') c.rejected++;
    }
    return c;
  }, [drafts]);

  const filtered = useMemo<ReviewDraft[]>(() => {
    const list = drafts ?? [];
    // Sort: within the same file by startLine ascending (matching top-to-bottom code reading order); across files by
    // path lexicographic order (aligned with file-tree order, so scanning doesn't jump around)
    const sorted = list.slice().sort((a, b) => {
      // Reply-drafts may have no anchor (reply to a summary comment); fall back to empty path / line 0 so they sort stably first.
      const pathA = a.anchor?.path ?? '';
      const pathB = b.anchor?.path ?? '';
      return pathA === pathB
        ? (a.anchor?.startLine ?? 0) - (b.anchor?.startLine ?? 0)
        : pathA.localeCompare(pathB);
    });
    if (filter === 'all') return sorted;
    if (filter === 'publishable')
      return sorted.filter((d) => d.status === 'pending' || d.status === 'edited');
    return sorted.filter((d) => d.status === filter);
  }, [drafts, filter]);

  const setError = (draftId: string, msg: string | null): void => {
    setErrors((prev) => {
      const next = new Map(prev);
      if (msg === null) next.delete(draftId);
      else next.set(draftId, msg);
      return next;
    });
  };
  const markPublishing = (draftId: string, on: boolean): void => {
    setPublishingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(draftId);
      else next.delete(draftId);
      return next;
    });
  };

  const handlePublish = async (draftId: string): Promise<void> => {
    if (publishingIds.has(draftId)) return;
    setError(draftId, null);
    markPublishing(draftId, true);
    try {
      const resp = await invoke('drafts:publishBatch', {
        localId: pr.localId,
        draftIds: [draftId],
      });
      const r = resp.results[0];
      if (!r || !r.ok) {
        setError(
          draftId,
          r?.error ? formatBackendError(r.error).title : t('draftsPanel.publishFailed'),
        );
      }
      // Success → main side deletes the local draft directly (no posted history kept), broadcastDraftsChanged
      // makes this panel re-fetch, and the deleted item disappears from the list. The remote comment is pulled
      // back by force-refresh comments, viewable in CommentsPanel / DiffView CommentZone
    } catch (e) {
      setError(draftId, e instanceof Error ? e.message : String(e));
    } finally {
      markPublishing(draftId, false);
    }
  };

  const handleDelete = async (draftId: string): Promise<void> => {
    await invoke('drafts:delete', { localId: pr.localId, draftId });
    setConfirmDelete(null);
  };

  // Draft pool is hydrating (first entering the PR) → placeholder; only an empty array after fetch shows "no drafts".
  // The empty state is also wrapped in .drafts-panel so flex:1 fills horizontally, rather than becoming a "shrink-to-content" small box
  if (drafts === null) {
    return (
      <div className="drafts-panel">
        <div className="drafts-panel-empty muted">{t('draftsPanel.loading')}</div>
      </div>
    );
  }
  if (drafts.length === 0) {
    return (
      <div className="drafts-panel">
        <div className="drafts-panel-empty muted">{t('draftsPanel.emptyHint')}</div>
      </div>
    );
  }

  return (
    <div className="drafts-panel">
      <nav className="drafts-panel-filter" role="tablist" aria-label={t('draftsPanel.filterAria')}>
        {(['publishable', 'all', 'rejected'] as const).map((f) => (
          <button
            key={f}
            type="button"
            className={`drafts-panel-filter-btn${filter === f ? ' active' : ''}`}
            onClick={() => setFilter(f)}
            role="tab"
            aria-selected={filter === f}
          >
            {t(FILTER_LABEL_KEY[f])}
            {counts[f] > 0 && <span className="drafts-panel-filter-badge">{counts[f]}</span>}
          </button>
        ))}
      </nav>
      {filtered.length === 0 ? (
        <div className="drafts-panel-empty muted">{t('draftsPanel.emptyFiltered')}</div>
      ) : (
        <ul className="drafts-panel-list">
          {filtered.map((d) => {
            const anchor = d.anchor;
            const isReply = d.kind === 'reply';
            const lineLabel = anchor
              ? anchor.endLine !== anchor.startLine
                ? `${String(anchor.startLine)}-${String(anchor.endLine)}`
                : String(anchor.startLine)
              : '';
            const sideLabel = anchor
              ? anchor.side === 'old'
                ? t('draftsPanel.sideOld')
                : t('draftsPanel.sideNew')
              : '';
            const publishable = d.status === 'pending' || d.status === 'edited';
            const pubErr = errors.get(d.id);
            const isPublishing = publishingIds.has(d.id);
            return (
              <li key={d.id} className={`drafts-panel-item drafts-panel-item-${d.status}`}>
                <div className="drafts-panel-item-head">
                  {/* Reply-drafts carry a small "reply" tag; when anchored to an inline comment they still show the
                      parent's file:line (jump lands on the parent's line), otherwise (reply to a summary comment) just the tag. */}
                  {isReply && (
                    <span className="drafts-panel-item-reply-tag">{t('draftsPanel.replyTag')}</span>
                  )}
                  {anchor ? (
                    onJumpToAnchor ? (
                      <button
                        type="button"
                        className="drafts-panel-item-anchor drafts-panel-item-anchor-link"
                        onClick={() => onJumpToAnchor(d.id)}
                        title={t('draftsPanel.jumpToDiffTitle')}
                      >
                        {anchor.path}:{lineLabel}
                        <span className="muted"> · {sideLabel}</span>
                      </button>
                    ) : (
                      <code className="drafts-panel-item-anchor">
                        {anchor.path}:{lineLabel}
                        <span className="muted"> · {sideLabel}</span>
                      </code>
                    )
                  ) : (
                    <span className="drafts-panel-item-anchor muted">
                      {t('draftsPanel.replyToComment')}
                    </span>
                  )}
                  <span className={`drafts-panel-item-status status-${d.status}`}>
                    {t(STATUS_LABEL_KEY[d.status])}
                  </span>
                  <span className="drafts-panel-item-origin muted">
                    {d.origin === 'finding'
                      ? t('draftsPanel.originFinding')
                      : t('draftsPanel.originMine')}
                  </span>
                  <div className="drafts-panel-item-actions">
                    {!readOnly && publishable && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        onClick={() => void handlePublish(d.id)}
                        disabled={isPublishing || !d.body.trim()}
                        title={
                          !d.body.trim()
                            ? t('draftsPanel.publishEmptyTitle')
                            : t('draftsPanel.publishOneTitle')
                        }
                      >
                        {isPublishing ? t('draftsPanel.publishing') : t('draftsPanel.publish')}
                      </button>
                    )}
                    {!readOnly && d.status !== 'posted' && (
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setConfirmDelete(d.id)}
                        disabled={isPublishing}
                        title={t('draftsPanel.deleteTitle')}
                      >
                        {t('common.delete')}
                      </button>
                    )}
                    {d.posted_remote_id && (
                      <span className="drafts-panel-item-remote muted">
                        {t('draftsPanel.remoteId', { id: d.posted_remote_id })}
                      </span>
                    )}
                  </div>
                </div>
                <div className="drafts-panel-item-body markdown">
                  {d.body.trim() ? (
                    <ReactMarkdown
                      remarkPlugins={hardBreaks ? [remarkGfm, remarkBreaks] : [remarkGfm]}
                    >
                      {d.body}
                    </ReactMarkdown>
                  ) : (
                    <span className="muted">{t('draftsPanel.emptyDraft')}</span>
                  )}
                </div>
                {pubErr && (
                  <div className="drafts-panel-item-error" role="alert">
                    {t('draftsPanel.publishErrorPrefix', { error: pubErr })}
                    <button
                      type="button"
                      className="drafts-panel-item-error-dismiss"
                      onClick={() => setError(d.id, null)}
                      aria-label={t('draftsPanel.dismissErrorAria')}
                      title={t('draftsPanel.gotIt')}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {confirmDelete && (
        <ConfirmModal
          title={t('draftsPanel.deleteConfirmTitle')}
          message={t('draftsPanel.deleteConfirmMessage')}
          confirmLabel={t('common.delete')}
          cancelLabel={t('common.cancel')}
          danger
          onConfirm={() => void handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

// Status/filter → i18n key mapping (actual text is resolved with t() inside the component, keeping the module-level table stable)
const FILTER_LABEL_KEY: Record<Filter, string> = {
  publishable: 'draftsPanel.filterPublishable',
  all: 'draftsPanel.filterAll',
  rejected: 'draftsPanel.filterRejected',
};

const STATUS_LABEL_KEY: Record<ReviewDraft['status'], string> = {
  pending: 'draftsPanel.statusPending',
  edited: 'draftsPanel.statusEdited',
  posted: 'draftsPanel.statusPosted',
  rejected: 'draftsPanel.statusRejected',
};
