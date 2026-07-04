import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import type { PrCommit, StoredPullRequest } from '@meebox/shared';
import { invoke } from '../../../../api';
import { formatBackendError, type FormattedError } from '../../../../errors';
import { Avatar } from '../../../common';
import { formatExactTime } from './comments/CommentItem';

interface CommitsPanelProps {
  pr: StoredPullRequest;
  /** Click a commit → render that commit's changes locally in the Diff tab (no longer opens browser) */
  onViewCommit?: (commit: PrCommit) => void;
}

/**
 * PR commits list, table layout. Source `diff:listCommits` (no cache, fetched once on entering the panel).
 *
 * Columns: short SHA / commit subject (first line of commit message) / author / time. Merge commits are
 * distinguished with a marker chip. Click a row → render that commit's changes locally in the Diff tab.
 *
 * List defaults to the platform's return order (newest first), matching git log convention.
 */
export function CommitsPanel({ pr, onViewCommit }: CommitsPanelProps) {
  const { t } = useTranslation();
  const [commits, setCommits] = useState<PrCommit[] | null>(null);
  const [error, setError] = useState<FormattedError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCommits(null);
    setError(null);
    void (async () => {
      try {
        const list = await invoke('diff:listCommits', { localId: pr.localId });
        if (!cancelled) setCommits(list);
      } catch (e) {
        if (!cancelled) setError(formatBackendError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pr.localId]);

  if (error) {
    return (
      <div className="pr-commits-panel">
        <div className="pr-commits-error" role="alert">
          <strong>{t('commitsPanel.loadFailed', { title: error.title })}</strong>
          <pre>{error.detail}</pre>
        </div>
      </div>
    );
  }
  if (commits === null) {
    return (
      <div className="pr-commits-panel">
        <p className="muted">{t('commitsPanel.loading')}</p>
      </div>
    );
  }
  if (commits.length === 0) {
    return (
      <div className="pr-commits-panel">
        <p className="muted">{t('commitsPanel.empty')}</p>
      </div>
    );
  }

  return (
    <div className="pr-commits-panel">
      <table className="pr-commits-table">
        <thead>
          <tr>
            <th className="pr-commits-col-sha">{t('commitsPanel.colCommit')}</th>
            <th className="pr-commits-col-subject">{t('commitsPanel.colSubject')}</th>
            <th className="pr-commits-col-author">{t('commitsPanel.colAuthor')}</th>
            <th className="pr-commits-col-time">{t('commitsPanel.colTime')}</th>
          </tr>
        </thead>
        <tbody>
          {commits.map((c) => (
            <CommitRow key={c.sha} commit={c} pr={pr} onView={onViewCommit} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CommitRow({
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
    <tr
      className={`pr-commits-row ${onView ? 'pr-commits-row-clickable' : ''}`}
      onClick={() => onView?.(commit)}
      title={commit.message /* full commit body visible on hover */}
    >
      <td className="pr-commits-col-sha">
        <code>{commit.abbreviatedSha}</code>
        {isMerge && (
          <span
            className="pr-commits-merge-tag"
            title={`merge commit (${String(commit.parents.length)} parents)`}
          >
            merge
          </span>
        )}
      </td>
      <td className="pr-commits-col-subject">{subject}</td>
      <td className="pr-commits-col-author">
        <Avatar
          connectionId={pr.connectionId}
          slug={commit.author.slug ?? commit.author.name}
          displayName={commit.author.displayName}
          avatarUrl={commit.author.avatarUrl}
          size={20}
        />
        <span>{commit.author.displayName}</span>
      </td>
      <td className="pr-commits-col-time">
        <time
          className="time-tip"
          dateTime={commit.authoredAt}
          data-tip={formatExactTime(commit.authoredAt)}
        >
          {formatCommitTime(commit.authoredAt, t)}
        </time>
      </td>
    </tr>
  );
}

function formatCommitTime(iso: string, t: TFunction): string {
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return iso;
  const diffSec = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (diffSec < 60) return t('commitsPanel.justNow');
  if (diffSec < 3600) return t('commitsPanel.minutesAgo', { count: Math.round(diffSec / 60) });
  if (diffSec < 86400) return t('commitsPanel.hoursAgo', { count: Math.round(diffSec / 3600) });
  if (diffSec < 86400 * 7) return t('commitsPanel.daysAgo', { count: Math.round(diffSec / 86400) });
  // Older than a week shows yyyy-mm-dd, avoiding the vagueness of "X weeks ago"
  const d = new Date(parsed);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
