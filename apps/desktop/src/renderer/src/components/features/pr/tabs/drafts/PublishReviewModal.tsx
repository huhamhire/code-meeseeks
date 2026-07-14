import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ReviewDraft } from '@meebox/shared';
import { invoke } from '../../../../../api';
import { formatBackendError } from '../../../../../errors';

/**
 * Confirmation modal for batch-publishing drafts to Bitbucket. The last mile of the M4 publish loop.
 *
 * Flow:
 *   1. confirm: list all publishable drafts of this PR (pending + edited), user can check / uncheck
 *   2. publishing: call drafts:publishBatch, main side serially POSTs to Bitbucket
 *   3. done: show N succeeded / M failed + per-failure details
 *
 * - rejected drafts are not in the list (user decided not to publish)
 * - posted drafts are not in the list (already on remote, avoid duplicates)
 * - all checked by default — entering the modal already expresses the intent "want to publish comments", select-all fits most cases;
 *   uncheck individual ones you don't want to publish
 */
type Phase = 'confirm' | 'publishing' | 'done';

interface PublishResult {
  draftId: string;
  ok: boolean;
  postedRemoteId?: string;
  error?: string;
}

export function PublishReviewModal({
  localId,
  drafts,
  onClose,
  onJumpToAnchor,
}: {
  localId: string;
  /** All drafts of this PR; the modal itself filters out publishable ones (pending + edited) */
  drafts: ReadonlyArray<ReviewDraft>;
  onClose: () => void;
  /**
   * Called when the user clicks an anchor (path:line). Parent typically implements: close the modal + trigger Diff
   * jump to that draft's position (reusing the pendingDiffNav link). Absent means the anchor is not clickable
   */
  onJumpToAnchor?: (draftId: string) => void;
}) {
  const { t } = useTranslation();
  // List snapshot: fixed on entering the modal, to avoid drafts changes (edits from other windows) washing out the current selection
  const candidates = useMemo<ReviewDraft[]>(
    () => drafts.filter((d) => d.status === 'pending' || d.status === 'edited'),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const [selected, setSelected] = useState<Set<string>>(() => new Set(candidates.map((d) => d.id)));
  const [phase, setPhase] = useState<Phase>('confirm');
  const [results, setResults] = useState<PublishResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Esc to close (disabled during publishing phase to avoid accidental interruption; allowed in done phase)
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && phase !== 'publishing') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const toggleAll = (): void => {
    setSelected((prev) =>
      prev.size === candidates.length ? new Set() : new Set(candidates.map((d) => d.id)),
    );
  };

  const handlePublish = async (): Promise<void> => {
    if (selected.size === 0) return;
    setError(null);
    setPhase('publishing');
    try {
      const resp = await invoke('drafts:publishBatch', {
        localId,
        draftIds: Array.from(selected),
      });
      setResults(resp.results);
      setPhase('done');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('confirm');
    }
  };

  const okCount = results.filter((r) => r.ok).length;
  const failCount = results.length - okCount;

  // On entry this PR has no publishable drafts → show the empty state directly (in theory the header button is disabled
  // so it won't trigger opening the modal, but kept as a fallback)
  if (candidates.length === 0) {
    return (
      <div className="modal-backdrop" onClick={onClose}>
        <div className="modal publish-review-modal" onClick={(e) => e.stopPropagation()}>
          <header className="publish-review-head">
            <h3>{t('publishReviewModal.title')}</h3>
          </header>
          <div className="publish-review-body">
            <p className="muted">{t('publishReviewModal.emptyState')}</p>
          </div>
          <footer className="modal-actions">
            <button type="button" className="btn btn-sm" onClick={onClose}>
              {t('common.close')}
            </button>
          </footer>
        </div>
      </div>
    );
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal publish-review-modal" onClick={(e) => e.stopPropagation()}>
        <header className="publish-review-head">
          <h3>
            {phase === 'done'
              ? t('publishReviewModal.headDone')
              : phase === 'publishing'
                ? t('publishReviewModal.headPublishing')
                : t('publishReviewModal.headConfirm', {
                    selected: selected.size,
                    total: candidates.length,
                  })}
          </h3>
        </header>

        {phase === 'confirm' && (
          <>
            <div className="publish-review-body">
              <div className="publish-review-toolbar">
                <button type="button" className="btn-link" onClick={toggleAll}>
                  {selected.size === candidates.length
                    ? t('publishReviewModal.deselectAll')
                    : t('publishReviewModal.selectAll')}
                </button>
                <span className="muted">
                  {t('publishReviewModal.countSummary', {
                    total: candidates.length,
                    selected: selected.size,
                  })}
                </span>
              </div>
              <ul className="publish-review-list">
                {candidates.map((d) => {
                  const anchor = d.anchor;
                  const isReply = d.kind === 'reply';
                  const lineLabel = anchor
                    ? anchor.endLine !== anchor.startLine
                      ? `${String(anchor.startLine)}-${String(anchor.endLine)}`
                      : String(anchor.startLine)
                    : '';
                  const sideLabel = anchor
                    ? anchor.side === 'old'
                      ? t('publishReviewModal.sideOld')
                      : t('publishReviewModal.sideNew')
                    : '';
                  return (
                    <li key={d.id} className="publish-review-item">
                      <label>
                        <input
                          type="checkbox"
                          checked={selected.has(d.id)}
                          onChange={() => toggle(d.id)}
                        />
                        <div className="publish-review-item-meta">
                          {/* Reply-drafts carry a "reply" tag; anchored ones still show file:line (jump lands on the parent's line). */}
                          {isReply && (
                            <span className="publish-review-item-reply-tag">
                              {t('publishReviewModal.replyTag')}
                            </span>
                          )}
                          {/* anchor is clickable → close modal + jump to Diff; the checkbox label is outer,
                              stopPropagation here prevents the click from triggering a check toggle */}
                          {!anchor ? (
                            <span className="publish-review-item-anchor muted">
                              {t('publishReviewModal.replyToComment')}
                            </span>
                          ) : onJumpToAnchor ? (
                            <button
                              type="button"
                              className="publish-review-item-anchor publish-review-item-anchor-link"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                onJumpToAnchor(d.id);
                              }}
                              title={t('publishReviewModal.jumpToDiffTitle')}
                            >
                              {anchor.path}:{lineLabel}
                              <span className="muted"> · {sideLabel}</span>
                            </button>
                          ) : (
                            <code className="publish-review-item-anchor">
                              {anchor.path}:{lineLabel}
                              <span className="muted"> · {sideLabel}</span>
                            </code>
                          )}
                          <span className={`publish-review-item-status status-${d.status}`}>
                            {d.status === 'pending'
                              ? t('publishReviewModal.statusPending')
                              : t('publishReviewModal.statusEdited')}
                          </span>
                        </div>
                      </label>
                      <pre className="publish-review-item-body">{d.body}</pre>
                    </li>
                  );
                })}
              </ul>
              {error && <div className="publish-review-error">{error}</div>}
            </div>
            <footer className="modal-actions">
              <button type="button" className="btn btn-sm" onClick={onClose}>
                {t('common.cancel')}
              </button>
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={selected.size === 0}
                onClick={() => void handlePublish()}
                title={
                  selected.size === 0
                    ? t('publishReviewModal.publishDisabledTitle')
                    : t('publishReviewModal.publishTitle')
                }
              >
                {t('publishReviewModal.publishBtn', { n: selected.size })}
              </button>
            </footer>
          </>
        )}

        {phase === 'publishing' && (
          <div className="publish-review-body publish-review-publishing">
            <div className="publish-review-spinner" aria-hidden="true" />
            <p>{t('publishReviewModal.publishingMessage', { n: selected.size })}</p>
            <p className="muted">{t('publishReviewModal.doNotClose')}</p>
          </div>
        )}

        {phase === 'done' && (
          <>
            <div className="publish-review-body">
              <div className="publish-review-summary">
                <span className="publish-review-summary-ok">
                  {t('publishReviewModal.summaryOk', { n: okCount })}
                </span>
                {failCount > 0 && (
                  <span className="publish-review-summary-fail">
                    {t('publishReviewModal.summaryFail', { n: failCount })}
                  </span>
                )}
              </div>
              {failCount > 0 && (
                <ul className="publish-review-failures">
                  {results
                    .filter((r) => !r.ok)
                    .map((r) => {
                      const d = candidates.find((c) => c.id === r.draftId);
                      return (
                        <li key={r.draftId}>
                          <code>
                            {d?.anchor ? `${d.anchor.path}:${d.anchor.startLine}` : r.draftId}
                          </code>
                          <span className="publish-review-failure-msg">
                            {' '}
                            — {r.error && formatBackendError(r.error).title}
                          </span>
                        </li>
                      );
                    })}
                </ul>
              )}
              {failCount === 0 && <p className="muted">{t('publishReviewModal.allPublished')}</p>}
            </div>
            <footer className="modal-actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={onClose}>
                {t('common.close')}
              </button>
            </footer>
          </>
        )}
      </div>
    </div>
  );
}
