import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createPortal } from 'react-dom';
import type { PrCommit } from '@meebox/shared';
import { Avatar, ChevronIcon, CommitIcon, PullRequestIcon } from '../../../../common';
import { formatRelativeTime } from '../comments/CommentItem';
import type { DiffScope } from './diff-types';

/**
 * Diff scope selector: file-tree header "<n> files · All changes / <commit>", click to expand a dropdown to switch the view scope.
 * Commit list is lazy-loaded (fetched only on first expand). Picking "All changes" = full PR diff; picking a commit = that
 * commit's parent..sha read-only diff.
 */
export function DiffScopeSelect({
  fileCount,
  scope,
  commits,
  connectionId,
  onOpen,
  onPick,
}: {
  fileCount: number;
  scope: DiffScope;
  commits: PrCommit[] | null;
  connectionId: string;
  onOpen: () => void;
  onPick: (scope: DiffScope) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);
  // Dropdown uses fixed positioning + portal mounted to body: otherwise it gets clipped by .diff-file-list overflow and covered by the Monaco editor on the right.
  const [menuPos, setMenuPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const computePos = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Widen the whole menu: no smaller than the trigger width, and leave enough room for the commit subject
    setMenuPos({ top: r.bottom + 2, left: r.left, width: Math.max(r.width, 440) });
  }, []);
  useEffect(() => {
    if (!open) return;
    computePos();
    const onDoc = (e: MouseEvent): void => {
      const target = e.target as Node;
      if (ref.current?.contains(target) || menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Trigger sits in the file-tree header (doesn't scroll with the file list), but recompute position on window resize / outer scroll
    const onReflow = (): void => computePos();
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, computePos]);

  const scopeLabel = scope.kind === 'all' ? t('diffView.scopeAll') : scope.abbreviatedSha;
  const toggle = (): void => {
    setOpen((o) => {
      const next = !o;
      if (next) onOpen();
      return next;
    });
  };
  return (
    <div className="diff-scope-select" ref={ref}>
      <button
        ref={triggerRef}
        type="button"
        className="diff-scope-trigger"
        onClick={toggle}
        title={scope.kind === 'commit' ? scope.subject : undefined}
        aria-expanded={open}
      >
        <span className="diff-scope-label">
          {t('diffView.fileCount', { count: fileCount })} · {scopeLabel}
        </span>
        <ChevronIcon className={open ? 'diff-scope-chevron open' : 'diff-scope-chevron'} />
      </button>
      {open &&
        menuPos &&
        createPortal(
          <ul
            ref={menuRef}
            className="diff-scope-menu"
            role="listbox"
            style={{ top: menuPos.top, left: menuPos.left, width: menuPos.width }}
          >
            {/* "All changes": title + commit-count subrow (mirrors the Bitbucket two-line layout) */}
            <li>
              <button
                type="button"
                className={`diff-scope-option ${scope.kind === 'all' ? 'active' : ''}`}
                onClick={() => {
                  onPick({ kind: 'all' });
                  setOpen(false);
                }}
              >
                <span className="diff-scope-option-icon" aria-hidden="true">
                  <PullRequestIcon size={16} />
                </span>
                <span className="diff-scope-option-body">
                  <span className="diff-scope-option-title">{t('diffView.scopeAll')}</span>
                  <span className="diff-scope-option-sub">
                    {commits === null
                      ? t('diffView.scopeLoading')
                      : t('diffView.scopeCommitCount', { count: commits.length })}
                  </span>
                </span>
              </button>
            </li>
            {/* Each commit: title (first line of message) + author / short SHA / time subrow */}
            {(commits ?? []).map((c) => {
              const subject = c.message.split('\n', 1)[0]!;
              const active = scope.kind === 'commit' && scope.sha === c.sha;
              return (
                <li key={c.sha}>
                  <button
                    type="button"
                    className={`diff-scope-option diff-scope-option-commit ${active ? 'active' : ''}`}
                    title={subject}
                    onClick={() => {
                      onPick({
                        kind: 'commit',
                        sha: c.sha,
                        parent: c.parents[0] ?? null,
                        abbreviatedSha: c.abbreviatedSha,
                        subject,
                      });
                      setOpen(false);
                    }}
                  >
                    <span className="diff-scope-option-icon" aria-hidden="true">
                      <CommitIcon size={16} />
                    </span>
                    <span className="diff-scope-option-body">
                      <span className="diff-scope-option-title">{subject}</span>
                      <span className="diff-scope-option-sub">
                        <Avatar
                          connectionId={connectionId}
                          slug={c.author.slug ?? c.author.name}
                          displayName={c.author.displayName}
                          avatarUrl={c.author.avatarUrl}
                          size={16}
                        />
                        <span className="diff-scope-author">{c.author.displayName}</span>
                        <code className="diff-scope-sha">{c.abbreviatedSha}</code>
                        <time className="diff-scope-time">
                          {formatRelativeTime(c.committedAt || c.authoredAt)}
                        </time>
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>,
          document.body,
        )}
    </div>
  );
}
